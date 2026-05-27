const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

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
      this.db.exec("PRAGMA busy_timeout = 3000;");
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

        CREATE TABLE IF NOT EXISTS media_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_key TEXT NOT NULL UNIQUE,
          album_key TEXT NOT NULL DEFAULT '',
          file_path TEXT NOT NULL,
          media_type TEXT NOT NULL,
          title TEXT,
          artist TEXT,
          album TEXT,
          added_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS lyrics_cache (
          track_key TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          artist TEXT,
          album TEXT,
          duration INTEGER,
          status TEXT NOT NULL,
          source TEXT,
          synced_lyrics TEXT,
          plain_lyrics TEXT,
          fetched_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS spectrum_frames (
          track_key TEXT NOT NULL,
          bucket INTEGER NOT NULL,
          position REAL NOT NULL,
          frame_duration REAL NOT NULL,
          sample_rate INTEGER NOT NULL,
          bins BLOB NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (track_key, bucket)
        );
      `);
      this.ensureColumn("media_items", "album_key", "TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      console.warn("SQLite is unavailable in this runtime:", error.message);
      this.db?.close();
      this.db = null;
    }
  }

  ensureColumn(tableName, columnName, columnDefinition) {
    if (!this.db) return;
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (columns.some((column) => column.name === columnName)) return;
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
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

  saveCover(snapshot, contentType, image) {
    if (!this.db || !snapshot?.imageKey || !snapshot.albumKey || !image) return null;

    const extension = contentType === "image/png" ? "png" : "jpg";
    const sourceImageKey = snapshot.coverImageKey || snapshot.imageKey;
    const fileName = `${crypto.createHash("sha256").update(sourceImageKey).digest("hex")}.${extension}`;
    const coverDirectory = path.join(this.userDataPath, "media", "covers");
    const filePath = path.join(coverDirectory, fileName);
    fs.mkdirSync(coverDirectory, { recursive: true });
    fs.writeFileSync(filePath, image);

    this.upsertMediaItem({
      sourceKey: `roon-cover:${snapshot.albumKey}:${sourceImageKey}`,
      albumKey: snapshot.albumKey,
      filePath,
      mediaType: "image",
      title: snapshot.title || "Album cover",
      artist: snapshot.artist || "",
      album: snapshot.album || ""
    });

    return filePath;
  }

  getCachedCover(albumKey) {
    if (!this.db || !albumKey) return null;
    const row = this.db
      .prepare(`
        SELECT file_path
        FROM media_items
        WHERE album_key = ? AND media_type = 'image' AND source_key LIKE 'roon-cover:%'
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(albumKey);
    if (!row || !fs.existsSync(row.file_path)) return null;

    return {
      contentType: path.extname(row.file_path).toLowerCase() === ".png" ? "image/png" : "image/jpeg",
      image: fs.readFileSync(row.file_path)
    };
  }

  addMediaFiles(filePaths, albumKey, context = {}) {
    if (!albumKey) return this.listMediaItems(albumKey);

    for (const filePath of filePaths) {
      const extension = path.extname(filePath).toLowerCase();
      const mediaType = extension === ".pdf" ? "pdf" : "image";
      this.upsertMediaItem({
        sourceKey: `local:${albumKey}:${path.resolve(filePath)}`,
        albumKey,
        filePath: path.resolve(filePath),
        mediaType,
        title: path.basename(filePath, extension),
        artist: context.artist || "",
        album: context.album || ""
      });
    }

    return this.listMediaItems(albumKey);
  }

  upsertMediaItem({ sourceKey, albumKey, filePath, mediaType, title, artist, album }) {
    if (!this.db) return;
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO media_items (
          source_key,
          album_key,
          file_path,
          media_type,
          title,
          artist,
          album,
          added_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          album_key = excluded.album_key,
          file_path = excluded.file_path,
          media_type = excluded.media_type,
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          updated_at = excluded.updated_at
      `)
      .run(sourceKey, albumKey || "", filePath, mediaType, title, artist, album, now, now);
  }

  listMediaItems(albumKey) {
    if (!this.db || !albumKey) return [];

    return this.db
      .prepare(`
        SELECT id, source_key, album_key, file_path, media_type, title, artist, album, updated_at
        FROM media_items
        WHERE album_key = ?
        ORDER BY updated_at DESC
      `)
      .all(albumKey)
      .filter((item) => fs.existsSync(item.file_path))
      .map((item) => ({
        id: item.id,
        sourceKey: item.source_key,
        albumKey: item.album_key,
        filePath: item.file_path,
        fileUrl: pathToFileURL(item.file_path).href,
        mediaType: item.media_type,
        title: item.title,
        artist: item.artist,
        album: item.album,
        updatedAt: item.updated_at
      }));
  }

  hasMediaFile(filePath, albumKey) {
    if (!this.db || !filePath || !albumKey) return false;
    return Boolean(
      this.db
        .prepare("SELECT id FROM media_items WHERE file_path = ? AND album_key = ? LIMIT 1")
        .get(path.resolve(filePath), albumKey)
    );
  }

  getLyrics(trackKey) {
    if (!this.db || !trackKey) return null;
    const row = this.db
      .prepare(`
        SELECT track_key, title, artist, album, duration, status, source,
               synced_lyrics, plain_lyrics, fetched_at
        FROM lyrics_cache
        WHERE track_key = ?
      `)
      .get(trackKey);
    if (!row) return null;

    return {
      trackKey: row.track_key,
      title: row.title,
      artist: row.artist,
      album: row.album,
      duration: row.duration,
      status: row.status,
      source: row.source,
      syncedLyrics: row.synced_lyrics || "",
      plainLyrics: row.plain_lyrics || "",
      fetchedAt: row.fetched_at
    };
  }

  saveLyrics({ trackKey, title, artist, album, duration, status, source, syncedLyrics, plainLyrics }) {
    if (!this.db || !trackKey || !title) return;
    const fetchedAt = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO lyrics_cache (
          track_key, title, artist, album, duration, status, source,
          synced_lyrics, plain_lyrics, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_key) DO UPDATE SET
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          duration = excluded.duration,
          status = excluded.status,
          source = excluded.source,
          synced_lyrics = excluded.synced_lyrics,
          plain_lyrics = excluded.plain_lyrics,
          fetched_at = excluded.fetched_at
      `)
      .run(
        trackKey,
        title,
        artist || "",
        album || "",
        Number.isFinite(duration) ? Math.round(duration) : 0,
        status,
        source || "",
        syncedLyrics || "",
        plainLyrics || "",
        fetchedAt
      );
  }

  saveSpectrumFrame(trackKey, frame) {
    this.saveSpectrumFrames(trackKey, [frame]);
  }

  saveSpectrumFrames(trackKey, frames) {
    if (!this.db || !trackKey || !Array.isArray(frames) || !frames.length) return;
    const writeFrame = this.db.prepare(`
      INSERT INTO spectrum_frames (
        track_key, bucket, position, frame_duration, sample_rate, bins, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key, bucket) DO UPDATE SET
        position = excluded.position,
        frame_duration = excluded.frame_duration,
        sample_rate = excluded.sample_rate,
        bins = excluded.bins,
        updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const frame of frames) {
        this.writeSpectrumFrame(writeFrame, trackKey, frame);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  writeSpectrumFrame(writeFrame, trackKey, frame) {
    if (!frame || !Array.isArray(frame.bins)) return;
    const position = Number(frame.position);
    if (!Number.isFinite(position)) return;

    const bucket = Math.max(0, Math.floor(position * 10));
    const bins = Buffer.from(Uint8Array.from(frame.bins, (value) => {
      const db = Number.isFinite(value) ? Math.max(-100, Math.min(-20, value)) : -100;
      return Math.round(((db + 100) / 80) * 255);
    }));
    writeFrame.run(
      trackKey,
      bucket,
      position,
      Number.isFinite(frame.duration) ? frame.duration : 0.1,
      Number.isFinite(frame.sampleRate) ? Math.round(frame.sampleRate) : 48000,
      bins,
      new Date().toISOString()
    );
  }

  listSpectrumFrames(trackKey) {
    if (!this.db || !trackKey) return [];
    return this.db
      .prepare(`
        SELECT position, frame_duration, sample_rate, bins
        FROM spectrum_frames
        WHERE track_key = ?
        ORDER BY bucket ASC
      `)
      .all(trackKey)
      .map((row) => ({
        trackKey,
        position: row.position,
        duration: row.frame_duration,
        sampleRate: row.sample_rate,
        bins: Array.from(row.bins, (value) => -100 + (value / 255) * 80)
      }));
  }

  setSetting(key, value) {
    if (!this.db) return;
    const serialized = JSON.stringify(value);
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(key, serialized, now);
  }

  getSetting(key, fallbackValue) {
    if (!this.db) return fallbackValue;
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return fallbackValue;

    try {
      return JSON.parse(row.value);
    } catch (error) {
      return fallbackValue;
    }
  }
}

module.exports = Store;
