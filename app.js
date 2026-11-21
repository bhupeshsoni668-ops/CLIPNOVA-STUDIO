
"use strict";

// =============================================
// CLIPNOVA AI - GAMING SHORTS GENERATOR
// FFmpeg.wasm 0.11.6 - Single Thread
// =============================================

const $ = (id) => document.getElementById(id);

const videoFile = $("videoFile");
const analyzeBtn = $("analyzeBtn");
const sourcePreview = $("sourcePreview");
const fileInfo = $("fileInfo");
const errorBox = $("errorBox");
const resultsSection = $("resultsSection");
const highlights = $("highlights");
const generateBtn = $("generateAllBtn");

let selectedFile = null;
let videoURL = null;
let detectedClips = [];
let ffmpeg = null;
let ffmpegLoading = false;
let generating = false;
let generatedURLs = [];

const MAX_FILE_SIZE = 500 * 1024 * 1024;
const MAX_ANALYSIS_FRAMES = 90;

// =============================================
// HELPERS
// =============================================

function showError(message) {
  errorBox.textContent = message;
  errorBox.classList.remove("hidden");
}

function clearError() {
  errorBox.textContent = "";
  errorBox.classList.add("hidden");
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);

  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateProgress(percent, message) {
  $("analysisProgress").classList.remove("hidden");
  $("analysisPercent").textContent = `${Math.round(percent)}%`;
  $("analysisMessage").textContent = message;
  $("analysisBar").style.width = `${percent}%`;
}

function updateGeneration(percent, message) {
  $("generationProgress").classList.remove("hidden");

  const safePercent = Math.max(0, Math.min(100, percent));

  $("generationPercent").textContent =
    `${Math.round(safePercent)}%`;

  $("generationMessage").textContent = message;
  $("generationBar").style.width = `${safePercent}%`;
}

function waitForPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => resolve());
  });
}

function formatSize(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// =============================================
// VIDEO UPLOAD
// =============================================

function loadVideo(file) {
  clearError();

  if (!file) return;

  if (
    !file.type.startsWith("video/") &&
    !/\.(mp4|mov|webm|m4v|mkv)$/i.test(file.name)
  ) {
    showError("Please select a valid video file.");
    return;
  }

  if (file.size > MAX_FILE_SIZE) {
    showError("Video exceeds the 500 MB limit.");
    return;
  }

  selectedFile = file;

  if (videoURL) {
    URL.revokeObjectURL(videoURL);
  }

  videoURL = URL.createObjectURL(file);

  sourcePreview.src = videoURL;
  sourcePreview.load();
  sourcePreview.classList.remove("hidden");

  fileInfo.textContent =
    `${file.name} · ${formatSize(file.size)}`;

  fileInfo.classList.remove("hidden");

  analyzeBtn.disabled = false;

  detectedClips = [];
  resultsSection.classList.add("hidden");

  $("apiStatus").textContent = "Browser mode";
  $("apiStatus").className = "pill";
}

if (videoFile) {
  videoFile.addEventListener("change", event => {
    const file = event.target.files[0];

    if (file) loadVideo(file);
  });
}

$("saveApi").addEventListener("click", () => {
  $("apiStatus").textContent = "Not required";
  $("apiStatus").className = "pill muted";
  $("apiUrl").value = "";
});

// =============================================
// VIDEO METADATA
// =============================================

function getVideoMetadata(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");

    video.preload = "metadata";
    video.muted = true;
    video.src = url;

    video.onloadedmetadata = () => {
      resolve({
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight
      });
    };

    video.onerror = () => {
      reject(new Error("Could not read video metadata."));
    };

    video.load();
  });
}

// =============================================
// SAFE VIDEO SEEK
// =============================================

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const target = Math.min(
      time,
      Math.max(0, video.duration - 0.05)
    );

    if (Math.abs(video.currentTime - target) < 0.01) {
      resolve();
      return;
    }

    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;

      finished = true;
      cleanup();

      reject(new Error(
        "Video seeking timed out. Try another MP4 video."
      ));
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("error", onError);
    }

    function onSeeked() {
      if (finished) return;

      finished = true;
      cleanup();
      resolve();
    }

    function onError() {
      if (finished) return;

      finished = true;
      cleanup();

      reject(new Error("Video frame could not be read."));
    }

    video.addEventListener("seeked", onSeeked);
    video.addEventListener("error", onError);

    video.currentTime = target;
  });
}

