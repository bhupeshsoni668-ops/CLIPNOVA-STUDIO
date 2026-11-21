
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

function loadVideo(file) {
  clearError();

  if (!file || !file.type.startsWith("video/")) {
    showError("Please select a valid video file.");
    return;
  }

  if (file.size > 500 * 1024 * 1024) {
    showError("Video exceeds the initial 500 MB limit.");
    return;
  }

  selectedFile = file;

  if (videoURL) URL.revokeObjectURL(videoURL);

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

videoFile.addEventListener("change", (event) => {
  loadVideo(event.target.files[0]);
});

$("saveApi").addEventListener("click", () => {
  $("apiStatus").textContent = "Not required";
  $("apiStatus").className = "pill muted";
  $("apiUrl").value = "";
});

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

    if (!Number.isFinite(metadata.duration) ||
        metadata.duration < 10) {
      throw new Error("Video must be at least 10 seconds long.");
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
      throw new Error("No suitable highlight candidates found.");
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

$("generateAllBtn").addEventListener("click", () => {
  const checked = highlights.querySelectorAll(
    'input[type="checkbox"]:checked'
  );

  if (!checked.length) {
    showError("Select at least one highlight.");
    return;
  }

  showError(
    "Highlight analysis is ready. Video rendering engine is the next implementation step."
  );
});

window.addEventListener("beforeunload", () => {
  if (videoURL) URL.revokeObjectURL(videoURL);
});
