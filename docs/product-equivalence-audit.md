# Focus Pet 产品等价性复查

复查日期：2026-07-09

复查范围：

- 源项目：`/Users/vhahahav/Code/focus_pet`
- 目标项目：`/Users/vhahahav/Code/focus_pet_tauri`
- 源文档：`README.md`、`docs/project-summary.md`、`docs/pet-action-module-design.md`、`docs/widget-concepts/focus-pet-widgets.md`、`docs/release-packaging.md`
- 目标证据：`README.md`、`src/app/*`、`src/components/*`、`src/core/*`、`src-tauri/src/*`、`tests/e2e/dashboard.spec.ts`、`src/tests/core.test.ts`

## 当前定位

Tauri 项目不是一个并行原型，而是 Swift/macOS-only Focus Pet 的迁移目标。迁移后的产品仍然坚持本地优先、状态先于报表、温和提醒、桌宠语义层和轻量桌面扫读入口。实现边界从 SwiftUI + macOS native 扩展为 Tauri + React + Rust，并把 macOS-only 能力拆成 macOS、Windows、Linux 平台适配器。

主 React runtime 是唯一的采样、状态推进、持久化、提醒、桌面窗口同步和桌宠动作决策 owner。桌面状态卡和浮动桌宠窗口只渲染主 runtime 下发的状态，不重复采样。

## 用户承诺对照

| 原 `focus_pet` 承诺 | Tauri 对应状态 | 证据 |
| --- | --- | --- |
| 四状态模型：专注、走神、休息、暂离 | 已迁移 | `src/core/types.ts`、`src/core/stateEngine.ts`、`src/app/runtime.ts` |
| 本地状态识别：前台 App、窗口标题分类、输入空闲、切换频率、会话 | 已迁移 | `src/core/activity.ts`、`src/core/classification.ts`、`src-tauri/src/native/*` |
| 专注与休息会话 | 已迁移 | `src/core/sessions.ts`、`src/components/TodayTab.tsx`、`src/components/SettingsTab.tsx` |
| 桌宠表达：气泡、动作、拖拽、位置、隐藏/显示 | 已迁移并补强对拍 | `src/core/pet.ts`、`src/app/petCompanionLogic.ts`、`src/components/PetCompanion.tsx`、`src/components/PetTab.tsx` |
| 资源包系统：`pet.json`、动作、帧、音效、预览、语义映射 | 已迁移并补强对拍 | `src/resources/petPack.ts`、`src-tauri/src/pet_pack.rs`、`src/components/PetTab.tsx`、`local-pet-packs/*.zip` |
| 今日复盘：状态时间线、输入活动、应用/类别分布 | 已迁移并补强对拍 | `src/components/TodayTab.tsx`、`src/core/summary.ts`、`src/core/timeline.ts`、`tests/e2e/dashboard.spec.ts` |
| 历史页：跨日统计、热力图、应用排行 | 已补强对拍 | `src/components/SessionsTab.tsx`、`src/core/timeline.ts`、`tests/e2e/dashboard.spec.ts` |
| 桌面状态卡：当前状态和最近节奏 | 已迁移为 Tauri webview widget | `src/components/WidgetView.tsx`、`src/app/widgetWindows.ts`、`src-tauri/src/lib.rs` |
| 隐私设置：暂停记录、标题隐私、脱敏导出、清空本地数据 | 已迁移 | `src/components/SettingsTab.tsx`、`src/store/localStore.ts`、`src-tauri/src/store.rs` |
| 系统权限设置：刷新、请求、打开系统设置、测试通知 | 已迁移并补强对拍 | `src/components/SettingsTab.tsx`、`src/app/useFocusPetApp.ts`、`src-tauri/src/native/*` |
| 日志与诊断 | 已迁移 | `src/components/SettingsTab.tsx`、`src-tauri/src/lib.rs`、`src-tauri/src/store.rs` |
| 菜单栏常驻行为 | 已迁移为 native menu/tray | `src/app/nativeMenu.ts`、`src-tauri/src/lib.rs` |

## 桌宠动作模型对照

源文档把动作资源收敛到最多 10 个核心模组，并允许旧 `PetAction` key 继续作为兼容映射。目标项目保留运行时 `PetIntent` 语义层，并在 `preferredSourceActionIDs` 中同时支持新语义和旧资源 key：

