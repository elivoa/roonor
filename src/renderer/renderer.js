const elements = {
  zone: document.querySelector("#zone"),
  status: document.querySelector("#status"),
  petCover: document.querySelector("#pet-cover"),
  panel: document.querySelector("#panel"),
  title: document.querySelector("#title"),
  artist: document.querySelector("#artist"),
  album: document.querySelector("#album"),
  fileLocation: document.querySelector("#file-location"),
  spectrum: document.querySelector("#spectrum"),
  spectrumTrack: document.querySelector("#spectrum-track"),
  spectrumMode: document.querySelector("#spectrum-mode"),
  previous: document.querySelector("#previous"),
  playpause: document.querySelector("#playpause"),
  next: document.querySelector("#next"),
  toggleLyrics: document.querySelector("#toggle-lyrics"),
  close: document.querySelector("#close")
};

let lastPlayback = null;
let spectrumTrackKey = "";
let spectrumFrames = [];
let spectrumStatus = "WAITING PCM";
let spectrumCaptureState = "idle";
let spectrumAudioContext = null;
let spectrumAnalyser = null;
let spectrumStream = null;
let spectrumCaptureFrame = 0;
let lastCapturedAt = 0;
let playbackClock = { position: 0, capturedAt: 0 };
let spectrumInputLabel = "";
let retryCaptureAfter = 0;
let pointerGesture = null;
const dragThreshold = 5;

function render(state) {
  const playback = state.playback || {};
  const controls = state.controls || {};
  lastPlayback = playback;

  elements.zone.textContent = playback.zoneName || state.coreName || state.serverHost;
  elements.status.textContent = state.message || state.connection;
  elements.title.textContent = playback.title || "未播放";
  elements.artist.textContent = playback.artist || "Roon";
  elements.album.textContent = playback.album || "等待专辑信息";
  const fileLocation = playback.fileLocation || "Roon API 未提供音频文件路径";
  elements.fileLocation.textContent = `文件位置：${fileLocation}`;
  elements.fileLocation.title = fileLocation;
  elements.petCover.style.backgroundImage = playback.imageDataUrl
    ? `url("${playback.imageDataUrl}")`
    : "";
  elements.petCover.classList.toggle("has-image", Boolean(playback.imageDataUrl));

  elements.previous.disabled = !controls.previous;
  elements.playpause.disabled = !controls.playpause;
  elements.next.disabled = !controls.next;
  elements.playpause.textContent = playback.state === "playing" ? "Ⅱ" : "▶";
  const nextSpectrumTrackKey = [playback.title, playback.artist, playback.album].join("|");
  if (spectrumTrackKey !== nextSpectrumTrackKey) {
    spectrumTrackKey = nextSpectrumTrackKey;
    spectrumFrames = [];
  }
  if (playback.state === "playing") {
    playbackClock = {
      position: playback.position || 0,
      capturedAt: performance.now()
    };
    if (spectrumCaptureState === "idle" || performance.now() >= retryCaptureAfter) {
      ensureSpectrumCapture();
    }
  }
  elements.spectrumTrack.textContent = playback.title || "SPECTROGRAM";
  elements.spectrumMode.textContent = spectrumFrames.length ? "LIVE PCM" : spectrumStatus;
  document.body.dataset.state = playback.state || "idle";
  drawSpectrum();
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

function spectrumPlot(canvasWidth, canvasHeight) {
  return {
    left: 43,
    top: 4,
    right: canvasWidth - 38,
    bottom: canvasHeight - 24
  };
}

function drawAxes(ctx, width, height, maxKhz, duration) {
  const plot = spectrumPlot(width, height);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.lineWidth = 1;
  ctx.strokeRect(plot.left + 0.5, plot.top + 0.5, plot.right - plot.left, plot.bottom - plot.top);

  ctx.fillStyle = "rgba(245, 247, 250, 0.94)";
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const frequencies = [0, 5, 10, 15, 20, Math.round(maxKhz)];
  for (const khz of frequencies) {
    if (khz > maxKhz + 0.1) continue;
    const y = plot.bottom - (khz / maxKhz) * (plot.bottom - plot.top);
    ctx.fillText(`${khz} kHz`, plot.left - 7, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const timelineMarks = 5;
  for (let index = 0; index <= timelineMarks; index += 1) {
    const x = plot.left + ((plot.right - plot.left) * index) / timelineMarks;
    ctx.fillText(formatTime((duration * index) / timelineMarks), x, plot.bottom + 7);
  }

  const scaleLeft = plot.right + 11;
  const scaleWidth = 9;
  const scaleSteps = 80;
  for (let index = 0; index < scaleSteps; index += 1) {
    const db = -20 - index;
    const y = plot.top + ((plot.bottom - plot.top) * index) / scaleSteps;
    ctx.fillStyle = colorForDb(db);
    ctx.fillRect(scaleLeft, y, scaleWidth, Math.ceil((plot.bottom - plot.top) / scaleSteps) + 1);
  }
  ctx.fillStyle = "rgba(245, 247, 250, 0.94)";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const db of [-20, -40, -60, -80, -100]) {
    const y = plot.top + ((-20 - db) / 80) * (plot.bottom - plot.top);
    ctx.fillText(`${db} dB`, scaleLeft + scaleWidth + 5, y);
  }
  return plot;
}

function drawFrames(ctx, plot, duration, maxKhz, frames = spectrumFrames) {
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
  const canvas = elements.spectrum;
  if (!canvas || !lastPlayback) return;

  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * scale));
  const height = Math.max(1, Math.floor(rect.height * scale));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  const drawWidth = rect.width;
  const drawHeight = rect.height;
  const maxKhz = 22;
  const duration = Math.max(lastPlayback.length || (lastPlayback.position || 0) + 60, 1);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, drawWidth, drawHeight);
  const plot = spectrumPlot(drawWidth, drawHeight);
  drawFrames(ctx, plot, duration, maxKhz);
  drawAxes(ctx, drawWidth, drawHeight, maxKhz, duration);
}

