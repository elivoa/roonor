# Roon Monitor

一个小巧的 macOS 桌面 Roon 插件原型：透明悬浮窗、桌面宠物入口、当前播放信息、专辑名称、封面、播放控制，以及 SQLite 播放快照存储。

## 运行

```sh
npm install
npm start
```

第一次运行后，需要到 Roon 的 `Settings -> Extensions` 里启用 `Roon Monitor Mascot`。

Roon Server 默认按 `192.168.11.100` 展示连接目标。Roon API 的 WebSocket 端口由 Roon 动态广播，应用会使用官方 discovery 机制寻找并配对 Core。
