# 决策记录

按 IMPLEMENTATION_PLAN.md 0.4 工程纪律要求，记录计划与实际实现的偏差和新增产品决策。

## DEC-001 新增"合成模板"输出模式（整组特效 + 词级节奏驱动）

- 日期：2026-09-06
- 状态：已实现（用户确认的需求扩展，追加于冻结合同 v1.0 之上，不修改既有行为）

### 背景

现有复制机制的两个单位都无法表达"整组特效字幕"（如花瓣跟随逐字 reveal 的片头字幕）：

1. 文字图层模板（`textOnly: true`）只复制文字层本身，卫星层（粒子层、预合成、调整层）不跟随。
2. 效果复制按"属性模块"在层间搬运，无法携带跨层绑定（发射器拾取、表达式引用、轨道遮罩）。

另外，纯复制无法让特效匹配新句子的语音节奏：模板内部的关键帧记录的是原句的节奏，新句子的节奏数据只能来自 STT 词级时间戳（合同 0.2-6 已强制启用）。

### 决策

1. **不修改既有路由与行为**。新功能全部放在新增文件 `extension/jsx/AEFT/comp-copy.jsx`，注册新路由 `ae.comp.templateInfo` 与 `ae.comp.subtitles.create`；bootstrap 仅追加一行加载。既有 AE/PR 功能、既有测试契约保持不变。
2. **复制单位为整个合成**。每句字幕 `duplicate()` 模板合成 → 替换内部所选文字图层内容 → 作为图层放入目标合成，按 `句长 / 模板有效时长` 线性拉伸对时（沿用合同 0.2-16 的有效时长映射语义）。合成内部所有跨层绑定随 duplicate 原样保留，不做任何重绑定。
3. **词级节奏驱动（三级回退）**：
   - Tier 1：模板内名称含 "LWS" 且含 "Progress" 或 "进度" 的 Slider Control（matchName `ADBE Slider Control`），插件按词级时间戳写 0→100 进度关键帧（模板作者用表达式把 reveal 与粒子发射挂在该滑杆上）。
   - Tier 2：无滑杆时，重写模板文字图层上已有关键帧的 Range Selector Start/Offset（仅 reveal 跟随新节奏；AE 表达式读不到动画器值，其余层只能随层拉伸）。
   - Tier 3：都没有时整层线性拉伸并报 `W_COMP_TEMPLATE_LINEAR_TIMING`。
   - 无词级数据的分段按整句线性均分并报 `W_COMP_TIMING_ESTIMATED`。
4. **模板作者义务**：手 K 关键帧的模板无法自动适配新句子节奏，需要一次性改为滑杆驱动 rig；该约定写入 README。
5. 副本合成收纳进项目根目录"LWS 合成模板"文件夹；模板内音频层自动静音（`W_COMP_TEMPLATE_AUDIO_DISABLED`）；模板与目标合成尺寸不一致时按比例缩放（`W_COMP_TEMPLATE_SCALED`）。
6. UI 入口为 AE 输出方式第三项"合成模板"（`ae-only` + `stt-feature`），未选择模板时阻止运行并明确提示。

### 测试

- 新增 `tests/contract/comp-copy.test.js`：ES3 合规、路由隔离（不得重注册既有路由）、节奏三级契约、时间映射公式、UI 接线。
- `tests/contract/host-contract.test.js`：加载顺序与路由清单追加 comp 模块。
- `tests/contract/host-loader.test.js`：mock 文件系统白名单追加 `AEFT/comp-copy.jsx`。
