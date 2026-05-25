const fs = require("fs");
const path = require("path");

if (process.platform !== "darwin") process.exit(0);

const plistPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
  "Contents",
  "Info.plist"
);

if (!fs.existsSync(plistPath)) {
  throw new Error("Electron.app is missing; run npm install before starting the application.");
}

const key = "NSAudioCaptureUsageDescription";
const description = "Roon Monitor uses system audio to render a live spectrogram.";
const plist = fs.readFileSync(plistPath, "utf8");

if (!plist.includes(`<key>${key}</key>`)) {
  const marker = "\t<key>NSMicrophoneUsageDescription</key>";
  const entry = `\t<key>${key}</key>\n\t<string>${description}</string>\n`;
  if (!plist.includes(marker)) {
    throw new Error("Unable to locate the macOS usage description insertion point.");
  }
  fs.writeFileSync(plistPath, plist.replace(marker, `${entry}${marker}`));
}
