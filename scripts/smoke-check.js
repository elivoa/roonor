const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "src/main/main.js",
  "src/main/roon-client.js",
  "src/main/store.js",
  "src/main/lyrics-service.js",
  "scripts/prepare-electron-macos.js",
  "src/preload.js",
  "src/renderer/index.html",
  "src/renderer/renderer.js",
  "src/renderer/styles.css",
  "src/renderer/gallery.html",
  "src/renderer/gallery.js",
  "src/renderer/gallery.css",
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

console.log("Smoke check passed.");
