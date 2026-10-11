# 2026-10-12 Browser 音频启动修复

原来 App 在挂载时自动启动 Browser 音频。没有用户手势时 AudioContext.resume() 可一直等待；initInFlight 又令重试直接返回。麦克风权限请求也没有等待上限。

现在通过 START AUDIO 点击同步调用 resume，再准备音频图；Native 仍自动启动。播放恢复等待上限 15 秒，麦克风权限等待上限 20 秒；超时显示具体错误，迟到麦克风流关闭，避免资源泄漏。

验证：3 个文件 17 项定向单元测试通过，类型检查及生产构建通过。实际 Codex 浏览器在用户允许麦克风后显示 BROWSER AUDIO READY。使用默认 Realtek 麦克风录第一轨，426240 帧 / 48000 Hz = 8.88 秒；观察 EMPTY → RECORD → PLAY → STOP → PLAY → STOP。软件诊断 underruns、command overruns、input dropout blocks、track capacity overruns 均为 0。输出从默认 VoiceMeeter Aux 改到 Realtek 扬声器，并触发输出测试音；未测物理声音或硬件延迟。

当前页面保持就绪；第一轨测试循环保留且停止，点击可再次播放，其他轨为空，THRU OFF。不提交真实录音 PCM/WAV，仅保留 UI 截图和软件诊断。
