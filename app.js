
const $ = (id) => document.getElementById(id);

const videoFile = $("videoFile");
const analyzeBtn = $("analyzeBtn");
const sourcePreview = $("sourcePreview");
const fileInfo = $("fileInfo");
const errorBox = $("errorBox");
const resultsSection = $("resultsSection");
const highlights = $("highlights");

let selectedFile = null;
let videoURL = null;
let detectedClips = [];
let ffmpeg = null;
let ffmpegLoading = false;
let generatedURLs = [];

const MAX_FILE_SIZE = 500 * 1024 * 1024;

// ---------------------------------
// ERROR HANDLING
// ---------------------------------

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
  $("analysisPercent").textContent = `${percent}%`;
  $("analysisMessage").textContent = message;
  $("analysisBar").style.width = `${percent}%`;
}

function updateGeneration(percent, message) {
  $("generationProgress").classList.remove("hidden");
  $("generationPercent").textContent = `${Math.round(percent)}%`;
  $("generationMessage").textContent = message;
  $("generationBar").style.width = `${percent}%`;
}

// ---------------------------------
// VIDEO UPLOAD
// ---------------------------------

function loadVideo(file) {
  clearError();

  if (!file || !file.type.startsWith("video/")) {
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
  sourcePreview.classList.remove("hidden");

  fileInfo.textContent =
    `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;

  fileInfo.classList.remove("hidden");
  analyzeBtn.disabled = false;

  resultsSection.classList.add("hidden");
  detectedClips = [];

  $("apiStatus").textContent = "Browser mode";
  $("apiStatus").className = "pill";
}

if (videoFile) {
  videoFile.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) loadVideo(file);
  });
}

$("saveApi").addEventListener("click", () => {
  $("apiStatus").textContent = "Not required";
  $("apiStatus").className = "pill muted";
  $("apiUrl").value = "";
});

// ---------------------------------
// VIDEO METADATA
// ---------------------------------

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

    video.onerror = () => reject(
      new Error("Could not read video metadata.")
    );
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    video.onseeked = () => resolve();

    video.onerror = () => reject(
      new Error("Video frame could not be read.")
    );

    video.currentTime = Math.min(
      time,
      Math.max(0, video.duration - 0.05)
    );
  });
}

// ---------------------------------
// VISUAL FRAME ANALYSIS
// ---------------------------------

async function analyzeFrames(url, duration) {
  const video = document.createElement("video");

  video.src = url;
  video.muted = true;
  video.preload = "auto";

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;

    video.onerror = () => reject(
      new Error("Unable to load gameplay video.")
    );
  });

  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 54;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true
  });

  if (!ctx) {
    throw new Error("Canvas is not supported in this browser.");
  }

  const sampleInterval = Math.max(1, duration / 180);
  const scores = [];

  let previousFrame = null;
  let currentTime = 0;

  while (currentTime < duration) {
    await seekVideo(video, currentTime);

    ctx.drawImage(video, 0, 0, 96, 54);

    const pixels = ctx.getImageData(
      0, 0, 96, 54
    ).data;

    let difference = 0;

    if (previousFrame) {
      for (let i = 0; i < pixels.length; i += 4) {
        const current =
          (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3;

        const previous =
          (previousFrame[i] +
           previousFrame[i + 1] +
           previousFrame[i + 2]) / 3;

        difference += Math.abs(current - previous);
      }

      difference /= (96 * 54);
    }

    scores.push({
      time: currentTime,
      score: difference
    });

    previousFrame = new Uint8ClampedArray(pixels);
    currentTime += sampleInterval;

    const percent = Math.min(
      95,
      Math.round((currentTime / duration) * 100)
    );

    updateProgress(
      percent,
      `Analyzing gameplay: ${formatTime(Math.min(currentTime, duration))}`
    );

    await new Promise(resolve => setTimeout(resolve, 0));
  }

  return scores;
}

// ---------------------------------
// HIGHLIGHT DETECTION
// ---------------------------------

function findHighlights(scores, duration) {
  const clipDuration = Math.min(20, duration);
  const candidates = [];

  const step = Math.max(2, clipDuration / 4);

  for (
    let start = 0;
    start + clipDuration <= duration;
    start += step
  ) {
    const windowScores = scores.filter(
      item =>
        item.time >= start &&
        item.time < start + clipDuration
    );

    if (!windowScores.length) continue;

    const average =
      windowScores.reduce((sum, item) => sum + item.score, 0) /
      windowScores.length;

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

    if (!overlaps) selected.push(candidate);

    if (selected.length >= 5) break;
  }

  return selected.sort((a, b) => a.start - b.start);
}

// ---------------------------------
// DISPLAY HIGHLIGHTS
// ---------------------------------

function displayHighlights(clips) {
  highlights.innerHTML = "";

  clips.forEach((clip, index) => {
    const card = document.createElement("div");
    card.className = "highlight-card";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.index = index;

    const title = document.createElement("strong");
    title.textContent = `Highlight ${index + 1}`;

    const timing = document.createElement("p");
    timing.textContent =
      `${formatTime(clip.start)} – ${formatTime(clip.end)}`;

    const score = document.createElement("small");
    score.textContent =
      `Visual activity score: ${clip.score.toFixed(2)}`;

    card.append(checkbox, title, timing, score);
    highlights.appendChild(card);
  });

  $("resultCount").textContent =
    `${clips.length} candidates`;

  resultsSection.classList.remove("hidden");
}

// ---------------------------------
// FFMPEG INITIALIZATION
// ---------------------------------

async function initializeFFmpeg() {
  if (ffmpeg && ffmpeg.isLoaded()) {
    return;
  }

  if (ffmpegLoading) {
    throw new Error("FFmpeg is already loading. Please wait.");
  }

  const library = window.FFmpeg;

  if (
    !library ||
    !library.createFFmpeg ||
    !library.fetchFile
  ) {
    throw new Error(
      "FFmpeg library not found. Check the script tag in index.html."
    );
  }

  ffmpegLoading = true;

  try {
    updateGeneration(2, "Initializing single-thread FFmpeg...");

    ffmpeg = library.createFFmpeg({
      log: false,
      mainName: "main",
      corePath:
        "https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js",
      progress: ({ ratio }) => {
        if (Number.isFinite(ratio)) {
          window.currentFFmpegProgress = Math.max(
            0,
            Math.min(1, ratio)
          );
        }
      }
    });

    updateGeneration(5, "Downloading single-thread FFmpeg engine...");

    await ffmpeg.load();

    updateGeneration(10, "FFmpeg engine ready.");

  } catch (error) {
    ffmpeg = null;
    throw error;

  } finally {
    ffmpegLoading = false;
  }
}

// ---------------------------------
// CLEANUP DOWNLOADS
// ---------------------------------

function clearDownloads() {
  generatedURLs.forEach(url => URL.revokeObjectURL(url));
  generatedURLs = [];

  $("downloads").innerHTML = "";
}

// ---------------------------------
// RENDER ONE VERTICAL MP4
// ---------------------------------

async function renderClip(clip, index, total) {
  const { fetchFile } = window.FFmpeg;

  const inputName = "clipnova_input";
  const outputName = `clipnova_output_${index + 1}.mp4`;

  const duration = clip.end - clip.start;

  try {
    updateGeneration(
      10 + (index / total) * 85,
      `Preparing highlight ${index + 1}/${total}...`
    );

    const videoData = await fetchFile(selectedFile);

    ffmpeg.FS("writeFile", inputName, videoData);

    window.currentFFmpegProgress = 0;

    const startProgress = 10 + (index / total) * 85;
    const clipProgress = 85 / total;

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

    const outputData = ffmpeg.FS(
      "readFile",
      outputName
    );

    const blob = new Blob(
      [outputData],
      { type: "video/mp4" }
    );

    if (!blob.size) {
      throw new Error("Rendered video is empty.");
    }

    const downloadURL = URL.createObjectURL(blob);
    generatedURLs.push(downloadURL);

    createDownloadCard(
      downloadURL,
      index + 1,
      blob.size
    );

    return true;

  } finally {
    try {
      ffmpeg.FS("unlink", inputName);
    } catch (_) {}

    try {
      ffmpeg.FS("unlink", outputName);
    } catch (_) {}
  }
}

// ---------------------------------
// DOWNLOAD CARD
// ---------------------------------

function createDownloadCard(url, index, size) {
  const card = document.createElement("div");
  card.className = "highlight-card";

  const title = document.createElement("strong");
  title.textContent = `Gaming Short ${index}`;

  const info = document.createElement("p");
  info.textContent =
    `MP4 · 1080 × 1920 · ${(size / (1024 * 1024)).toFixed(1)} MB`;

  const link = document.createElement("a");
  link.href = url;
  link.download = `CLIPNOVA_Short_${index}.mp4`;
  link.className = "btn primary";
  link.textContent = "DOWNLOAD MP4";

  card.append(title, info, link);
  $("downloads").appendChild(card);
}

// ---------------------------------
// GENERATE SELECTED CLIPS
// ---------------------------------

$("generateAllBtn").addEventListener("click", async () => {
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

  const selectedClips = checked.map(
    checkbox => detectedClips[
      Number(checkbox.dataset.index)
    ]
  );

  const button = $("generateAllBtn");
  button.disabled = true;

  clearDownloads();

  try {
    updateGeneration(0, "Starting rendering engine...");

    await initializeFFmpeg();

    for (let i = 0; i < selectedClips.length; i++) {
      await renderClip(
        selectedClips[i],
        i,
        selectedClips.length
      );
    }

    updateGeneration(100, "All MP4 clips rendered successfully.");

  } catch (error) {
    console.error("CLIPNOVA rendering error:", error);

    showError(
      "Rendering failed: " +
      (error.message || "Unknown error") +
      ". Try a smaller video or another browser."
    );

    updateGeneration(0, "Rendering failed.");

  } finally {
    button.disabled = false;
  }
});

// ---------------------------------
// ANALYZE VIDEO
// ---------------------------------

analyzeBtn.addEventListener("click", async () => {
  clearError();

  if (!selectedFile || !videoURL) {
    showError("Upload a gameplay video first.");
    return;
  }

  analyzeBtn.disabled = true;
  detectedClips = [];

  try {
    updateProgress(0, "Reading video...");

    const metadata = await getVideoMetadata(videoURL);

    if (
      !Number.isFinite(metadata.duration) ||
      metadata.duration < 10
    ) {
      throw new Error(
        "Video must be at least 10 seconds long."
      );
    }

    const scores = await analyzeFrames(
      videoURL,
      metadata.duration
    );

    updateProgress(98, "Ranking highlights...");

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
    showError(error.message || "Video analysis failed.");

  } finally {
    analyzeBtn.disabled = false;
  }
});

// ---------------------------------
// PAGE CLEANUP
// ---------------------------------

window.addEventListener("beforeunload", () => {
  if (videoURL) {
    URL.revokeObjectURL(videoURL);
  }

  generatedURLs.forEach(url => {
    URL.revokeObjectURL(url);
  });
});
        
