# Browser 精确优化：重新验证后的恢复里程碑

日期：2026-10-22 UTC。基线为 `6bf4a2c011f7e9aba46a7bba02b0021873d19b89`。

## 已实现与测量结果

只改变 Browser 两处 YIN 检测器：预分配连续 Float32 分析帧，减少环形索引；找到原算法需要的首个局部极小值后停止计算不会被使用的尾部。每个 lag 的累加顺序、Float32/Float64 判定语义和边界哨兵保持不变。没有降低采样率、改变 hop、缩短分析窗或换用低质量算法，也没有新增每采样分配。

新测量使用实际生成的 FxProcessor bundle，在 Node 的同一 realm 内运行五个独立 ROBOT 实例，48 kHz、立体声、128 帧块、wet=1、bypass=false。每个计时样本处理 512 块，每个 ABBA/BAAB 顺序保留基线与候选各 12 个原始样本，不删除慢样本。

| 工况 | 顺序 | 基线中位耗时 | 优化后 | 降低 |
|---|---|---:|---:|---:|
| 有声谐波 bank | ABBA | 149.524 ms | 74.053 ms | 50.47% |
| 有声谐波 bank | BAAB | 151.749 ms | 76.972 ms | 49.28% |
| 确定性噪声 bank | ABBA | 132.819 ms | 101.453 ms | 23.62% |
| 确定性噪声 bank | BAAB | 132.302 ms | 101.720 ms | 23.12% |

这些是五个处理内核的吞吐时间，不是单次音频回调、端到端延迟、完整混音图或 Chrome 的结果。两个工况不能混合成一个普适提升百分比。噪声工况测量当前 worklet 的检测与 fallback 保温，不包含外部 Signalsmith adapter。

## 音质、状态与正确性

- 新增 22 项精确性回归；目标测试 5 文件、43 项通过。
- 重新执行 `npm run build` 成功，随后完整单测 152 文件、1129 项通过。1129 是此次重新运行的总数，不是新增用例数。
- 两个新 bundle 工况分别比较每实例 131072 帧、两声道的全部 PCM bytes 与所有消息，均一致。每个工况比较 5 MiB PCM；保存了每路 SHA-256、断言结果和可复现脚本，未导出完整 PCM 音频文件。
- 有声工况各实例均有 PSOLA 事件；噪声工况 PSOLA 为 0、fallback 事件各 1。噪声正确性阶段对末 lag 进行毒化，观察到每实例 controller 506 次、LIVE detector 542 次有限值重写，证明全扫描实际发生。计时阶段不进行毒化。
- 测试同时覆盖多采样率、长音、混合输入、NaN/Infinity、偏移、重置、模式/参数变化和 scratch 毒化。unused scratch tail 允许不同，不声称完整对象所有内存逐 byte 相同。
- 48 kHz 下五实例新增约 13700 bytes 的 Float32 scratch payload，不含对象头；在构造阶段分配。算法延迟结构未改变，此次不宣称物理延迟减少。

## 优化后重新采样

候选预热后，仅包围其 16384 块运行区间采样，排除基线、加载、输入生成、正确性校验和预热。2182 个 leaf 样本中：controller YIN 25.16%，LIVE detector 20.12%，core processBlock 23.33%，LIVE process 20.07%，grain synthesis 8.02%，GC 1.60%。

YIN 仍占约 45.28%，仍有软件热点。采样比例不是性能提升测量；尚不能认定软件 P0/主要 P1 全消除、连续两轮收益收敛或整个项目已完成。

## 启动和边界

- dot 云端 Vite 启动后，首页与 worklet HTTP 200；实际服务的 worklet SHA 与新生成文件一致，验证后已停止自己的 server。
- 这不是用户本机部署。用户设备不在本次允许的执行范围内；没有检查或声称其连接状态。
- 没有真实浏览器 AudioContext 回调预算、物理音质、硬件延迟或 XRUN 验收。
- Native 实验表、原证书/PCM 和 Signalsmith 研究产物没有在这次恢复中重新验收，也没有合入新的 Native 质量策略。
- 未执行 Git push、forcepush 或 UI 覆盖。生产改动仅两份 DSP TypeScript 与生成的 worklet。

## 原始证据与复现

- `browser-main-global-ab.json`、`browser-main-global-ab-noise.json`：所有计时样本、输入和输出哈希、active/模式证明。
- `browser-main-global-profile-proof.json` 与同名 `.cpuprofile`：新运行区间及原始采样。
- `benchmark-environment.json`：运行时环境和首轮 harness/source 哈希绑定。
- `VALIDATION.json`、`browser-*.log`：重新构建与测试记录。
- `cloud-startup.json`：仅云端 HTTP 启动证据。
- `BROWSER_AB_DESIGN.md`：精确命令与工况限制。
- `STATUS.md`：原未提交产物不可见事件、历史与新验收的区分。

恢复 Git bundle 后，在安装与 lockfile 一致的依赖的环境运行：

```sh
npm ci
npm run build
npm run test:unit
node bench/experiments/benchmark_recovered_browser_yin.mjs
WORKLOAD=noise node bench/experiments/benchmark_recovered_browser_yin.mjs
PROFILE_ONLY=1 node bench/experiments/benchmark_recovered_browser_yin.mjs
```

计时应独占本工程的 CPU 测试窗口。共享云主机背景负载不受本工程控制；新机器结果不能直接当作这里的相同绝对时间。
