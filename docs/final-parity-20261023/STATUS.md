# RC-505 最终集成证据状态（2026-10-24）

> 本页保留 2026-10-24 的历史快照。后续 Browser AutoRec／Bounce 和 Native REC ACTION 集成的当前状态见 [2026-10-28 进度](../rc505-progress-20261028.md)。

文档快照基于最终已验证 UI 源 `9e48f39`、Native host 修复 `676eb21` 与最终报告提交。**软件交付仍为 PARTIAL。** 单测、生产构建、Native 仿真门禁及一次真实本地 Browser 虚拟输入 smoke 通过；完整 E2E 本轮为 85/112，另有性能、启动、硬件与部分软件 provider 缺口。详细状态见[最终回归回执](regression.json)与[Native 验证回执](native-verification.json)。

| 项目 | 当前结论 | 证据 |
|---|---|---|
| Release 完整 unit | PASS：210 文件，2530/2530，0 skip；最终 CSS/导航/LCD/FX EDIT 修改之后执行 | [原始 JSON](C:/Users/user1000/.codex/scratch/rc505-final-unit-release.json)、[日志](C:/Users/user1000/.codex/scratch/rc505-final-unit-release.log)、[UI 报告](ui-parity.json) |
| 生产 build | PASS：Vite 11.12 秒；许可证文件核对 6/6 | [构建日志](C:/Users/user1000/.codex/scratch/rc505-final-production-build.log)、[Memory 报告中的哈希](memory-validation.json) |
| Native 软件验证 | PASS（分范围）：便携 CTest 56/56；host MIME 修复之后 root HQ 仿真 CTest 12/12；真实 WASAPI 目标重建成功 | [根任务 Native 回执](native-verification.json) |
| Native 本地运行验收 | LOCAL_DEPLOY_BLOCKED：实际 WASAPI 后台启动被工具自动审批策略阻止，未给出细因；未绕过 | [硬件/本地边界](hardware-in-loop.json) |
| Browser 本地服务 | 5173 实际部署虚拟输入 smoke PASS：七页、立体声录放叠录停止、Mark SET/CLEAR | [截图及回执](../ui-parity/visual/local-smoke/receipt.json) |
| 新 4 项 E2E / 完整 112 项 E2E | 新增 4/4 PASS；完整套件 85/112 PASS、27 unexpected，0 skip/retry；未达整体绿色门禁 | [最终回归回执](regression.json)、本机原始 JSON `C:/Users/user1000/.codex/scratch/rc505-final-full-e2e.json` |
| 实体 RC-505 USB / 模拟回环 | BLOCKED：设备清单未发现目标设备，未打开实体流 | [硬件门禁](hardware-in-loop.json)、[原始清单](hil-audio-harness-evidence.json) |
| 延迟 / XRUN / 回调预算 | 物理值未知；旧软件 ABBA 有 43 次超预算，不能 PASS；最终 ABBA 未运行 | [延迟](latency.json)、[XRUN](xrun.json) |
| 软件音频基线 | 历史 68 个渲染仅覆盖旧源码 `4ef9913` 的 dry/LPF、17 类刺激；最终重建 probe 尚无新渲染结果 | [范围与哈希](golden-master-summary.json)、[旧回执](software-engine-baseline/receipt.json) |
| 听音评审 / Roland 音质等价 | BLOCKED：未完成盲听评审或匹配的实体参考录音 | [Audio jury](audio-jury.json) |
| MARK SET/CLEAR | 软件预算、独立 PCM、确认及 Playing 连续性专项已验证；`c6d5d98` 已修复只读 pin | [Mark](mark-validation.json)、[连续性回执](native-mark-readonly-pin.json) |
| MARK BACK | DISABLED；状态转移存在歧义，未虚构硬件行为 | [Mark](mark-validation.json) |
| 五轨双路径 gate / meter、整体 Memory | 软件 ACK、PCM、七组 FX、原子提交、恢复及失败分类有专项；新增 E2E 及本地 Browser smoke 覆盖；全套 E2E 仍未绿 | [Shared Track FX](shared-track-fx-validation.json)、[Memory](memory-validation.json)、[回归回执](regression.json) |
| 视觉 / 硬件光度 | 新截图两尺寸独立复核无新高项；几何/光度仍 PARTIAL / UNMEASURED | [视觉测量](visual-measurement.json)、[三项外观修复截图](../ui-parity/visual/p1-known-three/README.md) |

