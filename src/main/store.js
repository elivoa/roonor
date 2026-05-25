const fs = require("fs");
const path = require("path");

class Store {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.dbPath = path.join(userDataPath, "roon-monitor.sqlite");
    this.db = null;
  }

  init() {
    fs.mkdirSync(this.userDataPath, { recursive: true });

    try {
      const { DatabaseSync } = require("node:sqlite");
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS playback_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          captured_at TEXT NOT NULL,
          zone_id TEXT,
          zone_name TEXT,
          state TEXT,
          title TEXT,
          artist TEXT,
          album TEXT,
          image_key TEXT
        );

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } catch (error) {
      console.warn("SQLite is unavailable in this runtime:", error.message);
    }
  }

  logPlayback(snapshot) {
    if (!this.db || !snapshot || !snapshot.title) return;

    this.db
      .prepare(`
        INSERT INTO playback_snapshots (
          captured_at,
          zone_id,
          zone_name,
          state,
          title,
          artist,
          album,
          image_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        new Date().toISOString(),
        snapshot.zoneId || null,
        snapshot.zoneName || null,
        snapshot.state || null,
        snapshot.title || null,
        snapshot.artist || null,
        snapshot.album || null,
        snapshot.imageKey || null
      );
  }
}

module.exports = Store;
