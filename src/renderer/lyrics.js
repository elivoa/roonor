const elements = {
  shell: document.querySelector("#lyrics-float"),
  before: document.querySelector("#before"),
  current: document.querySelector("#current"),
  after: document.querySelector("#after"),
  hide: document.querySelector("#hide")
};

let playback = null;
let receivedAt = performance.now();
let lastLineIndex = -2;
let lastMessage = "";

function currentPosition() {
  if (!playback) return 0;
  const position = playback.position || 0;
  if (playback.state !== "playing") return position;
  return position + (performance.now() - receivedAt) / 1000;
}

function setMessage(message, mode = "message") {
  if (lastMessage === message && lastLineIndex === -1) return;
  lastMessage = message;
  lastLineIndex = -1;
  elements.shell.className = `lyrics-float ${mode}`;
  elements.before.textContent = "";
  elements.current.textContent = message;
  elements.after.textContent = "";
}

function showSynced(lines) {
  const position = currentPosition();
  let lineIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].time <= position + 0.05) lineIndex = index;
    else break;
  }
  if (lineIndex === lastLineIndex) return;
  lastLineIndex = lineIndex;
  lastMessage = "";
  elements.shell.className = "lyrics-float synced";
  elements.before.textContent = lineIndex > 0 ? lines[lineIndex - 1].text : "";
  elements.current.textContent = lineIndex >= 0 ? lines[lineIndex].text || " " : " ";
  elements.after.textContent =
    lines[lineIndex + 1]?.text || (lineIndex < 0 ? lines[0]?.text || "" : "");
}

function renderFrame() {
  const lyrics = playback?.lyricData || {};
  if (!playback || playback.state === "idle") {
    setMessage("等待播放", "waiting");
  } else if (lyrics.status === "loading") {
    setMessage("正在获取歌词");
  } else if (lyrics.status === "synced" && lyrics.lines?.length) {
    showSynced(lyrics.lines);
  } else if (lyrics.status === "plain" && lyrics.plainLines?.length) {
    setMessage(lyrics.plainLines[0]);
    elements.after.textContent = lyrics.plainLines[1] || "";
  } else if (lyrics.status === "error") {
    setMessage("歌词连接暂不可用");
  } else {
    setMessage("未找到歌词");
  }
  requestAnimationFrame(renderFrame);
}

function receiveState(state) {
  playback = state.playback || null;
  receivedAt = performance.now();
  lastLineIndex = -2;
  lastMessage = "";
}

elements.hide.addEventListener("click", () => window.roonMonitor.hideLyrics());
window.roonMonitor.onState(receiveState);
window.roonMonitor.getState().then(receiveState);
requestAnimationFrame(renderFrame);
