const elements = {
  zone: document.querySelector("#info-zone"),
  state: document.querySelector("#info-state"),
  title: document.querySelector("#info-title"),
  artist: document.querySelector("#info-artist"),
  album: document.querySelector("#info-album"),
  progress: document.querySelector("#info-progress"),
  position: document.querySelector("#info-position"),
  length: document.querySelector("#info-length"),
  lyric: document.querySelector("#info-lyric"),
  location: document.querySelector("#info-location"),
  previous: document.querySelector("#info-previous"),
  playpause: document.querySelector("#info-playpause"),
  next: document.querySelector("#info-next")
};

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function currentLyric(playback) {
  const lines = playback.lyricData?.lines || [];
  let text = "";
  for (const line of lines) {
    if (line.time > (playback.position || 0)) break;
    text = line.text;
  }
  return text;
}

function render(state) {
  const playback = state.playback || {};
  const controls = state.controls || {};
  const duration = Math.max(playback.length || 0, 0);
  const position = Math.max(0, Math.min(playback.position || 0, duration || Infinity));

  elements.zone.textContent = playback.zoneName || state.coreName || state.serverHost;
  elements.state.textContent = state.message || state.connection;
  elements.title.textContent = playback.title || "未播放";
  elements.artist.textContent = playback.artist || "Roon";
  elements.album.textContent = playback.album || "等待专辑信息";
  elements.progress.style.width = `${duration ? (position / duration) * 100 : 0}%`;
  elements.position.textContent = formatTime(position);
  elements.length.textContent = formatTime(duration);
  elements.lyric.textContent = currentLyric(playback);
  elements.location.textContent = playback.fileLocation || "Roon API 未提供音频文件路径";
  elements.previous.disabled = !controls.previous;
  elements.playpause.disabled = !controls.playpause;
  elements.next.disabled = !controls.next;
  elements.playpause.textContent = playback.state === "playing" ? "Ⅱ" : "▶";
}

for (const [action, element] of [
  ["previous", elements.previous],
  ["playpause", elements.playpause],
  ["next", elements.next]
]) {
  element.addEventListener("click", () => window.roonMonitor.control(action));
}

window.roonMonitor.onState(render);
window.roonMonitor.getState().then(render);