- `quietCompanion` 覆盖 `idle`、`focus`、`breath` 等安静陪伴资源。
- `focusRestHint` 覆盖 `stretch`、`grooming`、`blink`。
- `nudgeGentle` 和 `nudgeStrong` 覆盖轻提醒和强提醒。
- `breakCompanion` 和 `breakEnding` 覆盖休息陪伴与休息结束。
- `moveLeft`、`moveRight`、`moveUp`、`moveDown` 覆盖横向小跑和垂直攀爬资源。
- `mouseSummon` 支持 `cursorPounce` 和旧 `mouseSummon` key。
- `dragged`、`landing` 保留物理交互 intent。

结论：动作语义已经迁移，且比 Swift 文档中的兼容阶段更明确。设置页已使用 source-action 帧资源作为动作预览舞台；剩余验证属于 packaged app 手测：真实导入资源包后的音频播放、拖动落地、hover 操作和资源路径回放。

## 桌宠设置页对照

Swift `PetSettingsPanel` 的可见结构是资源包、动作映射、显示行为、位置外观四段。Tauri 桌宠页已补齐这一组高感知细节：

- 资源包区使用网格卡片，不再是简化横向 pill；包含缩略图、名称、风格、选中状态和删除入口。
- 空资源包状态保留“导入单个 .zip 或包含 pet.json 的文件夹后再显示桌宠”的引导文案。
- 动作映射区展示资源包可用/需修复状态、作者/风格、动作数、音效数、验证错误和验证提示。
- 意图映射台保留用户意图与进阶意图分组、当前映射/待映射状态和动作 chip footnote。
- 预览舞台使用对应 source-action 的 frameURLs，并按 Swift 预览逻辑把 fps 限制到 6fps 以内。

## 系统权限设置对照

Swift `PermissionSettingsPanel` 每一行都有状态 badge、可用时的“请求”入口和系统设置入口。Tauri 设置页已补齐同等入口：

- 权限行覆盖输入监控、通知和隐私与安全。
- 输入监控与通知在非允许状态下显示“请求”按钮。
- 输入监控请求会打开系统设置并刷新权限状态；通知请求会投递权限测试通知并刷新状态。
- 保留“打开”系统设置按钮和通知“测试”按钮。

## 设置数值控件对照

Swift `RecognitionSettingsPanel` 和 `ReminderSettingsPanel` 使用 `NumberStepperControl` 管理阈值与时长，交互是当前值加减而不是连续滑杆。Tauri 设置页已同步该模式：

- 识别阈值：无输入走神、娱乐走神、输入恢复专注、暂离回填。
- 提醒阈值：温和走神阈值、强提醒阈值、长专注阈值、超长专注阈值、提醒冷却。
- 暂停配置：暂停时长。
- 每个控件展示标题、当前值和单位，并提供减/加按钮与上下限禁用状态。

## Widget 概念对照

源 WidgetKit 规划优先实现当前状态 Small 和最近节奏 Medium。目标项目不再依赖 macOS WidgetKit，而是用跨平台 Tauri webview 窗口实现同一产品职责：

- `currentStatus` 展示当前状态、当前 App、今日专注和提示文案。
- `recentRhythm` 展示最近状态分布、输入和切换。
- 主窗口通过 `focus-pet-widget-state` 下发状态，widget 只负责渲染。
- 支持固定位置和自由拖动，并持久化物理坐标。

结论：核心扫读入口已经迁移。专注计时、宠物伙伴、今日复盘、休息提醒等原规划中的后续 Widget 尺寸没有作为独立 widget 落地，但对应信息已经存在于 dashboard、浮动桌宠和状态卡中，不阻塞迁移 release-ready。

## 今日活动时间窗对照

Swift `InputActivityTimelinePanel` 的核心体验是可切换时间窗、状态轨道、App 活动轨道、输入轨道、小时刻度和 hover 详情。Tauri 今日页已补齐同一组行为：

- 时间窗口覆盖 `2h`、`4h`、`6h`、`8h`、`12h`、`24h`。
- 状态轨道来自 `stateRanges`，App 轨道来自 `appSegments`，输入轨道来自 `inputBars` 和 `switchMarkers`。
- hover 详情展示状态持续、App 使用、输入频率、键盘/鼠标/切换计数，并保留“本地估算，不记录输入内容”的隐私语义。
- Playwright desktop/mobile 用例验证今日页 shell、24h 控件和 App 活动轨道可见。