## 已完成的软件修复与剩余 provider

PAN/THRU 绑定已实现于 `69fd105`；Memory busy 时陈旧 LCD 写入保护已实现于 `b46fb7b`。`c6d5d98` 的 MARK 只读 pin 允许 Playing 正常渲染，同时继续阻挡写入命令；历史 restore 的独占 pin 仍保留抑制策略。这些已完成项不再标作等待实现。

**此集成分支尚未包含后续独立工作树中的 Native REC→PLAY/DUB 与 Browser AutoRec WIP；它们未编译/完整验证，因此不纳入本次推送。** Native recording quantize、AutoRec、Bounce 与独立物理端口 routing provider 仍缺失或禁用。实体 USB/audio/MIDI、物理状态转移、准确 LED/闪烁与 Roland 算法或音质等价也未验证。

## 性能与证据口径

最终软件 probe 已重建，二进制 SHA-256 为 `c7378d0a5d97ca6bc7b2b1011589394663bc5caac80bdc8832bcb9b36483489c`；[新 manifest](C:/Users/user1000/.codex/scratch/rc505-final-software-probe-build/native-probe-build.json) 仅证明构建产物。**最终 68 渲染和 ABBA 尚未运行。** 不覆盖历史 [build manifest](software-engine-baseline/native-probe-build.json)、[WAV 哈希回执](software-engine-baseline/receipt.json) 或 [ABBA 数据](software-engine-baseline/callback-abba.json)。

历史 Browser WAV 路径直接在 Node 执行 production DSP core；Native 执行真实回调及软件监听，但使用 fake RtAudio。它们不证明完整 BrowserAudioEngine 调度、WASAPI/MMCSS、物理延迟、实体 XRUN 或听音偏好。尾音被截断至刺激长度。旧 80,000 次测量回调的 43 次 deadline exceedance 明确阻止性能 PASS 或性能改善结论。

[遥测回执](native-callback-telemetry.json) 的两个模拟 CTest 目标与 [Mark 连续性回执](native-mark-readonly-pin.json) 均为有范围的软件证据。C++ new/new[]、delete/delete[] 跟踪和持有核心互斥量时回调完成，不等于覆盖 malloc、aligned allocator 或全局互斥量。模拟驱动状态位不等于实体驱动计数，未知值保留为 null。

`PASS` 仅适用于条目指定的源码、测试和证据。历史专项数字不能相加成为最终总数；Native 构建成功也不能替代尚被策略阻止的本地运行验收。

## Scoped results reported by integrator

以下历史专项记录保留，不替代上面的 release unit 或后续完整 E2E；原始工具日志未全部随仓库提供，因此相关 JSON 保留 `SCOPED_RESULT_REPORTED`：

- `4b9e2fa` 附近三文件 26/26：[推子异步行为](../../tests/unit/useTrackStripState-stop.spec.ts)、[Memory cleanup 分类](../../tests/unit/rc505-memory.spec.ts)、[Native strip 能力](../../tests/unit/native-track-strip-capabilities.spec.ts)。
- `9727f6d`（根集成 `b649416`）Native UI hydrate 相关专项 47/47，原超时预算：[测试](../../tests/unit/native-memory-ui-hydration.spec.ts)。
- 早期 `291de79` 附近 agent 树真实 Chromium [Browser Memory](../../tests/e2e/browser-semantic-memory.spec.ts) 1/1，仅该树专项。

Native ACK 缓存专项原始日志与哈希仍见 [Memory](memory-validation.json) 和 [gate](shared-track-fx-validation.json)。外部日志路径不会自动随 Git 部署。

## 最终待补录

性能/最终冷启动数据尚未复测。完整 E2E 有 27 个未通过用例，需继续排查；本轮不将其标为 PASS。Browser 虚拟输入成功不等于硬件回环；Native 实际启动被工具自动审批阻止，也不得绕过或报告为通过。

旧 [UI parity 入口](../ui-parity/RC505_UI_PARITY.md) 保留原样，由根任务维护入口。
