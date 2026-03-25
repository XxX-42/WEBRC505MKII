# RC-505mkII 真机面板分区 UI 还原路线图

## 目标

把当前 Web 原型从“功能组件拼接”重构为“按 RC-505mkII 真机面板分区组织”的界面。

还原顺序遵循两个原则：

1. 先还原面板结构，再微调视觉细节。
2. 先固化真实交互归属，再决定组件长相和尺寸。

---

## 当前代码对应关系

当前页面骨架已经具备 3 个核心区块，但分区逻辑还不是 RC-505mkII 真机逻辑：

- `src/App.vue`
  - 负责整机页面装配。
  - 现在是“顶部一整条 + 下方 5 轨 + 浮层”的网页布局。
- `src/components/TopPanel.vue`
  - 现在把 `INPUT FX`、`TRANSPORT`、`RHYTHM`、`TRACK FX` 放在同一条顶部区域。
  - 适合做临时控制台，不适合直接映射真机面板。
- `src/components/TrackUnit.vue`
  - 已经是单轨独立组件。
  - 但内部仍是“上半区旋钮/按钮 + 下半区主按钮”的抽象布局，不是 RC-505mkII 的真实轨道条带顺序。
- `src/components/TransportControls.vue`
  - 已有 `TEMPO / PLAY ALL / TAP / THRU / SETTINGS`。
  - 可作为中控区逻辑来源，但 UI 结构需要重排。
- `src/components/RhythmControls.vue`
  - 已有节奏开关、Pattern、Volume。
  - 适合并入中央控制区的节奏分区。

结论：逻辑基础可复用，主要缺的是“真机面板结构层”和“分区归属层”。

---

## 真机面板分区拆解

建议把整机 UI 明确拆成 6 个分区。

### 1. 顶部状态条

对应网页里所有“不是硬件面板本体，但用户必须知道”的全局状态：

- 音频模式 `browser / native`
- 引擎连接状态
- 错误提示
- 主题切换
- 能力摘要

这部分不需要强行伪装成真机按钮区，应视为“Web 壳层状态条”。

当前来源：

- `src/App.vue`

处理原则：

- 从真机面板视觉上脱离，做成窄状态条或悬浮 header。
- 不占用主面板核心面积。
- 保留桌面调试能力，但弱化存在感。

### 2. 左侧 Input FX 区

目标是还原真机左上输入效果器区，而不是简单摆 4 个 `FxUnit`。

应包含：

- Input FX 分区标题
- 4 个 FX slot
- 每个 slot 的类型、开关、参数指示
- 当前目标来源说明
- 后续可扩展的 target/source 指示

当前来源：

- `src/components/TopPanel.vue`
- `src/components/fx/FxUnit.vue`

当前缺口：

- 只有“卡片式 slot”，没有真实面板排布语义。
- 缺少该区自己的网格、标签层级、旋钮区和 slot 区关系。
- 没有“正在编辑哪个 slot”的聚焦态。

### 3. 中央节奏 / 运输 / 显示区

这是整机最关键的“中控面板”。

建议拆成 4 个子块：

- `Display`：BPM、节拍、当前状态、提示信息
- `Transport`：Play/Stop All、Tap Tempo
- `Rhythm`：Rhythm Start/Stop、Pattern、Level
- `Global Utility`：Thru、Settings、后续 Undo/Redo、Memory/Setup 入口

当前来源：

- `src/components/TransportControls.vue`
- `src/components/RhythmControls.vue`

当前缺口：

- BPM 与状态显示还不够“中央主屏”化。
- 节奏区和运输区只是功能并排，不是中心控制簇。
- 缺少全局 utility 分组和按钮等级。
- 未来若加 `UNDO/REDO`、`ALL START/STOP`、`MEMORY`，当前布局会立即拥挤。

### 4. 右侧 Track FX 区

与 Input FX 区对称，但语义不同，不能只做镜像。

应包含：