## 今日应用用量卡对照

Swift `TodayAppUsageBarChartPanel` 的每一行由排行、App 图标/名称、分类修正入口、`MiniMeter` 和时长组成，其中 `MiniMeter` 会在 App 用量条内部叠加 focus/distracted/break/away 状态子段。Tauri 今日页已同步这一组高感知行为：

- “时间去哪了”列表保留排行、App 名称、分类、用量条和右侧时长。
- 用量条长度按当前窗口内 App 使用时长相对最大值计算。
- 用量条内部根据 App 用量段与状态段的时间重叠，渲染专注、走神、休息和暂离子分段；没有状态分段时保留分类色兜底。
- Playwright desktop/mobile 用例验证 `.today-app-meter-fill` 与状态子段可见，并确认旧单条 `<i>` meter 不再渲染。

## 今日休息恢复卡对照

Swift `BreakDurationControl` 在未休息时展示 1/5/10/30 分钟选择器，在休息中改为 `CompactMeter` 进度条、剩余时间和结束入口。Tauri 今日页已同步该状态切换：

- 未开始休息时保留分钟选择器和“开始恢复”入口。
- 点击开始后隐藏分钟选择器，改为休息进度 meter、剩余时间和“结束休息”入口。
- Playwright desktop/mobile 用例验证 active break 状态下进度条可见，并确认分钟选择器不再显示。

## 今日窗口节奏卡对照

Swift `TodayRhythmSummaryPanel` 使用 `RhythmFilledPieChart` 展示所选时间窗内专注、走神和休息的节奏分布。Tauri 今日页已把原 donut 图替换为同类填充饼图：

- 饼图主体不再掏空，保留面层和厚度层，接近 Swift 的 filled pie 阅读方式。
- 主导状态在饼图内部显示状态名、占比和时长。
- 多状态数据下会为非主导切片展示外部 callout，保留 Swift 的状态标注语义。
- Playwright desktop/mobile 用例验证 `窗口节奏填充饼图`、厚度层、面层和主标签可见，并确认旧 donut 主体不再渲染。

## 历史页交互对照

Swift `AttentionHeatmapPanel` 和 `ActivityHourlyBarChart` 都提供自定义 hover 详情，而不是依赖系统 tooltip。Tauri 历史页已补齐这些交互：

- 周视图显示星期标签与 `W` 周编号，接近 Swift 周热力图的阅读结构。
- 热力图图例补齐 Swift 的时长等级、`0-12h+` 范围和“高/稳/波动/偏离”稳定性语义，不再只显示简化低/高标尺。
- 月视图每个月标题旁显示该月专注时长，保留 Swift `MonthlyAttentionHeatmap` 的扫读信息密度。
- 热力图 hover 卡展示日期、总计、专注占比、专注/走神/休息/暂离分解。
- 全天每小时活跃 hover 卡展示时段、日均活跃分钟、专注/走神累计和专注占比。
- hover 目标切换时会清除上一类详情卡，避免热力图详情残留到活跃统计区。

## 发布策略对照

源 Swift 发布文档强调：

- 用户数据必须在 app bundle 外。
- 本地第三方宠物资源不默认再分发。
- macOS 需要签名、notarization 和 DMG 验证。
- 旧 `FocusPetMVP` 数据目录迁移到 `Focus Pet`。

目标项目当前状态：

- 存储迁移和 schema 保护已在 `src-tauri/src/store.rs` 实现。
- 本地宠物资源保留为 `local-pet-packs` 验证 fixture，而不是默认内置资源。
- 版本元数据已对齐到 `0.1.0`。
- 签名、notarization、Windows installer 签名、Linux 发行基线仍属于发布硬化剩余项。

## 结论

基于源项目文档和目标项目代码，用户可见功能承诺已经有 Tauri 对应实现或明确归入后续验证边界。当前不需要继续大规模搬运 Swift 功能，下一阶段应集中在：

- macOS packaged build 的可见桌面验证。
- Windows 和 Linux 目标机验证。
- 发布签名、notarization、installer 和 Linux artifact 策略。
- 第三方宠物资源包分发权决策。
