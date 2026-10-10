# R8 快速软件验收

结论：按用户降低要求后的范围通过；严格实时性能、30 分钟、硬件延迟和 Native 功能对齐未通过验收。

- HRM MANUAL HQ 配置准备峰值 15,237,344 B（14.53 MiB），保持 48 MiB 配置容量；LIVE_POLY/HQ 创建、销毁回滚、无 WASM 增长均通过。四组 HRM PCM 输出与 R7 逐字节一致。
- 默认 53 FX 配套 WASM、manifest、pin 和 90 个源码指纹匹配；实际浏览器完整图 79/79 通过。
- Native 未过滤 CTest 38/38 通过（26.78 秒）。WAV 编解码基础模块通过，Undo/Redo、Reverse、完整 Memory、主机 WAV 路由和 Bounce 仍未完成。
- 五轨立体声、轨道 EQ/Pan、输入 Dynamics/Filter、总线 Reverb/单个 LIVE_POLY Pitch（+7）和 Rhythm：墙钟 194.239 秒，有效输出 192.189 秒。计时内新增 XRUN 代理、DSP 失败、丢失输出均为 0；启动期间 4 次间隙共 512 帧，均恢复。
- 单个捕获窗口的 128 帧图处理耗时：P99 3.559 ms，P99.9 4.174 ms，Max 5.723 ms；3727 个完整片段中 514 个超过 2.667 ms 名义周期。严格实时性能未通过。这些数据不是输入到输出延迟。

本次降范围：五个独立 Pitch 实例及多轨 Delay 被 48 MiB 账本拒绝；最终负载使用一个总线 Pitch，移除轨道 Delay/Vinyl。不提高内存上限、不宣称任意 FX 组合可用。短测未触发周期 Memory/整 FX 银行替换/停启操作。原始报告状态和失败尝试保留。

详细判定见 `root-r8-quick-software-acceptance.json`，原始持续运行数据见 `root-r8-stress3-raw-summary.json`，图耗时分析见 `root-r8-quick-stress-trace.json`。源码/模块指纹见配套构建清单。硬件和 30 分钟验收仍待测。
