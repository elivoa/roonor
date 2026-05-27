const elements = {
  canvas: document.querySelector("#large-spectrum"),
  title: document.querySelector("#large-title"),
  meta: document.querySelector("#large-meta"),
  mode: document.querySelector("#large-mode")
};

let playback = null;
let trackKey = "";
let spectrumFrames = [];
let spectrumStatus = "WAITING PCM";
let spectrumLoadRequest = 0;
let spectrumDuration = 0;

function mergeSpectrumFrames(savedFrames, liveFrames) {
  const framesByBucket = new Map();
  for (const frame of [...savedFrames, ...liveFrames]) {
    if (!frame || !Number.isFinite(frame.position) || !Array.isArray(frame.bins)) continue;
    framesByBucket.set(Math.floor(frame.position * 10), frame);
  }
  return Array.from(framesByBucket.values()).sort((left, right) => left.position - right.position);
}

function appendOrReplaceFrame(frames, frame) {
  const bucket = Math.floor(frame.position * 10);
  const lastIndex = frames.length - 1;
  if (lastIndex >= 0 && Math.floor(frames[lastIndex].position * 10) === bucket) {
    frames[lastIndex] = frame;
  } else {
    frames.push(frame);
  }
}

async function loadSavedSpectrumFrames(nextKey) {
  const request = ++spectrumLoadRequest;
  if (!nextKey) return;
  try {
    const savedFrames = await window.roonMonitor.listSpectrumFrames(nextKey);
    if (request !== spectrumLoadRequest || nextKey !== trackKey) return;
    spectrumFrames = mergeSpectrumFrames(savedFrames, spectrumFrames);
    if (spectrumFrames.length && spectrumStatus !== "LIVE PCM") {
      spectrumStatus = "SAVED PCM";
    }
    elements.mode.textContent = spectrumStatus;
    drawSpectrum();
  } catch (error) {
    if (request === spectrumLoadRequest && nextKey === trackKey) {
      console.warn("Unable to restore saved spectrum:", error.message);
    }
  }
}

function colorForDb(db) {
  const value = Math.max(0, Math.min(1, (db + 100) / 80));
  const stops = [
    [2, 0, 42],
    [5, 20, 210],
    [0, 213, 255],
    [0, 238, 70],
    [248, 244, 0],
    [255, 22, 0]
  ];
  const scaled = value * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const start = stops[index];
  const end = stops[index + 1];
  const rgb = start.map((channel, channelIndex) =>
    Math.round(channel + (end[channelIndex] - channel) * mix)
  );
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

function spectrumPlot(width, height) {
  return {
    left: 56,
    top: 12,
    right: width - 84,
    bottom: height - 34
  };
}

function drawAxes(ctx, width, height, maxKhz, duration) {
  const plot = spectrumPlot(width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.left + 0.5, plot.top + 0.5, plot.right - plot.left, plot.bottom - plot.top);
  ctx.fillStyle = "rgba(245, 247, 250, 0.9)";
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";

  for (const khz of [0, 5, 10, 15, 20, Math.round(maxKhz)]) {
    if (khz > maxKhz + 0.1) continue;
    const y = plot.bottom - (khz / maxKhz) * (plot.bottom - plot.top);
    ctx.fillText(`${khz} kHz`, plot.left - 9, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let index = 0; index <= 6; index += 1) {
    const x = plot.left + ((plot.right - plot.left) * index) / 6;
    ctx.fillText(formatTime((duration * index) / 6), x, plot.bottom + 9);
  }

  const scaleLeft = plot.right + 14;
  const scaleWidth = 11;
  for (let index = 0; index < 80; index += 1) {
    const y = plot.top + ((plot.bottom - plot.top) * index) / 80;
    ctx.fillStyle = colorForDb(-20 - index);
    ctx.fillRect(scaleLeft, y, scaleWidth, Math.ceil((plot.bottom - plot.top) / 80) + 1);
  }
  ctx.fillStyle = "rgba(245, 247, 250, 0.9)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const db of [-20, -40, -60, -80, -100]) {
    const y = plot.top + ((-20 - db) / 80) * (plot.bottom - plot.top);
    ctx.fillText(`${db} dB`, scaleLeft + scaleWidth + 7, y);
  }
  return plot;
}

function drawFrames(ctx, plot, duration, maxKhz, frames) {
  if (!duration || !frames.length) return;
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  for (const frame of frames) {
    if (!Array.isArray(frame.bins) || !Number.isFinite(frame.position)) continue;
    const startX = Math.max(plot.left, plot.left + (frame.position / duration) * plotWidth);
    const endX = Math.min(
      plot.right,
      startX + Math.max(1, ((frame.duration || duration / plotWidth) / duration) * plotWidth)
    );
    if (startX >= plot.right || endX <= plot.left) continue;
    const frameMaxKhz = (frame.sampleRate || maxKhz * 2000) / 2000;
    for (let index = 0; index < frame.bins.length; index += 1) {
      const khzBottom = (index / frame.bins.length) * frameMaxKhz;
      const khzTop = ((index + 1) / frame.bins.length) * frameMaxKhz;
      if (khzBottom > maxKhz) break;
      const y = plot.bottom - (Math.min(khzTop, maxKhz) / maxKhz) * plotHeight;
      const cellHeight = Math.max(1, ((khzTop - khzBottom) / maxKhz) * plotHeight);
      ctx.fillStyle = colorForDb(frame.bins[index]);
      ctx.fillRect(startX, y, endX - startX + 0.5, cellHeight + 0.5);
    }
  }
}

function drawSpectrum() {
  if (!playback) return;
  const rect = elements.canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));
  if (elements.canvas.width !== width || elements.canvas.height !== height) {
    elements.canvas.width = width;
    elements.canvas.height = height;
  }
  const ctx = elements.canvas.getContext("2d");
  const duration = spectrumDuration;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, rect.width, rect.height);
  const plot = spectrumPlot(rect.width, rect.height);
  drawFrames(ctx, plot, duration, 22, spectrumFrames);
  drawAxes(ctx, rect.width, rect.height, 22, duration);
}

