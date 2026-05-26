# Project Instructions

这是一个 Roon 插件项目。

该项目是运行在 Mac 端的桌面程序，会有一个桌面吉祥物作为入口。

项目使用 SQLite 数据库作为数据存储。

如果判断为复杂操作，且有值得复用的经验，记录到 AGENTS.md 中。

- Roon 官方 JavaScript API 的 Core WebSocket 端口不是固定值。即使已知 Roon Server IP（当前项目默认 192.168.11.100），也优先使用 `node-roon-api` 的 `start_discovery()` 完成发现和配对；
- 不要硬编码端口。
- `node-roon-api` 在 Node 端默认将 pairing state 相对当前工作目录保存为 `config.json`；桌面应用从 Finder/Electron 启动时工作目录并不稳定，必须通过 `set_persisted_state/get_persisted_state` 将配对状态存入应用 SQLite settings。
- 当前 `node-roon-api` 在 WebSocket 尚未 open 就连接失败时会保留失败 Core 的 `_sood_conns` 项，使之后的 discovery 回复被跳过；失败后应清除该项并通过既有 SOOD socket 重新发送 discovery 查询，不要立即 `stop_discovery()`/`start_discovery()`，否则会与异步关闭 socket 冲突。
- 播放状态通过 `RoonApiTransport.subscribe_zones()` 监听，上一首/播放暂停/下一首通过 `transport.control(zone, control)` 发送。
- 当前 Transport API 会返回 now playing 元数据和 image_key，但不直接提供同步歌词，歌词功能需要后续接入其他来源或独立解析。
- 桌面歌词通过独立透明悬浮窗显示；当前实现按曲名、歌手、专辑、时长向 `LRCLIB` 查询带时间轴歌词并缓存到 SQLite，渲染端以 Roon 播放位置同步当前行。不要把歌词误认为 Roon API 原生提供的数据。

- Spek 风格频谱图需要音频 PCM 或可解码音频文件。
- Roon 扩展 Transport API 不提供当前歌曲的原始音频流或文件内容，因此当前桌面端在接入真实采集链路之前只能显示空声谱图框架；
- 若后续要做真实频谱，需要额外接入本地音频文件路径、Roon 导出的音频来源，或系统级音频采集/解码链路。
- 频谱界面不得用元数据生成假图；真实声谱图以播放时间映射横轴，仅在收到 PCM/FFT 帧的时间范围填充 `-100 dB` 到 `-20 dB` 色谱，未收到数据的区域保持空白。
- 桌面端真实频谱当前依赖 `BlackHole` 或 `Background Music` 回环输入。不要为了系统音频采集直接改写开发态 Electron.app 并升级运行时，从而影响已授权的 Roon 扩展应用身份；后续应在正式打包 app 中配置权限与签名后再接入系统捕获。
- 真实频谱只能分析这台 Mac 实际输出或回环到输入的音频；若 Roon 播放区域输出到其他设备，本机频谱应提示静音而不是绘制假数据。
- Roon Transport API 的 `now_playing` 也不暴露源音频文件路径；界面不得伪造具体路径，真实文件位置需要后续接入本地曲库映射或其他路径来源。

- 大尺寸媒体图库不能只依赖渲染层中的封面 data URL；收到 Roon `image_key` 对应图像后，应将较高分辨率文件缓存到用户数据目录，并用 SQLite 保存图库元数据。
- Roon 的播放进度更新会频繁触发状态刷新；封面 `get_image` 必须按 `image_key` 对进行中的请求去重，并对失败请求短暂退避，避免在播放期间反复向 Core 请求同一张图。
- Roon 单张 `image_key` 的图片请求可能长期不回调；当前专辑已有磁盘缓存时应先恢复缓存封面，网络请求必须设超时释放 pending 状态后再重试，不能让一次挂起导致封面永久停在默认图。
- 仅当 Roon 封面请求超时或失败且当前专辑没有缓存时，才可按歌手与专辑精确匹配公开专辑封面作为回退，并仍按当前 `album_key` 缓存；不要在 Roon 正常提供图片时优先依赖第三方封面源。
- 真实频谱的 `MediaStream`/`AudioContext` 由主窗口持有时，独立大频谱窗口应接收主窗口转发的 PCM 频谱帧和打开瞬间的历史快照；不要在两个 renderer 中同时争抢回环输入。
- 频谱持久化按曲目 key 与时间桶存储量化后的 dB bins（SQLite `BLOB`），重播时加载已采集区段再用新的实时帧覆盖同一时间桶；不要将高频浮点帧直接序列化为大段 JSON。
- 用 PID 文件替换正在运行的桌面实例时，发送终止信号后要等待旧主进程退出，并为 SQLite 初始化设置短暂 `busy_timeout`，否则快速重启可能在数据库释放前进入无持久化状态。
- `Roon Arts` 只展示当前专辑的资源，缓存后的封面与导入的本地图片/PDF 必须关联当前 `album_key` 后再查询展示；不要回退为历史图库。
- 当前 API 没有显式 album id，专辑归组优先使用专辑名与 `image_key`，避免用 track artist 把合辑拆散。

- 主窗口采用松手触发的点击/拖动手势：未超过移动阈值的 `pointerup` 切换独立资源窗口，超过阈值则只拖动主窗口位置，不触发资源窗口开关。
- `Roon Arts` 窗口中的空白和大媒体展示区域通过指针位移手势拖动独立窗口；不要直接使用 CSS drag region 覆盖媒体，因为它会破坏图片/PDF 的双击打开交互。