- Track FX 标题
- 4 个 Track FX slot
- 目标轨道或目标组指示
- 激活态、编辑焦点、参数态

当前来源：

- `src/components/TopPanel.vue`
- `src/components/fx/FxUnit.vue`

当前缺口：

- 缺少“Track FX 正在作用于谁”的视觉说明。
- 与 Input FX 区未区分“输入链路”和“轨道链路”的视觉语义。

### 5. 下方五轨主操作区

这是最接近真机主体的区域，也应作为还原优先级最高的主体区。

每轨建议固定为一根“纵向通道条”，从上到下顺序统一：

- Track 标识
- 状态小标签
- 小型参数区或轨道附属按钮区
- 轨道级旋钮区
- 长行程推子
- STOP
- REC/PLAY 主按钮 + Halo

当前来源：

- `src/components/TrackUnit.vue`
- `src/components/LoopHalo.vue`
- `src/components/ui/HardwareKnob.vue`
- `src/components/ui/HardwareFader.vue`
- `src/components/ui/HardwareButton.vue`

当前缺口：

- 轨道内部结构还是“网页式上下分块”，不是真机通道条。
- `FX / TRACK / STOP` 的位置关系还不够稳定。
- 缺少轨道状态信息的层级设计，例如 `EMPTY / REC / PLAY / DUB / REV / MUTED`。
- 轨道条之间没有形成“5 通道统一母版网格”。

### 6. 浮层与设置层

这部分不是面板主体，但要服务面板，不应抢主视觉。

包含：

- 音频设置弹窗
- 浏览器音频设置弹窗
- Latency 调整
- 错误/警告提示

当前来源：

- `src/components/AudioSettings.vue`
- `src/components/BrowserAudioSettings.vue`
- `src/components/LatencyTuner.vue`

处理原则：

- 保留功能，但弱化常驻感。
- 从主面板上剥离成 drawer、modal 或右下工具仓。

---

## 推荐实施顺序

### Phase 0: 先搭真机分区骨架

目标：先把页面从“组件流式排版”改成“面板分区排版”。

建议新增一层结构组件：

- `src/components/panel/Rc505Shell.vue`
- `src/components/panel/TopStatusStrip.vue`
- `src/components/panel/InputFxPanel.vue`
- `src/components/panel/CenterControlPanel.vue`
- `src/components/panel/TrackFxPanel.vue`
- `src/components/panel/TrackBay.vue`

`App.vue` 应只做整机装配，不再直接拼业务组件。

验收标准：

- 页面一眼能看出“左 / 中 / 右 / 下”的硬件面板分区。
- 即使视觉还没精修，也已经不是网页控制台。

### Phase 1: 重做顶部与中控分区

目标：把 `TopPanel.vue` 当前的横排大容器拆掉。

实施动作：

- Input FX 从旧 `TopPanel` 拆到独立左区。
- Track FX 拆到独立右区。
- `TransportControls + RhythmControls` 合并为中央控制区。
- `App.vue` 中的全局状态按钮移出主面板视觉焦点。

验收标准：

- 顶部控制不再是一条等权横排工具栏。
- 中央控制区成为视觉重心。

### Phase 2: 重做五轨通道条

目标：把 `TrackUnit.vue` 从“单卡片”改成“真机纵向轨条”。

实施动作：

- 固定单轨宽度、统一高度、统一内部纵向节奏。
- 明确按钮层级：
  - 主按钮最大
  - STOP 次级但独立
  - FX/TRACK/REV 等为辅助功能
- 让 5 轨共享同一套网格线和底部对齐规则。

验收标准：

- 5 轨摆在一起时像一台机器，不像 5 张独立卡片。

### Phase 3: 建立“编辑焦点”系统

目标：解决 FX slot、轨道、参数到底“当前在编辑谁”的问题。

实施动作：

- 增加全局 panel focus 状态。
- Input FX / Track FX slot 支持选中态。
- 轨道条支持 selected / armed / active 的视觉区分。
- 中央显示区可以反馈当前上下文。