function drawSpectrumFrame(frame) {
  const canvas = elements.spectrum;
  if (!canvas || !lastPlayback) return;
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  const ctx = canvas.getContext("2d");
  const maxKhz = 22;
  const duration = Math.max(lastPlayback.length || (lastPlayback.position || 0) + 60, 1);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const plot = spectrumPlot(rect.width, rect.height);
  drawFrames(ctx, plot, duration, maxKhz, [frame]);
  drawAxes(ctx, rect.width, rect.height, maxKhz, duration);
}

function appendSpectrumFrame(frame) {
  if (!frame || frame.trackKey !== spectrumTrackKey || !Array.isArray(frame.bins)) return;
  spectrumFrames.push(frame);
  elements.spectrumMode.textContent = "LIVE PCM";
  drawSpectrumFrame(frame);
}

function stopStream(stream) {
  for (const track of stream?.getTracks?.() || []) {
    track.stop();
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("timeout")), timeoutMs);
    })
  ]);
}

async function findLoopbackInput() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((device) => device.kind === "audioinput");
  return (
    inputs.find((device) => device.label.toLowerCase().includes("blackhole")) ||
    inputs.find((device) => {
      const label = device.label.toLowerCase();
      return label.includes("background music") && !label.includes("ui sounds");
    }) ||
    null
  );
}

async function revealAudioInputLabels() {
  const permissionStream = await withTimeout(
    navigator.mediaDevices.getUserMedia({ audio: true }),
    10000
  );
  stopStream(permissionStream);
}

async function captureSystemOutput() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("display-capture-unavailable");
  }
  const stream = await withTimeout(
    navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }),
    12000
  );
  for (const videoTrack of stream.getVideoTracks()) {
    videoTrack.stop();
    stream.removeTrack(videoTrack);
  }
  if (!stream.getAudioTracks().length) {
    stopStream(stream);
    throw new Error("no-system-audio");
  }
  return { stream, label: "SYSTEM AUDIO" };
}

async function captureVirtualInput() {
  const permission = await withTimeout(window.roonMonitor.requestSpectrumInputAccess(), 10000);
  if (!permission.granted) {
    throw new Error(permission.status === "denied" ? "mic-denied" : "mic-required");
  }

  let device = await findLoopbackInput();
  if (!device) {
    await revealAudioInputLabels();
    device = await findLoopbackInput();
  }
  if (!device) throw new Error("loopback-required");

  const stream = await withTimeout(navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: device.deviceId },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  }), 10000);
  return { stream, label: device.label.toUpperCase() };
}

