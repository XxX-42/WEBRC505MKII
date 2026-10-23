# RC-505 最终集成证据状态（2026-10-23）

本页文档快照基于 `d824f11`。**整体 PARTIAL；最终完整回归、最终源码冻结及部署均为 PENDING。** 根任务拥有后续 `regression.json` 和最终统计；本页不使用历史累计数字充当最终门禁。

| 项目 | 当前结论 | 可审阅证据 |
|---|---|---|
| Classic UI / 软件控制 | PARTIAL；保留 80% 缩放下限，小窗口允许滚动、裁切及提示 | [UI parity](ui-parity.json)、[视觉测量](visual-measurement.json) |
| 实体 RC-505 USB / 模拟回环 | BLOCKED：设备清单未发现目标设备，未打开实体流 | [硬件门禁](hardware-in-loop.json)、[原始清单回执](hil-audio-harness-evidence.json) |
| 物理端到端延迟 | BLOCKED：没有物理测量值 | [延迟](latency.json) |
| XRUN / 回调预算 | 物理计数未知；软件 ABBA 观察到 43 次超预算，不能 PASS | [XRUN](xrun.json)、[ABBA 原始数据](software-engine-baseline/callback-abba.json) |
| 软件音频基线 | 仅旧源码 `4ef9913` 的 dry/LPF、17 类刺激、68 个渲染 | [范围与限制](golden-master-summary.json)、[带哈希回执](software-engine-baseline/receipt.json) |
| 听音评审 / Roland 音质等价 | BLOCKED：没有完成盲听评审或匹配的实体参考录音 | [Audio jury](audio-jury.json) |
| MARK SET/CLEAR | 软件预算、独立 PCM 和确认逻辑有专项覆盖；Playing 连续性修复及最终回归待完成 | [Mark](mark-validation.json) |
| MARK BACK | DISABLED；状态转移存在歧义，未虚构硬件行为 | [Mark](mark-validation.json) |
| 五轨双路径 gate / meter | 软件 ACK 和路由有专项覆盖，硬件等价未证实 | [Shared Track FX](shared-track-fx-validation.json) |
| 整体 Memory | 软件原子提交、PCM、七组 FX、恢复及失败分类有专项覆盖；新 Native E2E 尚待统一运行 | [Memory](memory-validation.json) |

## 证据口径

`PASS` 只适用于条目中列明的源码、测试和证据所证明的软件行为。它不表示最终整仓回归、全部 FX 音质、完整硬件行为或实体设备验收通过。专项数字不能相加成为最终总数。

软件 WAV 回执的 Browser 路径直接执行 production DSP core 于 Node；Native 路径执行真实回调及软件监听，但使用 fake RtAudio。它们不证明完整 BrowserAudioEngine 调度、WASAPI/MMCSS、物理延迟、实体 XRUN 或听音偏好。特效尾音被截断到刺激长度。旧快照上观察到的 43 次回调 deadline exceedance 明确阻止性能 PASS 或性能改善结论。

[新回调遥测回执](native-callback-telemetry.json) 记录 **两个模拟 CTest 目标**，源码基线为 `a456b96`。其 C++ new/new[]、delete/delete[] 跟踪及持有核心互斥量时回调仍完成的证明均有明确范围；没有覆盖 malloc、aligned allocator 或全局互斥量拦截。模拟驱动状态位不等于实体驱动计数，未知值保留为 null。

## Scoped results reported by integrator

以下为根任务传入的专项运行记录；本次文档整理未重新运行这些测试，且原始工具日志未全部随仓库提供，因此 JSON 标为 `SCOPED_RESULT_REPORTED`，不冒充最终源上的独立重跑：

- `4b9e2fa` 附近：三文件 26/26，包括 [推子 pending/readback/failure](../../tests/unit/useTrackStripState-stop.spec.ts)、[Memory 提交后 cleanup 分类](../../tests/unit/rc505-memory.spec.ts)、[Native strip 能力](../../tests/unit/native-track-strip-capabilities.spec.ts)。
- `9727f6d`（根集成 `b649416`）：Native UI hydrate 相关专项 47/47，原超时预算；见 [hydration 测试](../../tests/unit/native-memory-ui-hydration.spec.ts)。
- 早期 `291de79` 附近 agent 树：真实 Chromium [Browser Memory 集成用例](../../tests/e2e/browser-semantic-memory.spec.ts) 1/1，仅该树的专项结果。

可访问的 Native 专项原始日志另列于 [Memory](memory-validation.json) 与 [gate](shared-track-fx-validation.json)，并记录外部日志哈希。外部路径不会自动随 Git 部署。

## 最终交付仍待记录

- 最终 frozen source SHA、完整单元/浏览器/Native 门禁与失败分类由根任务写入 `regression.json`。
- [新 Native Memory E2E](../../tests/e2e/native-semantic-memory.spec.ts) 已集成 `d824f11`，截至本页证据切点尚未执行。
- 本快照仍包含 Native Playing MARK SET 的 suppressing history pin；根任务已安排连续播放修复，不能以旧测试证明修复后的最终源码。
- 生产构建、最终可运行产物、部署路径、部署哈希和运行态验证均为 PENDING。
- 旧 [UI parity 入口](../ui-parity/RC505_UI_PARITY.md) 保留原样，由根任务后续更新入口。
