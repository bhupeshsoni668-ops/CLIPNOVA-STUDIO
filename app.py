import os, re, json, uuid, shutil, subprocess, tempfile
from pathlib import Path
from typing import Optional
import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

app = FastAPI(title="CLIPNOVA AI API", version="1.0.0")
# For production, replace "*" with your exact GitHub Pages origin.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
MAX_BYTES = 500 * 1024 * 1024
MAX_DURATION = 2 * 60 * 60
TEMP_ROOT = Path(tempfile.gettempdir()) / "clipnova"
TEMP_ROOT.mkdir(exist_ok=True)

def run(cmd, timeout=3600):
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Processing timed out on the free CPU backend.")
    if p.returncode != 0:
        detail = p.stderr.decode("utf-8", "ignore")[-1800:]
        raise HTTPException(500, "FFmpeg/analysis error: " + detail)
    return p.stdout

def probe(path):
    raw = run(["ffprobe","-v","error","-show_entries","format=duration:stream=codec_type,width,height,r_frame_rate","-of","json",str(path)], timeout=60)
    data=json.loads(raw)
    duration=float(data.get("format",{}).get("duration",0))
    if duration <= 0: raise HTTPException(400,"Could not read video duration.")
    if duration < 60: raise HTTPException(400,"Video must be at least 1 minute long.")
    if duration > MAX_DURATION: raise HTTPException(413,"This free starter accepts videos up to 2 hours. 30-hour uploads require chunked cloud storage and a persistent worker.")
    return duration, data.get("streams",[])

async def save_upload(upload: UploadFile, folder: Path):
    name = Path(upload.filename or "gameplay.mp4").name
    ext = Path(name).suffix.lower()
    if ext not in {".mp4",".mov",".webm",".m4v",".mkv",".avi"}:
        raise HTTPException(415,"Unsupported extension. Use MP4, MOV, WebM, M4V, MKV or AVI.")
    path=folder / ("source"+ext)
    size=0
    with path.open("wb") as out:
        while True:
            chunk=await upload.read(1024*1024)
            if not chunk: break
            size+=len(chunk)
            if size>MAX_BYTES:
                out.close(); path.unlink(missing_ok=True)
                raise HTTPException(413,"Upload exceeds the 500 MB starter limit.")
            out.write(chunk)
    if size == 0: raise HTTPException(400,"The uploaded file is empty.")
    return path

def audio_energy(path, duration):
    # 2 kHz mono; calculate one RMS value per 2-second window.
    # This is a coarse energy signal, not speech understanding.
    cmd=["ffmpeg","-v","error","-i",str(path),"-vn","-ac","1","-ar","2000","-f","f32le","pipe:1"]
    try:
        raw=run(cmd,timeout=max(120,int(duration*2)))
        vals=np.frombuffer(raw,dtype=np.float32)
        if len(vals)==0: return np.zeros(max(1,int(duration/2)+1),dtype=np.float32)
        vals=np.nan_to_num(vals)
        # 4,000 samples = 2 seconds at 2 kHz.
        window=4000
        n=max(1,int(len(vals)/window))
        vals=vals[:n*window].reshape(-1,window)
        return np.sqrt(np.mean(vals*vals,axis=1))
    except Exception:
        return np.zeros(max(1,int(duration/2)+1),dtype=np.float32)

