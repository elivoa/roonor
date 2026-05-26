const { EventEmitter } = require("events");

const DEFAULT_SERVER_HOST = "192.168.11.100";
const DISCOVERY_RETRY_DELAY_MS = 3000;
const COVER_RETRY_DELAY_MS = 5000;
const COVER_REQUEST_TIMEOUT_MS = 5000;
const FALLBACK_COVER_RETRY_DELAY_MS = 60 * 1000;
const ROON_CORE_SERVICE_ID = "00720724-5143-4a9b-abac-0e50cba674bb";

function normalizedText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function albumKeyFor({ album, artist, imageKey }) {
  if (!album && !artist && !imageKey) return "";
  if (album) return [album, imageKey || ""].join("|");
  return [artist || "", imageKey || ""].join("|");
}

class RoonClient extends EventEmitter {
  constructor({ serverHost = DEFAULT_SERVER_HOST, store = null, fetchImpl = global.fetch } = {}) {
    super();
    this.serverHost = serverHost;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.roon = null;
    this.statusService = null;
    this.core = null;
    this.transport = null;
    this.imageService = null;
    this.zones = new Map();
    this.activeZoneId = null;
    this.lastSnapshotKey = "";
    this.lastImageKey = "";
    this.lastImageDataUrl = "";
    this.lastImageContentType = "";
    this.lastImageBuffer = null;
    this.lastSavedCoverAlbumKey = "";
    this.pendingImageKeys = new Map();
    this.imageRetryUntil = new Map();
    this.cachedCoverDataUrls = new Map();
    this.pendingFallbackAlbumKeys = new Set();
    this.fallbackRetryUntil = new Map();
    this.hasDiscoveryConnectionError = false;
    this.discoveryRetryTimer = null;
    this.state = this.createState("idle", "准备连接 Roon");
  }

  start() {
    let RoonApi;
    let RoonApiStatus;
    let RoonApiTransport;
    let RoonApiImage;

    try {
      RoonApi = require("node-roon-api");
      RoonApiStatus = require("node-roon-api-status");
      RoonApiTransport = require("node-roon-api-transport");
      RoonApiImage = require("node-roon-api-image");
    } catch (error) {
      this.updateState("missing-deps", "依赖尚未安装，请先运行 npm install");
      return;
    }

    this.roon = new RoonApi({
      extension_id: "com.local.roon-monitor.mascot",
      display_name: "Roon Monitor Mascot",
      display_version: "0.1.0",
      publisher: "Local Desktop",
      email: "local@roon-monitor.invalid",
      website: "https://github.com/roonlabs/node-roon-api",
      log_level: process.env.ROON_LOG_LEVEL || "none",
      set_persisted_state: (state) => this.store?.setSetting("roon.pairedState", state || {}),
      get_persisted_state: () => this.store?.getSetting("roon.pairedState", {}) || {},
      moo_onerror: () => this.retryDiscoveryAfterConnectionError(),
      core_paired: (core) => this.handleCorePaired(core),
      core_unpaired: () => this.handleCoreUnpaired()
    });

    this.statusService = new RoonApiStatus(this.roon);
    this.roon.init_services({
      required_services: [RoonApiTransport, RoonApiImage],
      provided_services: [this.statusService]
    });

    this.statusService.set_status("Waiting for Roon authorization", false);
    this.updateState("discovering", `正在寻找 Roon Server ${this.serverHost}`);
    this.roon.start_discovery();

    setTimeout(() => {
      if (!this.core && !this.hasDiscoveryConnectionError) {
        this.updateState(
          "needs-authorization",
          "请在 Roon 设置的 Extensions 中启用 Roon Monitor Mascot"
        );
      }
    }, 5000);
  }

  control(action) {
    const zone = this.getActiveZone();
    if (!this.transport || !zone) {
      this.updateState(this.state.connection, "还没有可控制的播放区域");
      return;
    }

    const controlMap = {
      previous: "previous",
      playpause: "playpause",
      next: "next"
    };
    const roonControl = controlMap[action];
    if (!roonControl) return;

    this.transport.control(zone, roonControl, (error) => {
      if (error) {
        this.updateState(this.state.connection, `控制失败：${error}`);
      }
    });
  }

