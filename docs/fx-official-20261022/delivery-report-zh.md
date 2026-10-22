# RC-505mkII FX 参数接口交付说明

基于 Roland RC-505mkII Parameter Guide Version 1.3 and later，逐项核对 53 个效果家族（49 Input / 53 Track），展开 TAPE ECHO 与 ROLL 变体后为 55 项、267 个手册参数行。

## 实现范围

Browser 和 Native 均为 252 行已实现软件控制、4 行部分源模式支持、11 行明确不支持。这里的“已实现”指控制真实接入独立实现的 DSP，并非 BOSS 原厂算法、硬件音质或端到端延迟认证。30 行 tempo 参数仅采用手册明确给出的音符端点，不虚构手册未列出的中间枚举。

官方参数采用独立 official_* 接口；旧参数 ID、已有项目和扩展参数保留。首次显式启用官方控制才应用受支持的手册默认值，单纯 BPM 更新不会改写旧工程的声音。范围、枚举、条件、变体、tempo/meter 同步、读回及恢复均有对应验证；不支持的控制不伪装成成功的空旋钮。

最终已修复 Native mono Input 的空间效果通道丢失。AUTO PAN、PANNING DELAY、CHORUS 真实音频验证通过；STEREO ENHANCE 验证已有 stereo side 信息的宽度变化，绝不把纯 mono 信号凭空宽化冒充同一算法。旧 mono 路径在仅 BPM 广播时逐样本不变。

最终前端完整回归 182 个文件 / 2,311 项通过；Native 52/52 CTest 与 5/5 HTTP 通过。生产构建和云端 HTTP 资源启动检查通过；这不代表用户本机或实体声卡测试。完整证据见 validation-summary.md 与 validation-logs。

## 逐效果覆盖

计数顺序：已实现 / 部分支持 / 不支持。完整逐参数名称、单位、范围、默认值、条件与证据见 parameter-coverage.csv、parameter-guide.json。

