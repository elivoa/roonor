const elements = {
  zone: document.querySelector("#zone"),
  status: document.querySelector("#status"),
  petCover: document.querySelector("#pet-cover"),
  title: document.querySelector("#title"),
  artist: document.querySelector("#artist"),
  album: document.querySelector("#album"),
  lyrics: document.querySelector("#lyrics"),
  spectrum: document.querySelector("#spectrum"),
  spectrumMode: document.querySelector("#spectrum-mode"),
  previous: document.querySelector("#previous"),
  playpause: document.querySelector("#playpause"),
  next: document.querySelector("#next"),
  close: document.querySelector("#close")
};

let lastPlayback = null;
let animationFrame = 0;
let lastSpectrumDraw = 0;

function render(state) {
  const playback = state.playback || {};
  const controls = state.controls || {};
  lastPlayback = playback;

  elements.zone.textContent = playback.zoneName || state.coreName || state.serverHost;
  elements.status.textContent = state.message || state.connection;
  elements.title.textContent = playback.title || "未播放";
  elements.artist.textContent = playback.artist || "Roon";
  elements.album.textContent = playback.album || "等待专辑信息";
  elements.petCover.style.backgroundImage = playback.imageDataUrl
    ? `url("${playback.imageDataUrl}")`
    : "";
  elements.petCover.classList.toggle("has-image", Boolean(playback.imageDataUrl));

  elements.lyrics.innerHTML = "";
  for (const line of playback.lyrics || []) {
    const item = document.createElement("p");
    item.textContent = line;
    elements.lyrics.appendChild(item);
  }

  elements.previous.disabled = !controls.previous;
  elements.playpause.disabled = !controls.playpause;
  elements.next.disabled = !controls.next;
  elements.playpause.textContent = playback.state === "playing" ? "Ⅱ" : "▶";
  elements.spectrumMode.textContent = playback.state === "playing" ? "LIVE" : "44.1 kHz";
  document.body.dataset.state = playback.state || "idle";
  drawSpectrum(performance.now());
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFromSeed(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function colorForEnergy(energy) {
  const value = Math.max(0, Math.min(1, energy));
  const stops = [
    [7, 14, 35],
    [28, 74, 131],
    [47, 169, 207],
    [240, 215, 100],
    [248, 108, 77]
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

function drawSpectrum(now) {
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
  const key = [
    lastPlayback.title,
    lastPlayback.artist,
    lastPlayback.album,
    lastPlayback.imageKey
  ].join("|");
  const seed = hashString(key || "ROON");
  const random = randomFromSeed(seed);
  const columns = 112;
  const rows = 58;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const isPlaying = lastPlayback.state === "playing";
  const drift = isPlaying ? now / 1800 : 0;
  const bassBand = 0.2 + random() * 0.16;
  const vocalBand = 0.45 + random() * 0.18;
  const airBand = 0.72 + random() * 0.14;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(4, 8, 18, 0.48)";
  ctx.fillRect(0, 0, width, height);

  for (let col = 0; col < columns; col += 1) {
    const time = col / columns;
    const transient = Math.pow(Math.max(0, Math.sin((time * 14 + random() * 3 + drift) * Math.PI)), 9);
    const pulse = 0.5 + 0.5 * Math.sin(time * 18 + drift * 2.1 + random() * 2);

    for (let row = 0; row < rows; row += 1) {
      const freq = 1 - row / rows;
      const bass = Math.exp(-Math.pow((freq - bassBand) / 0.12, 2)) * 0.85;
      const vocal = Math.exp(-Math.pow((freq - vocalBand) / 0.11, 2)) * 0.64;
      const air = Math.exp(-Math.pow((freq - airBand) / 0.09, 2)) * 0.38;
      const rolloff = Math.pow(1 - freq, 0.42);
      const grain = random() * 0.2;
      const shimmer = Math.sin((time * 22 + freq * 19 + drift) * 2.7) * 0.08;
      const energy = (bass + vocal + air + transient * 0.42 + grain + shimmer) * rolloff * (0.72 + pulse * 0.28);

      ctx.fillStyle = colorForEnergy(energy);
      ctx.fillRect(
        Math.floor(col * cellWidth),
        Math.floor(row * cellHeight),
        Math.ceil(cellWidth + 0.5),
        Math.ceil(cellHeight + 0.5)
      );
    }
  }

  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  for (let line = 1; line < 4; line += 1) {
    const y = Math.floor((height / 4) * line);
    ctx.fillRect(0, y, width, 1);
  }
}

function tickSpectrum(now) {
  if (lastPlayback?.state === "playing" && now - lastSpectrumDraw > 140) {
    lastSpectrumDraw = now;
    drawSpectrum(now);
  }
  animationFrame = requestAnimationFrame(tickSpectrum);
}

for (const [action, element] of [
  ["previous", elements.previous],
  ["playpause", elements.playpause],
  ["next", elements.next]
]) {
  element.addEventListener("click", () => window.roonMonitor.control(action));
}

elements.close.addEventListener("click", () => window.roonMonitor.close());

window.roonMonitor.onState(render);
window.roonMonitor.getState().then(render);
animationFrame = requestAnimationFrame(tickSpectrum);