// =============================================
// VISUAL FRAME ANALYSIS
// =============================================

async function analyzeFrames(url, duration) {
  const video = document.createElement("video");

  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;

    video.onerror = () => {
      reject(new Error("Unable to load gameplay video."));
    };

    video.load();
  });

  const canvas = document.createElement("canvas");

  canvas.width = 96;
  canvas.height = 54;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true
  });

  if (!ctx) {
    throw new Error("Canvas is not supported.");
  }

  const sampleCount = Math.min(
    MAX_ANALYSIS_FRAMES,
    Math.max(2, Math.floor(duration))
  );

  const sampleInterval = duration / sampleCount;

  const scores = [];
  let previousFrame = null;

  try {
    for (let i = 0; i < sampleCount; i++) {
      const currentTime = Math.min(
        i * sampleInterval,
        duration - 0.05
      );

      await seekVideo(video, currentTime);

      ctx.drawImage(video, 0, 0, 96, 54);

      const pixels = ctx.getImageData(
        0, 0, 96, 54
      ).data;

      let difference = 0;

      if (previousFrame) {
        for (let p = 0; p < pixels.length; p += 4) {
          const current =
            (pixels[p] + pixels[p + 1] + pixels[p + 2]) / 3;

          const previous =
            (previousFrame[p] +
             previousFrame[p + 1] +
             previousFrame[p + 2]) / 3;

          difference += Math.abs(current - previous);
        }

        difference /= (96 * 54);
      }

      scores.push({
        time: currentTime,
        score: difference
      });

      previousFrame = new Uint8ClampedArray(pixels);

      const percent = Math.round(
        ((i + 1) / sampleCount) * 95
      );

      updateProgress(
        percent,
        `Analyzing gameplay: ${formatTime(currentTime)}`
      );

      await waitForPaint();
    }
  } finally {
    video.removeAttribute("src");
    video.load();
  }

  return scores;
}

// =============================================
// HIGHLIGHT DETECTION
// =============================================

