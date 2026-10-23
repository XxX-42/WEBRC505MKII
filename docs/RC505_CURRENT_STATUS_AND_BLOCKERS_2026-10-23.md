# RC-505 当前进度与阻塞

更新日期：2026-10-23（Asia/Shanghai）

## Git 集成范围

- 推送前 `main`：`c4adc8970375873f28c6f137ea1369131d92aef4`。
- 推送前功能分支：`codex/native-fx-reconnect-ack-20261023`，HEAD `0b4cfa8016d3a9b0c6f5ad3ed794c0d066d1b59e`。
- 本次采用普通快进推送，不覆盖远端历史。集成范围包括 53 个官方 FX 家族实现、Classic 控制/LCD 语义、Vite 冷启动修复及 Native FX 重连 ACK 修复。

## 已完成

### 官方 FX 参数与两种运行后端

Browser、Native 控制面覆盖参数指南中的 53 个效果家族、55 个变体和 267 条手册参数行：252 条已实现，4 条为部分实时源模式支持，11 条明确不可用。实现是独立的软件 DSP/控制实现，不代表 Roland 原厂算法、音质或硬件等价。详见 [交付报告](fx-official-20261022/delivery-report-zh.md) 和 [验证汇总](fx-official-20261022/validation-summary.md)。

### Classic LCD 与硬件控制语义

Browser、Native 共用七页 Play 显示状态机和控制状态解析器。TRACK 灯与轨道选择分离；FX 应用状态与编辑焦点分离；STOP 清空采用 2000 ms；Bank 显示基于确认回读。整体判定仍为 **PARTIAL**，具体逐项证据和限制见 [UI parity dashboard](ui-parity/RC505_UI_PARITY.md)。

### Vite 冷启动

缩小 Windows 文件监听范围并显式预优化 Vue 后，原始 30 秒门限下冷启动验收 **6/6**；预算从 Vite 启动前开始计算，覆盖页面真实交互，未通过延长超时。样本最高约 18.7 秒到达 Classic 可交互。详情见 [冷启动报告](performance/20261022-vite-cold-start/README.md)。这是该 Windows 环境的观测，不是跨机器保证。

### Native 重连与 FX ACK

Native 重连改为读取并恢复宿主已确认状态，不再把空白默认槽写回运行中的宿主，也不停止或重启传输。仅对明确变更写入；ACK 必须核对 FX 类型、参数、旁路、版本及处理器状态。超时先回读、不自动重发；HTTP 409 继续作为真实失败，不予吞掉。

最新专项本地验证：Native FX 前端单元测试 **103/103**，Native ACK 与音频回调 CTest **2/2**，隔离 HTTP FX 模拟测试 **1/1**，生产构建通过。模拟桥接使用独立端口 `18755`，未启动或改动真实桥接端口 `17755`。这些结果证明软件契约和模拟宿主行为，不证明实体设备端到端通过。

## 仍未解除的阻塞与边界

- **Native 实时换 FX 类型：**宿主禁止运行中替换类型。请求会保留为 `pendingRestart` 并回读确认；需在停止状态应用，不能按成功 ACK 报告。相同类型下的参数和旁路修改可按回调应用版本确认。
- **实体设备验收：**本轮没有使用 RC-505 USB 音频或真实模拟回环，也没有验证录音内容、实体声卡 ACK、XRUN 或端到端延迟。不得将模拟输入/模拟桥接结果称为硬件验收。
- **Classic 功能仍部分对齐：**硬件 Memory、Mark 操作、逐轨共享 FX 门控、部分 Mixer/Loop/Menu 设置和 FX MOMENT 模式尚不完整；UI parity dashboard 逐项标记 PARTIAL 或未实现。
- **视觉测量：**没有做实体 LED 光度校准或透视校正后的几何测量；颜色为工程近似值，部分硬件闪烁和状态仍属 UNKNOWN。
- **完整回归口径：**FX 实现阶段的完整前端回归为 182 文件/2311 项、Native 52/52 CTest 与 HTTP 5/5；UI parity 报告记录 2397/2397 单元测试与跨多次运行累计 108 个 E2E 唯一用例通过。它们属于各自报告注明的历史验证点，不等于在最终 Native 重连补丁上重新运行了全部完整套件。最终补丁的最新验证仅为上文列出的专项测试和构建。

## 后续最高收益动作

1. 在真实 RC-505 USB 音频和可保留循环的条件下，针对 Native 重连后逐槽读取、参数应用及 ACK 做一次设备验收。
2. 决定 Native 实时 FX 类型变更的产品行为：维持明确待重启，或在用户停止传输后提供显式应用步骤；不得静默重启循环。
3. 按 [UI parity dashboard](ui-parity/RC505_UI_PARITY.md) 逐项关闭 Mark、逐轨 FX 门控和硬件 Memory 等 PARTIAL 项。