async function ensureSpectrumCapture() {
  if (spectrumCaptureState === "starting" || spectrumCaptureState === "ready") return;
  if (!navigator.mediaDevices?.getUserMedia) {
    spectrumStatus = "NO INPUT API";
    elements.spectrumMode.textContent = spectrumStatus;
    return;
  }

  spectrumCaptureState = "starting";
  spectrumStatus = "CONNECTING INPUT";
  elements.spectrumMode.textContent = spectrumStatus;

  try {
    let input;
    try {
      input = await captureSystemOutput();
    } catch (systemCaptureError) {
      input = await captureVirtualInput();
    }
    spectrumInputLabel = input.label;
    spectrumStream = input.stream;
    spectrumAudioContext = new AudioContext();
    await spectrumAudioContext.resume();
    const source = spectrumAudioContext.createMediaStreamSource(spectrumStream);
    spectrumAnalyser = spectrumAudioContext.createAnalyser();
    spectrumAnalyser.fftSize = 1024;
    spectrumAnalyser.smoothingTimeConstant = 0;
    spectrumAnalyser.minDecibels = -100;
    spectrumAnalyser.maxDecibels = -20;
    source.connect(spectrumAnalyser);
    spectrumCaptureState = "ready";
    spectrumStatus = spectrumInputLabel;
    elements.spectrumMode.textContent = spectrumStatus;
    spectrumCaptureFrame = requestAnimationFrame(captureSpectrum);
  } catch (error) {
    stopStream(spectrumStream);
    spectrumStream = null;
    spectrumCaptureState = "failed";
    const messages = {
      timeout: "INPUT TIMEOUT",
      "mic-denied": "MIC ACCESS DENIED",
      "mic-required": "MIC ACCESS REQUIRED",
      "loopback-required": "SYSTEM AUDIO DENIED",
      "no-system-audio": "SYSTEM AUDIO DENIED"
    };
    spectrumStatus = messages[error.message] || "INPUT FAILED";
    elements.spectrumMode.textContent = spectrumStatus;
    retryCaptureAfter = performance.now() + 5000;
  }
}

function captureSpectrum(now) {
  spectrumCaptureFrame = requestAnimationFrame(captureSpectrum);
  if (!spectrumAnalyser || lastPlayback?.state !== "playing" || now - lastCapturedAt < 80) {
    return;
  }

  lastCapturedAt = now;
  const bins = new Float32Array(spectrumAnalyser.frequencyBinCount);
  spectrumAnalyser.getFloatFrequencyData(bins);
  const peak = bins.reduce((value, db) => Math.max(value, db), -100);
  if (peak <= -98) {
    spectrumStatus = `${spectrumInputLabel} / SILENT`;
    elements.spectrumMode.textContent = spectrumStatus;
    return;
  }
  spectrumStatus = "LIVE PCM";
  const position = playbackClock.position + (now - playbackClock.capturedAt) / 1000;
  appendSpectrumFrame({
    trackKey: spectrumTrackKey,
    position,
    duration: 0.08,
    sampleRate: spectrumAudioContext.sampleRate,
    bins: Array.from(bins, (db) =>
      Number.isFinite(db) ? Math.max(-100, Math.min(-20, db)) : -100
    )
  });
}

for (const [action, element] of [
  ["previous", elements.previous],
  ["playpause", elements.playpause],
  ["next", elements.next]
]) {
  element.addEventListener("click", () => window.roonMonitor.control(action));
}

elements.close.addEventListener("click", () => window.roonMonitor.close());
elements.toggleLyrics.addEventListener("click", () => window.roonMonitor.toggleLyrics());

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button")) return;
  event.preventDefault();
  pointerGesture = {
    pointerId: event.pointerId,
    startX: event.screenX,
    startY: event.screenY,
    lastX: event.screenX,
    lastY: event.screenY,
    dragging: false
  };
  event.target.setPointerCapture?.(event.pointerId);
});

document.addEventListener("pointermove", (event) => {
  if (!pointerGesture || pointerGesture.pointerId !== event.pointerId) return;
  const travel = Math.hypot(
    event.screenX - pointerGesture.startX,
    event.screenY - pointerGesture.startY
  );
  if (!pointerGesture.dragging && travel >= dragThreshold) {
    pointerGesture.dragging = true;
  }
  if (!pointerGesture.dragging) return;

  const deltaX = event.screenX - pointerGesture.lastX;
  const deltaY = event.screenY - pointerGesture.lastY;
  pointerGesture.lastX = event.screenX;
  pointerGesture.lastY = event.screenY;
  if (deltaX || deltaY) {
    window.roonMonitor.moveMainWindowBy(deltaX, deltaY);
  }
});

document.addEventListener("pointerup", (event) => {
  if (!pointerGesture || pointerGesture.pointerId !== event.pointerId) return;
  const shouldToggle = !pointerGesture.dragging;
  pointerGesture = null;
  if (shouldToggle) {
    window.roonMonitor.toggleGallery();
  }
});

document.addEventListener("pointercancel", () => {
  pointerGesture = null;
});

window.roonMonitor.onState(render);
window.roonMonitor.onSpectrumFrame(appendSpectrumFrame);
window.roonMonitor.onLyricsVisibility((visible) => {
  elements.toggleLyrics.classList.toggle("active", visible);
});
window.roonMonitor.getState().then(render);