function findHighlights(scores, duration) {
  const clipDuration = Math.min(20, duration);
  const candidates = [];

  const step = Math.max(2, clipDuration / 4);

  for (
    let start = 0;
    start + clipDuration <= duration;
    start += step
  ) {
    const windowScores = scores.filter(item =>
      item.time >= start &&
      item.time < start + clipDuration
    );

    if (!windowScores.length) continue;

    const average =
      windowScores.reduce(
        (sum, item) => sum + item.score, 0
      ) / windowScores.length;

    candidates.push({
      start,
      end: start + clipDuration,
      score: average
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  const selected = [];

  for (const candidate of candidates) {
    const overlaps = selected.some(item =>
      candidate.start < item.end &&
      candidate.end > item.start
    );

    if (!overlaps) {
      selected.push(candidate);
    }

    if (selected.length >= 5) break;
  }

  return selected.sort((a, b) => a.start - b.start);
}

// =============================================
// DISPLAY HIGHLIGHTS
// =============================================

function displayHighlights(clips) {
  highlights.innerHTML = "";

  clips.forEach((clip, index) => {
    const card = document.createElement("div");
    card.className = "highlight";

    const content = document.createElement("div");

    const title = document.createElement("h3");
    title.textContent = `Highlight ${index + 1}`;

    const timing = document.createElement("p");
    timing.textContent =
      `${formatTime(clip.start)} – ${formatTime(clip.end)}`;

    const score = document.createElement("div");
    score.className = "meta";
    score.textContent =
      `Visual activity score: ${clip.score.toFixed(2)}`;

    content.append(title, timing, score);

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = index;
    checkbox.setAttribute(
      "aria-label",
      `Select highlight ${index + 1}`
    );

    card.append(content, checkbox);
    highlights.appendChild(card);
  });

  $("resultCount").textContent =
    `${clips.length} candidates`;

  resultsSection.classList.remove("hidden");
}

// =============================================
// FFMPEG INITIALIZATION
// =============================================

async function initializeFFmpeg() {
  if (ffmpeg && ffmpeg.isLoaded()) {
    return;
  }

  if (ffmpegLoading) {
    throw new Error("FFmpeg is already loading.");
  }

  const library = window.FFmpeg;

  if (
    !library ||
    !library.createFFmpeg ||
    !library.fetchFile
  ) {
    throw new Error(
      "FFmpeg library missing. Check index.html script URL."
    );
  }

  ffmpegLoading = true;

  try {
    updateGeneration(2, "Initializing FFmpeg engine...");
    await waitForPaint();

    ffmpeg = library.createFFmpeg({
      log: false,
      mainName: "main",

      corePath:
        "https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js",

      progress: ({ ratio }) => {
        window.currentFFmpegProgress = Number.isFinite(ratio)
          ? Math.max(0, Math.min(1, ratio))
          : 0;
      }
    });

    updateGeneration(5, "Downloading FFmpeg engine...");
    await waitForPaint();

    await ffmpeg.load();

    updateGeneration(10, "FFmpeg engine ready.");
    await waitForPaint();

  } catch (error) {
    ffmpeg = null;
    throw error;

  } finally {
    ffmpegLoading = false;
  }
}

// =============================================
// CLEANUP DOWNLOADS
// =============================================

function clearDownloads() {
  generatedURLs.forEach(url => {
    URL.revokeObjectURL(url);
  });

  generatedURLs = [];

  $("downloads").innerHTML = "";
}

// =============================================
// DOWNLOAD CARD
// =============================================

function createDownloadCard(url, index, size) {
  const card = document.createElement("div");
  card.className = "download-card";

  const title = document.createElement("strong");
  title.textContent = `Gaming Short ${index}`;

  const info = document.createElement("p");
  info.textContent =
    `MP4 · 1080 × 1920 · ${formatSize(size)}`;

  const link = document.createElement("a");
  link.href = url;
  link.download = `CLIPNOVA_Short_${index}.mp4`;
  link.className = "btn primary";
  link.textContent = "DOWNLOAD MP4";

  card.append(title, info, link);

  $("downloads").appendChild(card);
}

// =============================================
// RENDER ONE CLIP
// IMPORTANT: ONLY ONE renderClip DEFINITION
// =============================================

async function renderClip(clip, index, total) {
  const inputName = "clipnova_input.mp4";
  const outputName = `clipnova_output_${index + 1}.mp4`;

  const duration = clip.end - clip.start;

  let inputWritten = false;

  try {
    updateGeneration(
      10 + (index / total) * 85,
      `Preparing highlight ${index + 1}/${total}...`
    );

    await waitForPaint();

    // STEP 1: Read source video

    updateGeneration(
      11 + (index / total) * 85,
      "Reading video file..."
    );

    await waitForPaint();

    if (!selectedFile) {
      throw new Error("No source video selected.");
    }

    const buffer = await selectedFile.arrayBuffer();

    if (!buffer || buffer.byteLength === 0) {
      throw new Error("Source video is empty.");
    }

    const videoData = new Uint8Array(buffer);

    // STEP 2: Write video into FFmpeg

    updateGeneration(
      12 + (index / total) * 85,
      "Copying video into FFmpeg memory..."
    );

    await waitForPaint();

    ffmpeg.FS("writeFile", inputName, videoData);
    inputWritten = true;

    // Release reference to the temporary buffer.
    // FFmpeg has its own copy in memory.

    // STEP 3: Render clip

    const startProgress =
      13 + (index / total) * 85;

    const clipProgress = 85 / total;

    updateGeneration(
      startProgress,
      `Rendering highlight ${index + 1}/${total}...`
    );

    await waitForPaint();

    ffmpeg.setProgress(({ ratio }) => {
      const safeRatio = Number.isFinite(ratio)
        ? Math.max(0, Math.min(1, ratio))
        : 0;

      updateGeneration(
        startProgress + safeRatio * clipProgress,
        `Rendering highlight ${index + 1}/${total}...`
      );
    });

    await ffmpeg.run(
      "-y",
      "-ss", clip.start.toFixed(3),
      "-i", inputName,
      "-t", duration.toFixed(3),

      "-map", "0:v:0",
      "-map", "0:a?",

      "-vf",
      "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1",

      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "26",
      "-pix_fmt", "yuv420p",

      "-c:a", "aac",
      "-b:a", "128k",

      "-threads", "1",
      "-movflags", "+faststart",

      outputName
    );

    // STEP 4: Read output

    updateGeneration(
      startProgress + clipProgress * 0.95,
      "Preparing MP4 download..."
    );


async function renderClip(clip, index, total) {
  const inputName = "clipnova_input.mp4";
  const outputName = `clipnova_output_${index + 1}.mp4`;

  const duration = clip.end - clip.start;

  let inputWritten = false;

  try {
    if (!selectedFile) {
      throw new Error("No source video selected.");
    }

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Invalid highlight duration.");
    }

    updateGeneration(
      10 + (index / total) * 85,
      `Preparing highlight ${index + 1}/${total}...`
    );

    await waitForPaint();

    // STEP 1: Read source video

    updateGeneration(
      11 + (index / total) * 85,
      "Reading video file..."
    );

    await waitForPaint();

    let buffer = await selectedFile.arrayBuffer();

    if (!buffer || buffer.byteLength === 0) {
      throw new Error("Source video is empty.");
    }

    let videoData = new Uint8Array(buffer);

    // STEP 2: Copy source into FFmpeg memory

    updateGeneration(
      12 + (index / total) * 85,
      "Copying video into FFmpeg memory..."
    );

    await waitForPaint();

    ffmpeg.FS("writeFile", inputName, videoData);
    inputWritten = true;

    // Release temporary JS references

    videoData = null;
    buffer = null;

    await waitForPaint();

    // STEP 3: Render highlight

    const startProgress =
      13 + (index / total) * 85;

    const clipProgress = 85 / total;

    updateGeneration(
      startProgress,
      `Rendering highlight ${index + 1}/${total}...`
    );

    await waitForPaint();

    ffmpeg.setProgress(({ ratio }) => {
      const safeRatio = Number.isFinite(ratio)
        ? Math.max(0, Math.min(1, ratio))
        : 0;

      updateGeneration(
        startProgress + safeRatio * clipProgress,
        `Rendering highlight ${index + 1}/${total}...`
      );
    });

    // STEP 4: Execute FFmpeg

    let normalExit = false;

    try {
      await ffmpeg.run(
        "-nostdin",
        "-y",

        "-ss", clip.start.toFixed(3),
        "-i", inputName,
        "-t", duration.toFixed(3),

        "-map", "0:v:0",
        "-map", "0:a?",

        "-vf",
        "scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,fps=30,setsar=1",

        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-pix_fmt", "yuv420p",

        "-c:a", "aac",
        "-b:a", "96k",

        "-threads", "1",
        "-movflags", "+faststart",

        outputName
      );

    } catch (error) {
      const message = error?.message || String(error);

      // Some single-thread FFmpeg builds throw
      // ExitStatus even after a normal exit(0).

      if (
        error?.status === 0 ||
        /exit\(0\)/i.test(message)
      ) {
        normalExit = true;
        console.warn(
          "FFmpeg returned exit(0). Verifying output file."
        );
      } else {
        throw error;
      }
    }

    // STEP 5: Verify actual output

    updateGeneration(
      startProgress + clipProgress * 0.95,
      "Verifying rendered MP4..."
    );

    await waitForPaint();

    let outputData;

    try {
      outputData = ffmpeg.FS(
        "readFile",
        outputName
      );
    } catch (error) {
      if (normalExit) {
        throw new Error(
          "FFmpeg exited with code 0, but the output MP4 could not be read. Try a smaller source video."
        );
      }

      throw error;
    }

    if (!outputData || outputData.length === 0) {
      throw new Error("Rendered video is empty.");
    }

    // STEP 6: Create downloadable MP4

    const blob = new Blob(
      [outputData],
      { type: "video/mp4" }
    );

    if (!blob.size) {
      throw new Error("MP4 file creation failed.");
    }

    const downloadURL = URL.createObjectURL(blob);

    generatedURLs.push(downloadURL);

    createDownloadCard(
      downloadURL,
      index + 1,
      blob.size
    );

    updateGeneration(
      startProgress + clipProgress,
      `Highlight ${index + 1} completed.`
    );

    return true;

  } finally {
    // STEP 7: Clean temporary FFmpeg files

    try {
      if (inputWritten) {
        ffmpeg.FS("unlink", inputName);
      }
    } catch (_) {}

    try {
      ffmpeg.FS("unlink", outputName);
    } catch (_) {}
  }
}
    

// =============================================
// GENERATE SELECTED CLIPS
// =============================================

generateBtn.addEventListener("click", async () => {
  if (generating) return;

  clearError();

  if (!selectedFile || !detectedClips.length) {
    showError("Analyze a gameplay video first.");
    return;
  }

  const checked = Array.from(
    highlights.querySelectorAll(
      'input[type="checkbox"]:checked'
    )
  );

  if (!checked.length) {
    showError("Select at least one highlight.");
    return;
  }

  const selectedClips = checked.map(checkbox => {
    return detectedClips[
      Number(checkbox.dataset.index)
    ];
  });

  if (selectedClips.some(clip => !clip)) {
    showError("Invalid highlight selection. Analyze again.");
    return;
  }

  generating = true;
  generateBtn.disabled = true;
  analyzeBtn.disabled = true;

  clearDownloads();

  try {
    updateGeneration(0, "Starting rendering engine...");
    await waitForPaint();

    await initializeFFmpeg();

    for (let i = 0; i < selectedClips.length; i++) {
      await renderClip(
        selectedClips[i],
        i,
        selectedClips.length
      );
    }

    updateGeneration(
      100,
      "All MP4 clips rendered successfully."
    );

  } catch (error) {
    console.error("CLIPNOVA rendering error:", error);

    showError(
      "Rendering failed: " +
      (error.message || "Unknown error") +
      ". Try one short MP4 clip."
    );

    updateGeneration(0, "Rendering failed.");

  } finally {
    generating = false;
    generateBtn.disabled = false;
    analyzeBtn.disabled = false;
  }
});

// =============================================
// ANALYZE VIDEO
// =============================================

analyzeBtn.addEventListener("click", async () => {
  clearError();

  if (!selectedFile || !videoURL) {
    showError("Upload a gameplay video first.");
    return;
  }

  if (generating) {
    showError("Wait until rendering finishes.");
    return;
  }

  analyzeBtn.disabled = true;
  generateBtn.disabled = true;

  detectedClips = [];

  try {
    updateProgress(0, "Reading video...");
    await waitForPaint();

    const metadata = await getVideoMetadata(videoURL);

    if (
      !Number.isFinite(metadata.duration) ||
      metadata.duration < 10
    ) {
      throw new Error(
        "Video must be at least 10 seconds long."
      );
    }

    updateProgress(2, "Preparing frame analysis...");
    await waitForPaint();

    const scores = await analyzeFrames(
      videoURL,
      metadata.duration
    );

    updateProgress(97, "Ranking highlights...");
    await waitForPaint();

    detectedClips = findHighlights(
      scores,
      metadata.duration
    );

    if (!detectedClips.length) {
      throw new Error(
        "No suitable highlight candidates found."
      );
    }

    displayHighlights(detectedClips);

    updateProgress(100, "Analysis complete.");

    $("analysisMessage").textContent =
      `Analysis complete · ${metadata.width} × ${metadata.height}`;

  } catch (error) {
    console.error("CLIPNOVA analysis error:", error);

    showError(
      error.message || "Video analysis failed."
    );

  } finally {
    analyzeBtn.disabled = false;
    generateBtn.disabled = false;
  }
});

// =============================================
// PAGE CLEANUP
// =============================================

window.addEventListener("beforeunload", () => {
  if (videoURL) {
    URL.revokeObjectURL(videoURL);
  }

  generatedURLs.forEach(url => {
    URL.revokeObjectURL(url);
  });
});
                
