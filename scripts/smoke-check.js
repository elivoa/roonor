const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "src/main/main.js",
  "src/main/roon-client.js",
  "src/main/store.js",
  "src/preload.js",
  "src/renderer/index.html",
  "src/renderer/renderer.js",
  "src/renderer/styles.css"
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
  "src/main/store.js"
]) {
  require(path.join(root, file));
}

console.log("Smoke check passed.");