验收标准：

- 用户能明确知道当前旋钮或操作正在影响哪个对象。

### Phase 4: 做真机视觉细节

目标：在结构稳定后再做材料、刻字、灯效、缝隙、阴影。

实施动作：

- 统一 panel 金属/塑料材质 token。
- 统一丝印字体和标签规则。
- 统一 LED 颜色强度和点亮逻辑。
- 给不同分区加入细微边框、沟槽和段差。

验收标准：

- 视觉语言一致。
- 不靠大量阴影堆“伪硬件感”。

### Phase 5: 响应式与测试收口

目标：确保桌面优先，同时保证小屏不崩。

实施动作：

- 设定桌面基准宽度，优先保留真机横向结构。
- 小屏采用缩放、横向滚动或折叠工具仓，不强行改成移动端卡片流。
- 为核心分区补 e2e 截图断言。

验收标准：

- 桌面布局稳定。
- 小屏可用，但不破坏“硬件面板”认知。

---

## 组件重构建议

建议保留逻辑组件，新增“面板容器组件”，避免业务逻辑和真机排版继续耦合。

推荐分层：

- 逻辑层
  - `TransportControls.vue`
  - `RhythmControls.vue`
  - `TrackUnit.vue`
  - `FxUnit.vue`
- 面板壳层
  - `InputFxPanel.vue`
  - `CenterControlPanel.vue`
  - `TrackFxPanel.vue`
  - `TrackStrip.vue`
  - `TrackBay.vue`
- 基础硬件控件层
  - `HardwareButton.vue`
  - `HardwareKnob.vue`
  - `HardwareFader.vue`
  - `LoopHalo.vue`

建议方向：

- 让旧逻辑组件逐步下沉成“内容模块”。
- 让新 panel 组件掌握真实布局权。
- 最终 `TrackUnit.vue` 可以拆成 `TrackStrip.vue + useTrackUnitState`，减少模板和状态逻辑耦合。

---

## 文件改造优先级

第一批必改：

- `src/App.vue`
- `src/components/TopPanel.vue`
- `src/components/TrackUnit.vue`
- `src/style.css`

第二批建议新增：

- `src/components/panel/Rc505Shell.vue`
- `src/components/panel/TopStatusStrip.vue`
- `src/components/panel/InputFxPanel.vue`
- `src/components/panel/CenterControlPanel.vue`
- `src/components/panel/TrackFxPanel.vue`
- `src/components/panel/TrackBay.vue`

第三批按视觉精修再动：

- `src/components/ui/HardwareButton.vue`
- `src/components/ui/HardwareKnob.vue`
- `src/components/ui/HardwareFader.vue`
- `src/components/LoopHalo.vue`

---

## 设计约束

还原 RC-505mkII 时，建议守住这几个边界：

- 不把所有功能都塞进顶部。真机的核心是“中控 + 五轨主体”。
- 不把五轨做成 5 张独立卡片。它们必须是一整块通道阵列。
- 不为移动端牺牲主桌面结构。这个产品本质上是桌面设备模拟界面。
- 不先做材质细节再做结构。否则后面必定返工。
- 不把 Web 调试控件伪装成硬件面板按钮。调试壳层应和面板主体分离。

---

## 最短落地方案

如果只做一轮高收益改造，我建议直接按下面顺序落地：

1. `App.vue` 改成 `顶部状态条 + 主面板壳 + 右下工具层`
2. `TopPanel.vue` 拆成 `InputFxPanel / CenterControlPanel / TrackFxPanel`
3. `TrackUnit.vue` 改成统一纵向轨条
4. `style.css` 重建整机 spacing、panel border、zone token

这样做完，即使不增加任何新功能，页面也会从“功能原型”跃迁到“RC-505mkII 面板原型”。

---

## 一句话结论

这次 UI 还原的关键，不是继续优化单个按钮或单个轨道，而是先把页面改造成“真机分区驱动”的布局系统，然后再让现有逻辑组件嵌进去。