def visual_motion(path, duration):
    cap=cv2.VideoCapture(str(path))
    if not cap.isOpened(): raise HTTPException(400,"Video decoder could not open this file.")
    fps=cap.get(cv2.CAP_PROP_FPS) or 30
    total=max(1,int(duration/2)+1)
    motion=np.zeros(total,dtype=np.float32)
    prev=None
    # Sample one frame every 2 seconds to keep CPU and memory bounded.
    for sec in range(0,int(duration),2):
        cap.set(cv2.CAP_PROP_POS_MSEC,sec*1000)
        ok,frame=cap.read()
        if not ok: continue
        frame=cv2.resize(frame,(160,90),interpolation=cv2.INTER_AREA)
        gray=cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY)
        idx=min(total-1,sec//2)
        if prev is not None:
            motion[idx]=float(cv2.absdiff(gray,prev).mean())
        prev=gray
    cap.release()
    return motion

def normalize(a):
    a=np.asarray(a,dtype=np.float32)
    if not len(a): return a
    lo,hi=np.percentile(a,[10,95])
    return np.clip((a-lo)/(hi-lo+1e-6),0,1)

def analyze_file(path, duration):
    motion=visual_motion(path,duration)
    audio=audio_energy(path,duration)
    n=min(len(motion),len(audio))
    if n<2: raise HTTPException(422,"Not enough readable frames/audio to analyse.")
    score=0.65*normalize(motion[:n])+0.35*normalize(audio[:n])
    # Smooth neighbouring bins to avoid selecting isolated noise.
    smooth=np.convolve(score,np.ones(3)/3,mode="same")
    candidates=[]
    for i in range(1,len(smooth)-1):
        if smooth[i]>=smooth[i-1] and smooth[i]>=smooth[i+1] and smooth[i]>.28:
            candidates.append((float(smooth[i]),i*2+1))
    candidates.sort(reverse=True)
    picked=[]
    for val,t in candidates:
        if all(abs(t-old[1])>=12 for old in picked):
            picked.append((val,t))
        if len(picked)>=12: break
    if not picked:
        # Return a transparent low-confidence result only if a measurable signal exists.
        idx=int(np.argmax(smooth))
        if float(smooth[idx])>.12: picked=[(float(smooth[idx]),idx*2+1)]
    results=[]
    for rank,(val,t) in enumerate(picked,1):
        duration_choice=10 if val<.55 else 20 if val<.78 else 30
        start=max(0,min(duration-duration_choice,t-duration_choice*.55))
        end=min(duration,start+duration_choice)
        results.append({
            "id":rank,"start":round(start,2),"end":round(end,2),
            "duration":int(round(end-start)),"score":int(round(val*100)),
            "reason":"Selected because this section has elevated combined visual-change and audio-energy signals. Review it to confirm the gameplay context."
        })
    return results

@app.get("/health")
def health():
    return {"status":"ok","service":"CLIPNOVA AI","limits":{"max_upload_mb":500,"max_duration_seconds":MAX_DURATION},"analysis":"visual motion + audio energy; not semantic event recognition"}

@app.post("/analyze")
async def analyze(file: UploadFile=File(...)):
    folder=TEMP_ROOT/str(uuid.uuid4()); folder.mkdir(parents=True)
    try:
        path=await save_upload(file,folder)
        duration,streams=probe(path)
        highlights=analyze_file(path,duration)
        return {"duration":round(duration,2),"filename":file.filename,"analysis_method":"visual motion + audio energy (heuristic)","highlights":highlights}
    finally:
        shutil.rmtree(folder,ignore_errors=True)

def romanize(text):
    try:
        from indic_transliteration import sanscript
        from indic_transliteration.sanscript import transliterate
        # Best-effort phonetic transliteration; it is not human-style Hinglish rewriting.
        return transliterate(text,sanscript.DEVANAGARI,sanscript.HK)
    except Exception:
        return text

def make_srt(video_path, folder, duration):
    try:
        from faster_whisper import WhisperModel
        model=WhisperModel(os.getenv("WHISPER_MODEL","tiny"),device="cpu",compute_type="int8")
        segments,info=model.transcribe(str(video_path),beam_size=1,word_timestamps=False)
        lines=[]
        for i,seg in enumerate(segments,1):
            text=romanize(seg.text.strip()) if info.language=="hi" else seg.text.strip()
            if not text: continue
            def ts(t):
                ms=int(max(0,t)*1000); h=ms//3600000; m=(ms%3600000)//60000; s=(ms%60000)//1000; milli=ms%1000
                return f"{h:02}:{m:02}:{s:02},{milli:03}"
            lines.append(f"{i}\n{ts(seg.start)} --> {ts(seg.end)}\n{text}\n")
        srt=folder/"captions.srt"; srt.write_text("\n".join(lines),encoding="utf-8")
        return srt if lines else None, "Whisper captions generated" if lines else "No speech detected"
    except Exception as e:
        return None, "Captions unavailable: "+str(e)[:180]

@app.post("/generate")
async def generate(file: UploadFile=File(...), start: float=Form(...), duration: float=Form(...)):
    if start<0 or duration not in (10,20,30,40):
        raise HTTPException(400,"Start must be non-negative and duration must be 10, 20, 30 or 40 seconds.")
    folder=TEMP_ROOT/str(uuid.uuid4()); folder.mkdir(parents=True)
    try:
        source=await save_upload(file,folder)
        total,_=probe(source)
        if start>=total: raise HTTPException(400,"Clip start is beyond the video duration.")
        actual=min(duration,total-start)
        if actual<5: raise HTTPException(400,"Not enough video remains at this timestamp.")
        # Extract clip first; then attempt speech recognition on the short clip.
        rawclip=folder/"raw.mp4"
        run(["ffmpeg","-y","-ss",str(start),"-i",str(source),"-t",str(actual),"-map","0:v:0","-map","0:a?","-c:v","libx264","-preset","ultrafast","-crf","20","-c:a","aac","-b:a","128k","-movflags","+faststart",str(rawclip)],timeout=1800)
        srt,status=make_srt(rawclip,folder,actual)
        output=folder/"clipnova.mp4"
        # Gameplay-only centre crop. No facecam or generated people.
        vf="scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"
        if srt:
            escaped=str(srt).replace("\\","/").replace(":","\\:").replace("'","\\'")
            vf+=f",subtitles='{escaped}':force_style='FontName=DejaVu Sans,FontSize=18,Bold=1,Outline=3,Shadow=1,Alignment=2,MarginV=150,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101018'"
        run(["ffmpeg","-y","-i",str(rawclip),"-vf",vf,"-c:v","libx264","-preset","veryfast","-crf","21","-c:a","aac","-b:a","160k","-r","30","-movflags","+faststart",str(output)],timeout=1800)
        return FileResponse(str(output),media_type="video/mp4",filename="CLIPNOVA_clip.mp4",
                            headers={"X-CLIPNOVA-Captions":status},
                            background=BackgroundTask(shutil.rmtree,folder,ignore_errors=True))
    except Exception:
        shutil.rmtree(folder,ignore_errors=True)
        raise

