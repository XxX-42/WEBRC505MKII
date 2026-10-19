# RC-505mkII 面板 UI 验证（2026-10-19）

首轮复刻基线：`b455a76`；本轮续修起点：`85c24a8`。本目录保存 Browser／Native Classic 面板验收截图和运行记录。

## 视觉记录

- [1920×1080 整机](replica-1920.png)与[LCD](lcd-1920.png)。
- [1366×768 整机](replica-1366.png)与[LCD](lcd-1366.png)。该高度下按最低 80% 缩放并显示窗口过窄／过矮提示；面板保留滚动，底部控制需滚动查看。
- [1920×1080 LCD 编辑页](lcd-editor-1920.png)，用于查看节奏参数页留在固定比例屏幕内的效果。
- [真实 Native WASAPI 页面](native-live-bridge-1920.png)、[Native LCD](native-live-lcd-1920.png)和[读取状态](native-live-bridge.json)。实际本机桥接报告 `NATIVE AUDIO READY`、5 个循环轨及输入／Track A–D 能力；该检查只读，没有向真实 Native 写入命令。
- [录音](browser-recording-glow.png)、[播放](browser-playing-glow.png)、[叠录](browser-overdub-glow.png)和[录制结果](browser-recorded.png)截图，以及[Browser 虚拟输入记录](browser-runtime.json)。

## 2026-10-19 可读性续修

- 提高 Classic 禁用按钮、旋钮、推子帽和 STOP 键的可辨识度，保持原有 disabled 语义及操作行为。
- LCD 编辑页移除重复页名，把空间还给参数；放大字段文字，并把节奏音量项简写为 `VOLUME`。
- 首页参数行改用 `RHY VOL`、`IN FX`、`TR FX`，避免 80% 缩放时换行覆盖。上方整机与 LCD 截图已更新。
- 新增 1366×768 参数行的完整性／溢出检查和编辑页字段标题检查。

## 验收结果

- `npm run build`：通过，包含 `vue-tsc -b`、AudioWorklet bundle、Vite build 和第三方许可文件核验。Vite 报告现有大于 500 kB 的 JS chunk；Browserslist/Baseline 数据提示过期，均为非阻断警告。
- Playwright Classic／LCD／Browser／Native 定向回归：10/10 通过。包括 41 个按钮、7 个旋钮、5 个推子，1920×1080／1366×768／窄窗口，LCD 内 MENU／LOOP／RHYTHM／FX 操作，Browser 虚拟输入录音→停止→播放→叠录→停止，STOP 长按取消与 1500 ms 清空，以及真实 Native 页面就绪状态。
- 本轮续修后重新运行 `replica-ui` 7/7 和 `native-rhythm-ui` 3/3；LCD／设备页相关单元测试 11/11。`replica-ui` 曾在生产构建同时运行时遇到一次白屏超时，构建结束后的连续重跑 7/7 通过。
- Native ACK 成功、拒绝、状态回读和错误恢复由 Native rhythm 测试桥验证；真实 Native 页面只做状态读取，避免修改用户设备参数。
- `npm run test:unit -- --maxWorkers=1 --testTimeout=30000`：122/122 个文件、789/789 项通过。首轮默认并行运行出现 8 个超时和 1 个旧下拉框值断言；滑杆值断言已更新。单 worker 全量重跑确认所有项通过。

## 验收边界

Browser 录音使用 Chromium 虚拟麦克风，结果为 44.1 kHz 单声道；这次工作只改面板与 LCD 显示，不代表实体回环延迟、立体声录音或实体乐器验收。截图与说明是视觉和交互检查，不是与官方斜拍产品照片进行的亚像素重叠测量。