  retryDiscoveryAfterConnectionError() {
    this.hasDiscoveryConnectionError = true;
    this.updateState("connection-error", "已发现 Roon Server，扩展 API 连接失败，正在重试");
    clearTimeout(this.discoveryRetryTimer);
    this.discoveryRetryTimer = setTimeout(() => {
      if (this.core || !this.roon) return;

      // node-roon-api retains failed pre-open sockets and otherwise ignores later discovery replies.
      this.roon._sood_conns = {};
      this.roon._sood?.query({ query_service_id: ROON_CORE_SERVICE_ID });
    }, DISCOVERY_RETRY_DELAY_MS);
  }

  handleCorePaired(core) {
    clearTimeout(this.discoveryRetryTimer);
    this.hasDiscoveryConnectionError = false;
    this.core = core;
    this.transport = core.services.RoonApiTransport;
    this.imageService = core.services.RoonApiImage;
    this.statusService.set_status("Connected", false);
    this.updateState("paired", `已连接 ${core.display_name || "Roon Core"}`);

    this.transport.subscribe_zones((command, data) => {
      this.applyZoneUpdate(command, data || {});
    });
  }

  handleCoreUnpaired() {
    clearTimeout(this.discoveryRetryTimer);
    this.core = null;
    this.transport = null;
    this.imageService = null;
    this.zones.clear();
    this.activeZoneId = null;
    this.updateState("offline", "Roon 连接已断开");
  }

  applyZoneUpdate(command, data) {
    if (command === "Subscribed") {
      this.zones = new Map((data.zones || []).map((zone) => [zone.zone_id, zone]));
    }

    if (command === "Changed") {
      for (const zone of data.zones_removed || []) this.zones.delete(zone.zone_id);
      for (const zone of data.zones_added || []) this.zones.set(zone.zone_id, zone);
      for (const zone of data.zones_changed || []) this.zones.set(zone.zone_id, zone);

      for (const seekUpdate of data.zones_seek_changed || []) {
        const zone = this.zones.get(seekUpdate.zone_id);
        if (zone?.now_playing) {
          zone.now_playing.seek_position = seekUpdate.seek_position;
        }
      }
    }

    const activeZone = this.pickActiveZone();
    this.activeZoneId = activeZone?.zone_id || null;
    const snapshot = this.zoneToSnapshot(activeZone);
    this.maybeLogPlayback(snapshot);
    this.restoreCachedCover(snapshot);
    this.state = {
      connection: "paired",
      serverHost: this.serverHost,
      coreName: this.core?.display_name || "",
      message: activeZone ? "正在监听播放状态" : "已连接，等待播放区域",
      zones: Array.from(this.zones.values()).map((zone) => ({
        id: zone.zone_id,
        name: zone.display_name,
        state: zone.state
      })),
      playback: snapshot,
      controls: this.zoneToControls(activeZone)
    };
    this.emit("state", this.state);
    this.fetchCoverIfNeeded(snapshot);
  }

  pickActiveZone() {
    const zones = Array.from(this.zones.values());
    return (
      zones.find((zone) => zone.state === "playing" && zone.now_playing) ||
      zones.find((zone) => zone.now_playing) ||
      zones[0] ||
      null
    );
  }

  getActiveZone() {
    if (this.activeZoneId) return this.zones.get(this.activeZoneId);
    return this.pickActiveZone();
  }

  zoneToSnapshot(zone) {
    if (!zone) {
      return {
        state: "idle",
        title: "未检测到播放区域",
        artist: "",
        album: "",
        fileLocation: "",
        albumKey: "",
        zoneName: "",
        imageDataUrl: "",
        lyrics: ["等待 Roon 推送当前播放信息"]
      };
    }

    const nowPlaying = zone.now_playing || {};
    const threeLine = nowPlaying.three_line || {};
    const twoLine = nowPlaying.two_line || {};
    const title = threeLine.line1 || twoLine.line1 || nowPlaying.one_line?.line1 || "未播放";
    const artist = threeLine.line2 || "";
    const album = threeLine.line3 || twoLine.line2 || "";

    const imageKey = nowPlaying.image_key || "";
    return {
      zoneId: zone.zone_id,
      zoneName: zone.display_name || "",
      state: zone.state || "stopped",
      title,
      artist,
      album,
      fileLocation: "",
      albumKey: albumKeyFor({ album, artist, imageKey }),
      imageKey,
      imageDataUrl: imageKey === this.lastImageKey ? this.lastImageDataUrl : "",
      position: nowPlaying.seek_position || zone.seek_position || 0,
      length: nowPlaying.length || 0,
      lyrics: ["同步歌词接口待接入", album ? `专辑：${album}` : "Roon 已返回播放信息"]
    };
  }

