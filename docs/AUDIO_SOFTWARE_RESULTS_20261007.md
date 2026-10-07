# WebRC505 软件音频核验 — 2026-10-07

用户已取消本次硬件测试，按软件范围交付。以下结果不能证明声卡端到端延迟、物理叠录对齐、30 分钟硬件 XRUN 或乐器级验收。Dashboard 的硬件状态保持 `NOT_VERIFIED`。

## 已更新的旧实现

| 原实现或问题 | 当前实现 |
|---|---|
| 主线程 ScriptProcessor 4096 帧叠录 | 五轨录音、播放、叠录统一使用持久 AudioWorklet；4096 帧在 48 kHz 下仅一个处理块就覆盖 85.33 ms，这个换算不是旧系统的实测 RTL |
| Transport 25 ms 定时轮询 | Worklet 64 位采样帧计数、指定目标帧和执行 ACK；主线程发送操作意图 |
| 逐圈创建播放节点、拼接录音缓冲 | 预分配共享轨道存储，采样指针循环读写 |
| 原生 Record/Clear 清空整段存储 | 仅重置有效长度和状态，操作不再随最大轨道长度增长 |
| Filter UI 0–100 被当成 0–1 | UI 边界归一化；实际声音输出验证参数变化 |
| 监听关闭仍有输入直通 | Worklet 采样边界门控独立监听输出 |
| 切换设备后使用旧校准 | 校准按实际输入/输出设备、图采样率和输入格式匹配 |
| 将浏览器提示值、软件路由校准称为物理延迟 | 物理值、驱动报告、提示值、软件诊断和未知值分开；软件校准不进入 physicalRoundTripMs |

实时主基线为 48 kHz / 128 帧。每块采样时间为 2.667 ms，**不是系统延迟**。96 kHz 实时模式保持关闭。轨道当前录成单声道（左右输入平均），播放复制到双声道；每轨预留 180 秒，五轨样本存储约 172.8 MB。

## 软件链和算法实测

Chromium 149 的真实项目软件链使用合成输入和静音软件输出，验证五轨录放、叠录改写、Clear、监听开关、Filter 量纲和输入切换后校准失效。Monitor ON RMS 约 0.0506，OFF 为 0；这些值是软件 tap 的结果。UI 自动化另使用 mocks。

下表是实际 FX 类在 48 kHz OfflineAudioContext 中的脉冲结果，每项五次；数值为各次结果的中位数，单位 ms。阈值和具体参数见原始 benchmark。

| 场景 | 首次到达 | 峰值位置 | 尾音结束 |
|---|---:|---:|---:|
| Filter | 0 | 0.042 | 1.104 |
| Compressor | 6 | 6 | 6 |
| Delay，300 ms、全湿、反馈 40% | 300 | 300.063 | 3025.563 |
| Reverb，2 秒 IR、全湿 | 0 | 1.771 | 1979.729 |
| Phaser | 0 | 0 | 3.271 |
| Slicer，固定输入时刻与相位 | 0 | 0 | 0 |
| 完整 FXChain，Delay/Reverb 混合 45% | 6 | 6.042 | 2425.938 |

Compressor 的额外 6 ms 属于算法延迟；Delay 的 300 ms 是全湿设定，混合干声时首次到达不同；Reverb 尾音不是系统延迟。Slicer 为相位相关门控，上表仅代表所测相位。离线渲染耗时既不是实时 callback 耗时，也不是音频延迟。

独立统一 FX 报告包含 44.1/48/96 kHz 的 21 个场景、105 次渲染，可导入 Dashboard。96 kHz 离线成功不构成实时模式启用资格。

## Worklet 采样相位与执行耗时

真实 processor 源码在 Node/V8 合成宿主执行 675,000 次 `process()`，覆盖 86,400,000 帧，即 1,800 秒采样时间；实际墙钟 82.665 秒。五轨使用 127/131/137/139/149 帧的非整块循环，逐块验证相位 3,375,000 次；64 位帧计数检查 675,000 次，并跨越一次低 32 位回绕。帧计数错误和最大采样相位漂移均为 0。

这轮 `process()` 耗时 P50/P95/P99/Max 为 **0.0149 / 0.0340 / 0.0451 / 10.8498 ms**。累计包围调用的墙钟耗时 12.432 秒，不是 OS CPU time。合成宿主 deadline miss 为 **17**；软件 underrun、input dropout 和 command overrun 为 0。它不是 Chromium callback 测量，也不能作为硬件 XRUN=0 或连续 30 分钟实机稳定性的证据。

原生 300 秒存储的 Record/Clear 基准各测 101 次。P99 从约 2.395/2.590 ms 降到约 0.0001 ms；后值位于 0.1 μs 计时分辨率附近，不表示操作耗时为零。它只验证移除了整段清空的成本，没有推算物理延迟。

## 复跑和验证

```powershell
npm run build
npm run test:unit
npm run test:e2e
npm run audio:smoke:browser
npm run audio:benchmark:software
npm run audio:benchmark:worklet -- --phase-minutes 30 --phase-yield-blocks 256 --phase-yield-ms 20
npm run native:verify
```

本次构建、类型检查、31/31 单元测试、3/3 UI E2E 和原生 CTest 1/1 通过。浏览器软件链 smoke 通过。原始 FX、Worklet 和原生性能数据保留在本机 TEMP 的 `webrc-*` 目录；统一软件报告保存在 `docs/measurements/`。验收定义见 [INSTRUMENT_GRADE_AUDIO.md](INSTRUMENT_GRADE_AUDIO.md)。
