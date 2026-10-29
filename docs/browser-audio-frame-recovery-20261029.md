# Browser AudioContext 帧坐标复测

日期：2026-10-29

源快照：`9dff9ef4790fba344fc585dcd41e11798d09b47b`

Chromium：Playwright Chromium `145.0.7632.6`

工作树分支：`codex/browser-audio-frame-recovery-20261029`

## 结果

在指定快照上运行 100 次 suspend/resume 的低扰动探针。探针用 997 Hz 合成振荡器作非静音输入，不请求麦克风，也不使用物理输出。独立 AudioWorklet 哨兵和生产输入采集 worklet 各处理 654 个回调，全部 654 个生产输入回调均为非静音。两者在相同位置观察到一段 `+128` 帧前跳（约 2.90 ms，44.1 kHz）：前一块从 frame 33792 开始，长度 128；下一块从 frame 34048 开始。分类为 `SHARED_CONTEXT_TIMELINE_DISCONTINUITY`。

三次先前的 100-cycle Chromium 探针还观察到重复坐标 `-128` 紧接 `+128` 的组合。它们使用的生产 worklet 源 SHA-1 与本快照相同：`c014bb969e27e1abfc7b96704639b0a93c8fdd0a`。这表明异常并非只发生在采集节点；上下文中的独立 worklet 也看到了相同时间线跳变。

复现命令：

```powershell
node bench/run_browser_suspend_resume_frame_sentinel.mjs --cycles 100 --output <output.json>
```

## 安全处理与限制

当回调坐标重叠时，生产采集器只接受坐标中可证明的新后缀；若整块坐标已被覆盖，则整块不进入预滚环。随后检测到的前跳会使预滚就绪状态失效，并拒绝跨越缺口的录音。只有连续的真实输入帧重新填满预滚后，采集才重新就绪。对应逻辑位于 `public/worklets/browser-input-capture.js` 的 `process()`，现有单测覆盖“重复坐标但 PCM 已改变、随后跳过一个量子”的拒绝和重新预热场景。

重复的帧坐标可以伴随不同 PCM，因此无法证明这些样本应映射到哪个绝对帧。把它们重新编号、把后续 PCM 挪到缺失区间，或放宽帧连续性检查，都会制造没有证据的帧对应关系并可能接受错位录音。本次没有可靠的应用层修复；持续录音中断后只能保留拒绝行为、重新预热并作为新录音重试。若要消除根因，需要浏览器提供连续、可信的 AudioContext 帧时间线，或提供与录音边界精确映射的另一时钟。

此探针只证明本机该 Chromium 版本和合成输入配置下的软件观察，不定位 Chromium 内部原因，也不证明真实麦克风、物理设备 XRUN、可听输出或其他浏览器的表现。Web Audio API 规范说明 `currentTime` 在上下文处于 running 时单调递增并按渲染量子更新；探针观察到的 resume 附近跳变仍需作为浏览器行为异常处理，不能据此推断硬件丢帧。[Web Audio API 1.1](https://webaudio.github.io/web-audio-api/)

## 验证

- `tests/unit/browser-input-capture.spec.ts`：27/27 通过。
- Chromium sentinel：100 cycles 完成，`SHARED_CONTEXT_TIMELINE_DISCONTINUITY`。
- 未修改生产逻辑、量化检查或 PCM 保护；未将原始 sentinel JSON 纳入提交。