function drawSpectrumFrame(frame) {
  if (!playback) return;
  const rect = elements.canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const ctx = elements.canvas.getContext("2d");
  const duration = spectrumDuration;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const plot = spectrumPlot(rect.width, rect.height);
  drawFrames(ctx, plot, duration, 22, [frame]);
}

function renderState(state) {
  let shouldDraw = !playback;
  playback = state.playback || {};
  const nextKey = playback.spectrumKey || [playback.title, playback.artist, playback.album].join("|");
  if (trackKey && trackKey !== nextKey) {
    spectrumFrames = [];
    spectrumStatus = "WAITING PCM";
    shouldDraw = true;
  }
  if (trackKey !== nextKey) {
    trackKey = nextKey;
    loadSavedSpectrumFrames(nextKey);
  }
  const nextDuration = Math.max(playback.length || (playback.position || 0) + 60, 1);
  if (spectrumDuration !== nextDuration) {
    spectrumDuration = nextDuration;
    shouldDraw = true;
  }
  elements.title.textContent = playback.title || "SPECTROGRAM";
  elements.meta.textContent = [playback.artist, playback.album].filter(Boolean).join(" / ");
  elements.mode.textContent = spectrumStatus;
  if (shouldDraw) drawSpectrum();
}

function renderSnapshot(snapshot = {}) {
  if (snapshot.trackKey && trackKey && snapshot.trackKey !== trackKey) return;
  trackKey = snapshot.trackKey || trackKey;
  spectrumFrames = mergeSpectrumFrames(spectrumFrames, Array.isArray(snapshot.frames) ? snapshot.frames : []);
  spectrumStatus = snapshot.status || spectrumStatus;
  elements.mode.textContent = spectrumStatus;
  drawSpectrum();
}

function appendFrame(frame) {
  if (!frame || frame.trackKey !== trackKey || !Array.isArray(frame.bins)) return;
  appendOrReplaceFrame(spectrumFrames, frame);
  spectrumStatus = "LIVE PCM";
  elements.mode.textContent = spectrumStatus;
  drawSpectrumFrame(frame);
}

window.addEventListener("resize", drawSpectrum);
window.roonMonitor.onState(renderState);
window.roonMonitor.onSpectrumSnapshot(renderSnapshot);
window.roonMonitor.onSpectrumFrame(appendFrame);
window.roonMonitor.getState().then(renderState);