| 效果 / 变体 | 手册页 | 参数行 | Browser | Native |
|---|---:|---:|---:|---:|
| LPF | 34 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| BPF | 34 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| HPF | 34 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| PHASER | 34 | 8 | 8 / 0 / 0 | 8 / 0 / 0 |
| FLANGER | 35 | 8 | 8 / 0 / 0 | 8 / 0 / 0 |
| SYNTH | 35 | 4 | 4 / 0 / 0 | 4 / 0 / 0 |
| LO-FI | 35 | 3 | 3 / 0 / 0 | 3 / 0 / 0 |
| RADIO | 35 | 2 | 2 / 0 / 0 | 2 / 0 / 0 |
| RING.MOD | 35 | 3 | 2 / 0 / 1 | 2 / 0 / 1 |
| G2B | 35 | 2 | 1 / 0 / 1 | 1 / 0 / 1 |
| SUSTAINER | 35 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| AUTO RIFF | 36 | 7 | 6 / 0 / 1 | 6 / 0 / 1 |
| SLOW GEAR | 36 | 4 | 3 / 0 / 1 | 3 / 0 / 1 |
| TRANSPOSE | 36 | 2 | 1 / 0 / 1 | 1 / 0 / 1 |
| PITCH BEND | 36 | 3 | 2 / 0 / 1 | 2 / 0 / 1 |
| ROBOT | 36 | 3 | 2 / 0 / 1 | 2 / 0 / 1 |
| ELECTRIC | 36 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| HRM MANUAL | 37 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| HRM AUTO (M) | 37 | 7 | 7 / 0 / 0 | 7 / 0 / 0 |
| VOCODER | 37 | 6 | 4 / 1 / 1 | 4 / 1 / 1 |
| OSC VOC (M) | 37 | 7 | 7 / 0 / 0 | 7 / 0 / 0 |
| OSC BOT | 38 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| PREAMP | 38 | 12 | 12 / 0 / 0 | 12 / 0 / 0 |
| DIST | 38 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| DYNAMICS | 38 | 2 | 2 / 0 / 0 | 2 / 0 / 0 |
| EQ | 38 | 9 | 9 / 0 / 0 | 9 / 0 / 0 |
| ISOLATOR | 39 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| OCTAVE | 39 | 3 | 2 / 0 / 1 | 2 / 0 / 1 |
| AUTO PAN | 39 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| MANUAL PAN | 39 | 1 | 1 / 0 / 0 | 1 / 0 / 0 |
| STEREO ENHANCE | 39 | 3 | 3 / 0 / 0 | 3 / 0 / 0 |
| TREMOLO | 39 | 3 | 3 / 0 / 0 | 3 / 0 / 0 |
| VIBRATO | 39 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| PATTERN SLICER | 40 | 7 | 6 / 0 / 1 | 6 / 0 / 1 |
| STEP SLICER | 40 | 7 | 7 / 0 / 0 | 7 / 0 / 0 |
| DELAY | 40 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| PANNING DELAY | 40 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| REVERSE DELAY | 40 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| MOD DELAY | 40 | 7 | 7 / 0 / 0 | 7 / 0 / 0 |
| TAPE ECHO1 | 41 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| TAPE ECHO2 | 41 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| GRANULAR DELAY | 41 | 3 | 3 / 0 / 0 | 3 / 0 / 0 |
| WARP | 41 | 1 | 1 / 0 / 0 | 1 / 0 / 0 |
| TWIST | 41 | 4 | 4 / 0 / 0 | 4 / 0 / 0 |
| ROLL1 | 41 | 4 | 4 / 0 / 0 | 4 / 0 / 0 |
| ROLL2 | 41 | 4 | 4 / 0 / 0 | 4 / 0 / 0 |
| FREEZE | 42 | 5 | 5 / 0 / 0 | 5 / 0 / 0 |
| CHORUS | 42 | 6 | 6 / 0 / 0 | 6 / 0 / 0 |
| REVERB | 42 | 7 | 7 / 0 / 0 | 7 / 0 / 0 |
| GATE REVERB | 42 | 7 | 7 / 0 / 0 | 7 / 0 / 0 |
| REVERSE REVERB | 42 | 7 | 7 / 0 / 0 | 7 / 0 / 0 |
| BEAT SCATTER | 43 | 2 | 1 / 0 / 1 | 1 / 0 / 1 |
| BEAT REPEAT | 43 | 2 | 2 / 0 / 0 | 2 / 0 / 0 |
| BEAT SHIFT | 43 | 2 | 0 / 2 / 0 | 0 / 2 / 0 |
| VINYL FLICK | 43 | 1 | 0 / 1 / 0 | 0 / 1 / 0 |

## 准确保留的缺项

- 7 个 MODE：RING MOD、G2B、SLOW GEAR、TRANSPOSE、PITCH BEND、ROBOT、OCTAVE。手册未提供另一模式的算法语义，不能随意编造模式切换。
- AUTO RIFF PHRASE、PATTERN SLICER PATTERN、BEAT SCATTER TYPE：缺原厂短句 / 图案内容，不能把自行创作的内容冒充原厂预设。
- VOCODER CARRIER THRU：没有足够明确的执行语义，不伪造。
- 部分源模式：BEAT SHIFT、VINYL FLICK 和 VOCODER CARRIER 的受支持轨道播放路径已接入。物理输入未映射；Native 正在录音、叠录、实时变调或资源受限的 carrier 源明确返回状态并静音，不用内部振荡器冒充。
- Browser VOCODER 将 stereo carrier 合入现有 mono voice 引擎；Native 分声道处理。两端不宣称逐样本音频相同。
- 未声称完整硬件 MEMORY 格式、全 MIDI ASSIGN、银行级切换 / FX sequence 已完成；严格实时、XRUN、用户本机部署和硬件音质仍未验收。

## 使用和恢复

api-contract.md 给出真实 Browser / Native 调参入口、ACK 与替换 / 清除语义。recovery-and-use.md 给出从完整 Git bundle 恢复到独立新目录、构建和测试的步骤；不要覆盖已有 dirty 工作目录或用户的新 UI，也不要 force push。

官方来源：https://static.roland.com/assets/media/pdf/RC-505mk2_Parameter_eng04_W.pdf