  zoneToControls(zone) {
    return {
      previous: Boolean(zone?.is_previous_allowed),
      playpause: Boolean(zone?.is_pause_allowed || zone?.is_play_allowed),
      next: Boolean(zone?.is_next_allowed)
    };
  }

  maybeLogPlayback(snapshot) {
    const key = [
      snapshot.zoneId,
      snapshot.state,
      snapshot.title,
      snapshot.artist,
      snapshot.album
    ].join("|");
    if (key === this.lastSnapshotKey) return;
    this.lastSnapshotKey = key;
    this.store?.logPlayback(snapshot);
  }

  restoreCachedCover(snapshot) {
    if (!snapshot.albumKey || snapshot.imageDataUrl) return;
    if (this.cachedCoverDataUrls.has(snapshot.albumKey)) {
      snapshot.imageDataUrl = this.cachedCoverDataUrls.get(snapshot.albumKey);
      return;
    }
    const cached = this.store?.getCachedCover(snapshot.albumKey);
    if (!cached) return;
    snapshot.imageDataUrl = `data:${cached.contentType};base64,${cached.image.toString("base64")}`;
    this.cachedCoverDataUrls.set(snapshot.albumKey, snapshot.imageDataUrl);
  }

  publishCoverIfCurrent(snapshot, imageDataUrl) {
    const playback = this.state.playback || {};
    if (playback.imageKey !== snapshot.imageKey || playback.albumKey !== snapshot.albumKey) return;
    this.state = {
      ...this.state,
      playback: {
        ...playback,
        imageDataUrl
      }
    };
    this.emit("state", this.state);
  }

