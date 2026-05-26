const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "src/main/main.js",
  "src/main/roon-client.js",
  "src/main/store.js",
  "src/main/lyrics-service.js",
  "src/preload.js",
  "src/renderer/index.html",
  "src/renderer/renderer.js",
  "src/renderer/styles.css",
  "src/renderer/gallery.html",
  "src/renderer/gallery.js",
  "src/renderer/gallery.css",
  "src/renderer/info.html",
  "src/renderer/info.js",
  "src/renderer/info.css",
  "src/renderer/spectrum.html",
  "src/renderer/spectrum.js",
  "src/renderer/spectrum.css",
  "src/renderer/lyrics.html",
  "src/renderer/lyrics.js",
  "src/renderer/lyrics.css"
];

for (const file of requiredFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required file: ${file}`);
  }
}

for (const file of requiredFiles.filter((file) => file.endsWith(".js"))) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], {
    stdio: "inherit"
  });
}

for (const file of [
  "src/main/roon-client.js",
  "src/main/store.js",
  "src/main/lyrics-service.js"
]) {
  require(path.join(root, file));
}

const { parseSyncedLyrics } = require(path.join(root, "src/main/lyrics-service.js"));
assert.deepStrictEqual(parseSyncedLyrics("[00:02.50]Second\n[00:01.05]First"), [
  { time: 1.05, text: "First" },
  { time: 2.5, text: "Second" }
]);

const Store = require(path.join(root, "src/main/store.js"));
const spectrumStorePath = fs.mkdtempSync(path.join(os.tmpdir(), "roon-spectrum-check-"));
const spectrumStore = new Store(spectrumStorePath);
spectrumStore.init();
spectrumStore.saveCover(
  { imageKey: "cover-key", albumKey: "album-key", title: "Track", artist: "Artist", album: "Album" },
  "image/jpeg",
  Buffer.from([0xff, 0xd8, 0xff, 0xd9])
);
spectrumStore.saveSpectrumFrame("track|artist|album|180", {
  position: 1.23,
  duration: 0.08,
  sampleRate: 48000,
  bins: [-100, -70, -20]
});
spectrumStore.db?.close();
const reopenedSpectrumStore = new Store(spectrumStorePath);
reopenedSpectrumStore.init();
const storedCover = reopenedSpectrumStore.getCachedCover("album-key");
const [storedFrame] = reopenedSpectrumStore.listSpectrumFrames("track|artist|album|180");
assert.ok(storedCover);
assert.deepStrictEqual(storedCover.image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
assert.strictEqual(storedFrame.sampleRate, 48000);
assert.strictEqual(storedFrame.bins.length, 3);
assert.ok(Math.abs(storedFrame.bins[1] - -70) < 0.4);
reopenedSpectrumStore.db?.close();
fs.rmSync(spectrumStorePath, { recursive: true, force: true });

console.log("Smoke check passed.");
