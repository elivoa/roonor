# Project Instructions

这是一个 Roon 插件项目。

该项目是运行在 Mac 端的桌面程序，会有一个桌面吉祥物作为入口。

项目使用 SQLite 数据库作为数据存储。

如果判断为复杂操作，且有值得复用的经验，记录到 AGENTS.md 中。

- Roon 官方 JavaScript API 的 Core WebSocket 端口不是固定值。即使已知 Roon Server IP（当前项目默认 192.168.11.100），也优先使用 `node-roon-api` 的 `start_discovery()` 完成发现和配对；
- 不要硬编码端口。
- 播放状态通过 `RoonApiTransport.subscribe_zones()` 监听，上一首/播放暂停/下一首通过 `transport.control(zone, control)` 发送。
- 当前 Transport API 会返回 now playing 元数据和 image_key，但不直接提供同步歌词，歌词功能需要后续接入其他来源或独立解析。

- Spek 风格频谱图需要音频 PCM 或可解码音频文件。
- Roon 扩展 Transport API 不提供当前歌曲的原始音频流或文件内容，因此当前桌面端只能先做基于歌曲元数据的稳定视觉频谱；
- 若后续要做真实频谱，需要额外接入本地音频文件路径、Roon 导出的音频来源，或系统级音频采集/解码链路。