  async fetchFallbackCover(snapshot) {
    if (!this.fetchImpl || !snapshot.album) return null;
    const searchUrl = new URL("https://itunes.apple.com/search");
    searchUrl.searchParams.set("term", [snapshot.artist, snapshot.album].filter(Boolean).join(" "));
    searchUrl.searchParams.set("entity", "album");
    searchUrl.searchParams.set("limit", "8");
    searchUrl.searchParams.set("country", "CN");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await this.fetchImpl(searchUrl, {
        headers: {
          "User-Agent": "roon-monitor/0.1.0 (macOS artwork fallback; https://github.com/elivoa/roonor)"
        },
        signal: controller.signal
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const expectedAlbum = normalizedText(snapshot.album).toLocaleLowerCase();
      const expectedArtist = normalizedText(snapshot.artist).toLocaleLowerCase();
      const match = (payload.results || []).find((candidate) => {
        const album = normalizedText(candidate.collectionName).toLocaleLowerCase();
        const artist = normalizedText(candidate.artistName).toLocaleLowerCase();
        return album === expectedAlbum && (!expectedArtist || artist === expectedArtist);
      });
      if (!match?.artworkUrl100) return null;
      const artworkUrl = match.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb.");
      const imageResponse = await this.fetchImpl(artworkUrl, { signal: controller.signal });
      if (!imageResponse.ok) return null;
      return {
        contentType: imageResponse.headers.get("content-type") || "image/jpeg",
        image: Buffer.from(await imageResponse.arrayBuffer())
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  requestFallbackCover(snapshot) {
    if (
      !snapshot.albumKey ||
      !snapshot.album ||
      this.cachedCoverDataUrls.has(snapshot.albumKey) ||
      this.pendingFallbackAlbumKeys.has(snapshot.albumKey) ||
      (this.fallbackRetryUntil.get(snapshot.albumKey) || 0) > Date.now()
    ) {
      return;
    }

    this.pendingFallbackAlbumKeys.add(snapshot.albumKey);
    this.fetchFallbackCover(snapshot)
      .then((cover) => {
        if (!cover) {
          this.fallbackRetryUntil.set(snapshot.albumKey, Date.now() + FALLBACK_COVER_RETRY_DELAY_MS);
          return;
        }
        const imageDataUrl = `data:${cover.contentType};base64,${cover.image.toString("base64")}`;
        this.cachedCoverDataUrls.set(snapshot.albumKey, imageDataUrl);
        this.store?.saveCover(snapshot, cover.contentType, cover.image);
        this.publishCoverIfCurrent(snapshot, imageDataUrl);
        this.emit("library-changed");
      })
      .catch(() => {
        this.fallbackRetryUntil.set(snapshot.albumKey, Date.now() + FALLBACK_COVER_RETRY_DELAY_MS);
      })
      .finally(() => {
        this.pendingFallbackAlbumKeys.delete(snapshot.albumKey);
      });
  }

  fetchCoverIfNeeded(snapshot) {
    if (!snapshot.imageKey || !this.imageService) {
      return;
    }

    if (snapshot.imageKey === this.lastImageKey && this.lastImageDataUrl) {
      snapshot.imageDataUrl = this.lastImageDataUrl;
      this.publishCoverIfCurrent(snapshot, this.lastImageDataUrl);
      if (
        snapshot.albumKey &&
        snapshot.albumKey !== this.lastSavedCoverAlbumKey &&
        this.lastImageBuffer
      ) {
        this.store?.saveCover(snapshot, this.lastImageContentType, this.lastImageBuffer);
        this.lastSavedCoverAlbumKey = snapshot.albumKey;
        this.emit("library-changed");
      }
      return;
    }

    if (
      this.pendingImageKeys.has(snapshot.imageKey) ||
      (this.imageRetryUntil.get(snapshot.imageKey) || 0) > Date.now()
    ) {
      return;
    }

    const requestToken = {};
    this.pendingImageKeys.set(snapshot.imageKey, requestToken);
    const requestTimeout = setTimeout(() => {
      if (this.pendingImageKeys.get(snapshot.imageKey) !== requestToken) return;
      this.pendingImageKeys.delete(snapshot.imageKey);
      this.imageRetryUntil.set(snapshot.imageKey, Date.now() + COVER_RETRY_DELAY_MS);
      this.requestFallbackCover(snapshot);
    }, COVER_REQUEST_TIMEOUT_MS);
    this.imageService.get_image(
      snapshot.imageKey,
      { scale: "fill", width: 960, height: 960, format: "image/jpeg" },
      (error, contentType, image) => {
        clearTimeout(requestTimeout);
        if (this.pendingImageKeys.get(snapshot.imageKey) === requestToken) {
          this.pendingImageKeys.delete(snapshot.imageKey);
        }
        if (!error && image) {
          this.imageRetryUntil.delete(snapshot.imageKey);
          this.lastImageKey = snapshot.imageKey;
          this.lastImageDataUrl = `data:${contentType};base64,${image.toString("base64")}`;
          this.lastImageContentType = contentType;
          this.lastImageBuffer = image;
          snapshot.imageDataUrl = this.lastImageDataUrl;
          this.cachedCoverDataUrls.set(snapshot.albumKey, this.lastImageDataUrl);
          this.store?.saveCover(snapshot, contentType, image);
          this.lastSavedCoverAlbumKey = snapshot.albumKey;
          this.publishCoverIfCurrent(snapshot, this.lastImageDataUrl);
          this.emit("library-changed");
        } else {
          this.imageRetryUntil.set(snapshot.imageKey, Date.now() + COVER_RETRY_DELAY_MS);
          this.requestFallbackCover(snapshot);
        }
      }
    );
  }

  createState(connection, message) {
    return {
      connection,
      serverHost: this.serverHost,
      coreName: "",
      message,
      zones: [],
      playback: {
        state: "idle",
        title: "Roon Monitor",
        artist: "",
        album: "",
        fileLocation: "",
        albumKey: "",
        zoneName: "",
        imageDataUrl: "",
        lyrics: ["正在启动桌面宠物"]
      },
      controls: {
        previous: false,
        playpause: false,
        next: false
      }
    };
  }

  updateState(connection, message) {
    this.state = {
      ...this.state,
      connection,
      serverHost: this.serverHost,
      message
    };
    this.emit("state", this.state);
  }
}

module.exports = RoonClient;
