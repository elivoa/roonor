# Roon Monitor

一个小巧的 macOS 桌面 Roon 插件原型：透明悬浮窗、桌面宠物入口、当前播放信息、专辑名称、封面、播放控制，以及 SQLite 播放快照存储。

点击左侧当前封面可打开 `Roon Arts` 媒体窗口。该窗口只显示当前专辑的封面及为当前专辑添加的本地图片和 PDF；支持横向滑动浏览、双击通过 macOS 打开原文件，并自动记住窗口位置和尺寸。

## 运行

```sh
npm install
npm start
```

第一次运行后，需要到 Roon 的 `Settings -> Extensions` 里启用 `Roon Monitor Mascot`。

Roon Server 默认按 `192.168.11.100` 展示连接目标。Roon API 的 WebSocket 端口由 Roon 动态广播，应用会使用官方 discovery 机制寻找并配对 Core；Roon 配对状态会持久化到本地 SQLite，重新打开桌面程序后无需依赖启动目录中的临时配置文件。

若窗口显示“已发现 Roon Server，但无法连接扩展 API”，表示 Core 已回应 discovery，但它动态广播出的扩展 API TCP 端口当前从本机不可达；此时扩展不会出现在 Roon 列表中，需要恢复 Core 与本机之间的新 TCP 连接后重新启动插件。

## 桌面歌词

主窗口中的“词”按钮用于显示或隐藏独立歌词悬浮窗。歌词窗为透明背景，可单独拖动、调整尺寸并记住位置；匹配到带时间戳的歌词后会随 Roon 播放进度同步切换当前行。由于 Roon Transport API 不直接提供歌词，程序会用当前歌曲的曲名、歌手、专辑与时长向 `LRCLIB` 查询歌词，并将结果缓存在本地 SQLite 数据库中。

## 实时频谱

右侧频谱视图使用 Spek 风格坐标与 `-100 dB` 到 `-20 dB` 色标，只绘制已捕获到的实时音频时间段。在 macOS 14.2 以上与 Electron 39 运行时，应用优先采集本机系统输出音频；系统采集不可用时，再降级选择 `BlackHole` 或 `Background Music` 回环输入。首次进行系统音频捕获时需要允许 macOS 的系统音频录制权限。Roon 的声音必须实际从这台 Mac 播放，远端 Roon 输出区域不会被本机捕获。
