const crypto = require("crypto");

const LRCLIB_ROOT = "https://lrclib.net/api";
const MISSING_CACHE_MS = 24 * 60 * 60 * 1000;

function normalizedText(value) {
  return String(value || "")
    .replace(/^\s*\d+\s*[-_.:\u2013\u2014]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lyricTrackKey(playback = {}) {
  if (!normalizedText(playback.title) || playback.state === "idle") return "";
  const identity = [
    normalizedText(playback.title).toLocaleLowerCase(),
    normalizedText(playback.artist).toLocaleLowerCase(),
    normalizedText(playback.album).toLocaleLowerCase(),
    Math.round(playback.length || 0)
  ].join("|");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function parseSyncedLyrics(value) {
  const timedLines = [];
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const text = rawLine.replace(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g, "").trim();
    const timestampMatcher = /\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g;
    let timestamp;
    while ((timestamp = timestampMatcher.exec(rawLine))) {
      const time = Number(timestamp[1]) * 60 + Number(timestamp[2]);
      if (Number.isFinite(time)) {
        timedLines.push({ time, text });
      }
    }
  }
  return timedLines.sort((left, right) => left.time - right.time);
}

function plainLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cachedPayload(record) {
  if (!record) return null;
  return {
    trackKey: record.trackKey,
    status: record.status,
    source: record.source || "",
    lines: parseSyncedLyrics(record.syncedLyrics),
    plainLines: plainLines(record.plainLyrics)
  };
}

class LyricsService {
  constructor({ store, fetchImpl = global.fetch } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.pending = new Map();
  }

  trackKey(playback) {
    return lyricTrackKey(playback);
  }

  async resolve(playback = {}) {
    const trackKey = lyricTrackKey(playback);
    if (!trackKey) return { trackKey: "", status: "idle", source: "", lines: [], plainLines: [] };

    const cached = this.store?.getLyrics(trackKey);
    const staleMissing =
      cached?.status === "missing" &&
      Date.now() - new Date(cached.fetchedAt).getTime() > MISSING_CACHE_MS;
    if (cached && !staleMissing) return cachedPayload(cached);
    if (this.pending.has(trackKey)) return this.pending.get(trackKey);

    const request = this.fetchLyrics(playback, trackKey).finally(() => this.pending.delete(trackKey));
    this.pending.set(trackKey, request);
    return request;
  }

  async fetchLyrics(playback, trackKey) {
    try {
      const result = await this.findLyrics(playback);
      const syncedLyrics = result?.syncedLyrics || "";
      const plainLyrics = result?.plainLyrics || "";
      const lines = parseSyncedLyrics(syncedLyrics);
      const status = lines.length ? "synced" : plainLines(plainLyrics).length ? "plain" : "missing";
      const record = {
        trackKey,
        title: normalizedText(playback.title),
        artist: normalizedText(playback.artist),
        album: normalizedText(playback.album),
        duration: playback.length || 0,
        status,
        source: result ? "LRCLIB" : "",
        syncedLyrics,
        plainLyrics
      };
      this.store?.saveLyrics(record);
      return cachedPayload(record);
    } catch (error) {
      return { trackKey, status: "error", source: "", lines: [], plainLines: [] };
    }
  }

  async findLyrics(playback) {
    const title = normalizedText(playback.title);
    const artist = normalizedText(playback.artist);
    const album = normalizedText(playback.album);
    const duration = Math.round(playback.length || 0);

    if (title && artist && album && duration) {
      const exact = await this.request("/get", {
        track_name: title,
        artist_name: artist,
        album_name: album,
        duration
      });
      if (exact) return exact;
    }

    let results = await this.request("/search", {
      track_name: title,
      artist_name: artist,
      album_name: album
    });
    if ((!Array.isArray(results) || !results.length) && album) {
      results = await this.request("/search", {
        track_name: title,
        artist_name: artist
      });
    }
    if (!Array.isArray(results)) return null;
    const expectedTitle = title.toLocaleLowerCase();
    const expectedArtist = artist.toLocaleLowerCase();
    const matches = results.filter((candidate) => {
      const candidateTitle = normalizedText(candidate.trackName || candidate.name).toLocaleLowerCase();
      const candidateArtist = normalizedText(candidate.artistName).toLocaleLowerCase();
      return candidateTitle === expectedTitle && (!expectedArtist || candidateArtist === expectedArtist);
    });
    return matches.sort((left, right) => {
      const leftGap = duration ? Math.abs(Number(left.duration || 0) - duration) : 0;
      const rightGap = duration ? Math.abs(Number(right.duration || 0) - duration) : 0;
      return leftGap - rightGap;
    })[0] || null;
  }

  async request(endpoint, parameters) {
    const url = new URL(`${LRCLIB_ROOT}${endpoint}`);
    for (const [name, value] of Object.entries(parameters)) {
      if (value) url.searchParams.set(name, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          "User-Agent": "roon-monitor/0.1.0 (macOS desktop lyrics; https://github.com/elivoa/roonor)"
        },
        signal: controller.signal
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Lyrics request failed: ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = LyricsService;
module.exports.lyricTrackKey = lyricTrackKey;
module.exports.parseSyncedLyrics = parseSyncedLyrics;
