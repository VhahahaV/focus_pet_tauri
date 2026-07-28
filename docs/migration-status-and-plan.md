# Focus Pet Tauri 迁移进度与后续规划

> **给后续 agent/工程执行者：** 如果继续实施本文档里的迁移任务，请使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐项执行。本文档用 checkbox 记录任务状态。

**目标：** 将 `/Users/vhahahav/Code/focus_pet` 中 Swift/macOS-only 的 Focus Pet，完整迁移为 `/Users/vhahahav/Code/focus_pet_tauri` 下的 Tauri + React 桌面应用，同时保留本地优先、桌宠陪伴、专注状态判断、桌面卡片和隐私控制等核心体验，并补齐 macOS、Windows、Linux 的可验证发布链路。

**架构方向：** 保留原项目的产品分层，但把领域逻辑迁到 TypeScript，把原生桌面能力迁到 Tauri/Rust 命令层，把 SwiftUI 页面迁到 React 组件。主 React runtime 是唯一的采样、状态推进、持久化、提醒、桌面窗口同步和桌宠动作决策 owner；桌面状态卡和浮动桌宠窗口只负责渲染主 runtime 下发的状态。

**技术栈：** Tauri 2、Rust、React 19、TypeScript 6、Vite 8、Vitest、Playwright，以及 macOS/Windows/Linux 的平台原生适配器。

---

## 当前结论

最后跟进日期：2026-07-09。

当前迁移状态：代码层面的主体功能迁移已经基本完成，本机 macOS 工作区里的自动化验证为绿色。后续重点不再是大规模功能搬运，而是目标系统真机验证、发布硬化、签名/打包策略和最终产品验收。

源项目：

- Swift 项目根目录：`/Users/vhahahav/Code/focus_pet`
- 原主要模块：`FocusPetCore`、`FocusPetStorage`、`FocusPetResources`、`FocusPetRenderer`、`FocusPetWidgets`、`FocusPetMac`
- 原验证入口：`swift build`、`swift run FocusPetCoreChecks`、`./scripts/package-macos-app.sh`

目标项目：

- Tauri 项目根目录：`/Users/vhahahav/Code/focus_pet_tauri`
- 前端主要模块：`src/core`、`src/store`、`src/resources`、`src/app`、`src/components`
- 后端主要模块：`src-tauri/src/lib.rs`、`src-tauri/src/store.rs`、`src-tauri/src/pet_pack.rs`、`src-tauri/src/notifications.rs`、`src-tauri/src/native/*`
- 已保留的 Swift 时代参考文档：`docs/original-swift/*`

## 本次已验证

以下命令均从 `/Users/vhahahav/Code/focus_pet_tauri` 执行：

- [x] `npm run verify:migration`
  - 结果：通过。
  - 覆盖：目标结构、Swift 模块映射、React runtime、UI 页面、Tauri 命令面、平台适配器拆分、桌宠资源包系统、分类目录、视觉资源、原始文档、本地资源包归档和验证入口。
- [x] `npm test`
  - 结果：通过，24 个 Vitest 测试。
  - 覆盖：分类器、隐私脱敏、状态引擎、识别灵敏度预设、时间线、历史快照、专注/休息会话、提醒策略、桌宠资源包校验/导入归一化、数据保留裁剪、原生菜单路由、桌面窗口同步和浮动桌宠逻辑。
- [x] `npm run build`
  - 结果：通过。
  - 输出：生产前端资源写入 `dist/`。
- [x] `npm run verify:tauri-contract`
  - 结果：通过。
  - 覆盖：前端 invoke 命令与 Rust handler 匹配、必需命令面完整、capability 覆盖主窗口/桌面窗口、事件权限存在、导入桌宠资源的 asset protocol 范围正确。
- [x] `cargo test --manifest-path src-tauri/Cargo.toml`
  - 结果：通过，18 个 Rust 测试。
  - 覆盖：命令序列化契约、原生活动 delta 追踪、存储 schema/迁移、桌宠资源包导入/列出/删除、zip 处理、通知命令状态 helper、安装提示、浮动桌宠位置计算。
- [x] `npm run test:ui`
  - 结果：通过，Playwright 在 desktop/mobile 两个项目下共 10 个检查。
  - 覆盖：Swift 风格 Dashboard shell、今日页活动时间窗、App 活动轨道、App 用量状态分段 MiniMeter、24h 时间窗口、历史热力图 hover 详情、每小时活跃 hover 详情、开始休息、桌面 widget 视图、迁移后的设置控件、权限请求入口、桌宠资源包网格、资源包验证摘要、source-action 预览舞台、桌宠 hover 和随机动作控件。
- [x] `npm run verify:native`
  - 结果：在 macOS 上通过。
  - 覆盖：System Events 前台 App 探针、`ioreg` HID idle time、屏幕锁定探针、通知 helper 非投递路径。
- [x] `npm run verify:preflight`
  - 结果：在 macOS 上通过。
  - 覆盖：本机必需 helper：`osascript`、`ioreg`、`cargo`、`npm`。
- [x] `npm run tauri:build -- --target universal-apple-darwin --bundles dmg`
  - 结果：通过，生成 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/FoPet_0.1.0_universal.dmg`。
  - 后处理：已复制为 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/FoPet.dmg`。
  - 覆盖：macOS universal DMG、`FoPet.app` bundle、ad-hoc 签名和 Tauri DMG 打包脚本。
- [x] `hdiutil verify src-tauri/target/universal-apple-darwin/release/bundle/dmg/FoPet.dmg`
  - 结果：通过，镜像 checksum 有效。
  - SHA-256：`22a5f25a2e5d82053f75669d4c4bac24ef4b2cffedd9128731760d8905f69e06`。
- [x] DMG 挂载后检查 `/tmp/FoPetDmgMount/FoPet.app`
  - 结果：通过。
  - 覆盖：`codesign --verify --deep --strict`、`lipo -archs` 为 `x86_64 arm64`、`Info.plist` 中 `CFBundleDisplayName`/`CFBundleName` 为 `FoPet`。
- [x] Browser QA：本地生产构建 Today 休息恢复卡
  - 结果：通过。
  - 覆盖：开始休息前分钟选择器可见；点击“开始恢复”后分钟选择器隐藏，`休息进度` meter 可见，页面无 app console warn/error。
- [x] Browser QA：本地生产构建 Today 窗口节奏卡
  - 结果：通过。
  - 覆盖：`窗口节奏填充饼图` 可见，厚度层、面层、主状态内嵌标签和多切片 callout 可见，旧 donut 主体不再渲染，页面无 app console warn/error。
- [x] Browser QA：本地生产构建 Today 应用用量卡
  - 结果：通过。
  - 覆盖：切换 `24h` 时间窗后“时间去哪了”App 用量卡可见，6 行 App 用量均渲染 `.today-app-meter-fill`，状态子分段共 18 个，旧 `.today-app-meter i` 不再渲染，页面无 app console warn/error。Browser `domSnapshot()` 触发已知兼容错误 `TypeError: o.incrementalAriaSnapshot is not a function`，已用只读 evaluate 和截图完成替代验证。
- [x] Browser QA：本地生产构建历史热力图
  - 结果：通过。
  - 覆盖：切换到历史页后 Swift 式热力图图例可见，包含 9 个时长色块、`0-12h+` 和“高/稳/波动/偏离”；点击“月视图”后每个月头部显示专注时长，页面无 app console warn/error。

本次未执行：

- [ ] `npm run verify:native:notify`
  - 原因：会显示真实系统通知，适合在可见桌面会话中手动确认时执行。
- [ ] `npm run verify:platform`
  - 原因：本次已拆分执行核心子命令、UI 验证、本机 native 检查和 Tauri DMG 构建；发布前仍建议跑一次整合脚本，覆盖 cargo check/fmt 等串联路径。
- [ ] Windows 和 Linux 真机可见桌面验证。
  - 原因：必须在目标 OS 或 CI matrix 上执行，并补充人工 smoke 记录。

## 已迁移模块

### 1. 核心产品模型

状态：基本完成。

Swift 源职责：

- `Sources/FocusPetCore/*`
- `Sources/FocusPetStorage/LocalStore.swift`

Tauri/React 对应实现：

- `src/core/types.ts`
- `src/core/activity.ts`
- `src/core/classification.ts`
- `src/core/settings.ts`
- `src/core/stateEngine.ts`
- `src/core/timeline.ts`
- `src/core/summary.ts`
- `src/core/sessions.ts`
- `src/core/nudge.ts`
- `src/core/pet.ts`
- `src/store/localStore.ts`

已实现：

- 四状态模型：`focus`、`distracted`、`break`、`away`
- 活动分类：`work`、`entertainment`、`ignore`、`neutral`
- 窗口标题隐私脱敏、可选 raw title 存储
- 从 Swift JSON 迁移过来的应用分类目录
- 识别灵敏度预设和自定义阈值
- 状态引擎：休息优先、长 idle、系统睡眠、锁屏、娱乐内容宽限、输入恢复
- 专注会话与休息会话模型
- 状态、App、输入时间线记录
- 今日 summary 和区间历史快照
- load/save/export/runtime recompute 时的数据保留裁剪
- 提醒/nudge 策略，包括长时间 away 后的 welcome-back 行为

剩余风险：

- 行为等价性已有重点测试覆盖，但长时间真实使用采样还需要目标机器观察。
- Tauri 原生采样质量因 OS 不同而不同，阈值可能需要根据真实使用再调。

### 2. React Dashboard 与设置页

状态：基本完成。

Swift 源职责：

- `Sources/FocusPetMac/UI/*`
- `Sources/FocusPetMac/DesignSystem/*`
- `Sources/FocusPetMac/FocusPetModel.swift`

Tauri/React 对应实现：

- `src/App.tsx`
- `src/app/useFocusPetApp.ts`
- `src/app/runtime.ts`
- `src/components/AppShell.tsx`
- `src/components/TodayTab.tsx`
- `src/components/SessionsTab.tsx`
- `src/components/PetTab.tsx`
- `src/components/SettingsTab.tsx`
- `src/components/WidgetView.tsx`
- `src/components/PetCompanion.tsx`
- `src/App.css`
- `src/index.css`

已实现：

- 今日、历史/会话、桌宠、设置等主要页面
- 今日页活动时间窗已对齐 Swift `InputActivityTimelinePanel` 的 2h/4h/6h/8h/12h/24h 时间窗口、状态轨道、App 活动轨道、输入轨道、小时刻度和 hover 详情层
- 今日页“时间去哪了”应用用量卡已对齐 Swift `TodayAppUsageBarRow`/`MiniMeter`：排行、分类、时长和条形长度保留，并按 App 用量段与状态段的时间重叠展示 focus/distracted/break/away 子分段
- 今日页窗口节奏卡已对齐 Swift `RhythmFilledPieChart` 的填充饼图结构：保留厚度层、主状态内嵌标签，并在多切片数据下展示状态 callout
- 历史页已补齐 Swift `AttentionHeatmapPanel`/`ActivityHourlyBarChart` 风格的周标题、星期标签、热力图 hover 详情、Swift 式热力图图例、月视图专注时长汇总和每小时活跃 hover 详情
- 开始/结束专注会话、切换休息
- 今日休息恢复卡已对齐 Swift `BreakDurationControl`：未休息时展示分钟选择器，休息中切换为进度条、剩余时间和结束入口
- 识别诊断刷新和识别例外重置
- 识别阈值、提醒阈值、暂停时长已对齐 Swift `NumberStepperControl` 的标题/当前值/减加按钮交互
- 提醒开关、冷却、暂停配置
- 隐私、数据导出、清空数据
- 数据保留设置
- 日志诊断控制
- 权限刷新、权限请求和系统设置入口
- 桌面状态卡可见性和移动模式
- 桌宠资源包网格、选中/删除、资源包验证摘要、source-action 帧预览、动作映射 chip、显示、音频、hover、随机动作间隔、位置、隐藏/删除、导入

剩余风险：

- Playwright 覆盖的是流程、主要控件和关键可视轨道，不是完整 SwiftUI 像素级视觉对齐。
- 发布前还需要补一个无障碍和键盘导航检查。

### 3. 原生 runtime 与平台适配器

状态：已实现，目标机器验证待补。

Swift 源职责：

- `Sources/FocusPetMac/System/SystemMonitors.swift`
- `Sources/FocusPetMac/System/SystemNotificationSender.swift`
- `Sources/FocusPetMac/System/DesktopWidgetPanelController.swift`
- `Sources/FocusPetMac/System/InstallationNoticeCoordinator.swift`
- `Sources/FocusPetMac/System/SystemSettingsDestination.swift`

Tauri/Rust 对应实现：

- `src-tauri/src/lib.rs`
- `src-tauri/src/native/mod.rs`
- `src-tauri/src/native/macos.rs`
- `src-tauri/src/native/windows.rs`
- `src-tauri/src/native/linux.rs`
- `src-tauri/src/notifications.rs`

已实现命令面：

- `load_snapshot`、`save_snapshot`、`export_snapshot`、`delete_all_data`、`data_size`
- `sample_activity`、`permission_snapshot`、`installation_snapshot`
- `open_system_settings`、`open_log_folder`、`current_log_file`
- `choose_and_import_pet_pack`、`import_pet_pack_from_path`、`list_pet_packs`、`delete_pet_pack`
- `deliver_notification`
- `sync_widget_windows`

已实现平台行为：

- macOS：System Events 获取前台 App/window，`ioreg` 获取 HID idle，CoreGraphics 输入 fallback，锁屏探针，隐私/通知设置入口，AppleScript 通知和 picker。
- Windows：直接 Win32 获取前台窗口、进程、idle time、锁屏状态和全局键鼠计数，`ms-settings` 入口，BurntToast 或 tray balloon 通知，Tauri 原生文件/目录选择器。
- Linux：X11/KDE 友好的活动窗口和 idle 探针，Wayland 受限状态，`notify-send`，`zenity`/`kdialog` picker。
- 共享 native tracker 计算 App switch delta 和保守的 idle-based input fallback。

剩余风险：

- Windows 和 Linux 仍需在目标 OS 上完成编译与 runtime 验证。
- Wayland 限制已通过 limited status 表达，但真实 Linux 桌面上的文案和用户支持路径仍需确认。
- 通知权限行为因 OS 差异较大，需要可见桌面人工验证。

### 4. 存储、隐私与诊断

状态：已实现。

对应实现：

- `src-tauri/src/store.rs`
- `src/store/localStore.ts`
- `src/store/native.ts`
- `src/app/useFocusPetApp.ts`

已实现：

- 用户级 application-support 存储，不写入 app bundle
- schema metadata 写入
- 当前 root 为空时迁移旧 root
- invalid/unsupported schema 的备份与写入阻断
- 脱敏导出
- 清空本地数据
- 数据大小统计
- 日志开关和诊断快照
- 打开日志文件夹、打开当前日志文件

剩余风险：

- 需要对 packaged build 做重启后的持久化 smoke，而不仅是单元测试。
- Windows/Linux 的 export/delete/log 打开路径需要人工确认。

### 5. 桌宠资源包与浮动桌宠

状态：基本完成。

Swift 源职责：

- `Sources/FocusPetResources/*`
- `Sources/FocusPetRenderer/*`
- `dist/local/PetPacks/*`

Tauri/React 对应实现：

- `src/resources/petPack.ts`
- `src-tauri/src/pet_pack.rs`
- `src/app/petCompanionLogic.ts`
- `src/components/PetCompanion.tsx`
- `local-pet-packs/*.zip`

已实现：

- folder、`pet.json`、单资源包 zip、多资源包 zip 导入路径
- `pet.json`、id/name、action folder、source-action folder、PNG frames、`frameCount`、preview、license、distribution、idle source-action reference 校验
- 导入到本地资源库并在启动时列出
- 删除导入资源包
- reimport 时恢复被隐藏资源包
- `PetIntent` 到 source-action 的解析
- 设置页资源包网格、验证摘要、映射 chip 与 source-action 帧预览舞台已对齐 Swift `PetSettingsPanel`
- 可播放 source-action 随机轮换
- hover 面板和手动切换动作
- 浮动桌宠位置：四角、Dock/taskbar/panel 附近、自定义拖动

当前本地 fixture：

- `local-pet-packs/FocusPetLocalPetPacks.zip`
- `local-pet-packs/LuoXiaoHeiLocal.zip`
- `local-pet-packs/PixelCatMemeLocal.zip`
- `local-pet-packs/UNIkeNLocal.zip`
- `local-pet-packs/XiaoDaiLocal.zip`

剩余风险：

- 音频播放和帧播放需要在 packaged build 中用真实导入资源包手测。
- 第三方资源授权需要发布决策；这些 local fixture 不应默认等同于可再分发内置资源。

### 6. 桌面状态卡、托盘菜单与常驻行为

状态：已实现，人工 smoke 待补。

对应实现：

- `src/app/widgetWindows.ts`
- `src/components/WidgetView.tsx`
- `src/components/PetCompanion.tsx`
- `src/app/nativeMenu.ts`
- `src-tauri/src/lib.rs`

已实现：

- 当前状态、最近节奏、浮动桌宠三个 Tauri webview 窗口
- 主 runtime 向次级窗口下发 widget/companion state
- 状态卡支持固定/自由移动并保存物理位置
- 浮动桌宠支持角落、Dock/taskbar/panel、自定义拖动位置
- native menu/tray 支持打开 dashboard、跳转 tab、切换状态卡、切换桌宠、暂停提醒、切换休息、退出
- 关闭主窗口时隐藏而不是退出，保留托盘/菜单入口

剩余风险：

- 托盘/菜单行为和窗口位置需要在所有目标 OS 的可见桌面上确认。
- 多显示器场景需要手动验证，尤其是非主屏幕位置。

### 7. 打包与发布

状态：部分完成。

已有发布相关文件：

- `src-tauri/tauri.conf.json`
- `src-tauri/icons/*`
- `.github/workflows/verify-platforms.yml`
- `docs/platform-adapters.md`
- `docs/target-machine-validation.md`

已有历史产物记录：

- `src-tauri/target/release/bundle/macos/Focus Pet.app`
- `src-tauri/target/release/bundle/dmg/Focus Pet_0.1.0_aarch64.dmg`

已收口：

- `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 已对齐为 `0.1.0`。

剩余风险：

- macOS 签名和 notarization 尚未在本状态文档中闭环。
- Windows installer 签名、Linux AppImage/deb/rpm 验证、自动更新策略尚未闭环。

## 后续迁移计划

### Task 1: 完成本机 macOS release 级验证

**相关文件：**

- 读取：`docs/target-machine-validation.md`
- 读取：`docs/platform-adapters.md`
- 新增证据：`docs/validation/macos-2026-07-08.md`

- [ ] 在可见 macOS 桌面会话中运行 `npm run verify:native:notify`。
  - 预期：命令成功，并能看到系统通知。
- [ ] 运行 `npm run verify:platform`。
  - 预期：cargo check/fmt/test、合约审计、迁移审计、前端构建、Vitest、Playwright、Tauri build 全部通过。
- [ ] 打开 `src-tauri/target/release/bundle/macos/Focus Pet.app`。
  - 预期：主 dashboard 正常出现。
- [ ] 确认 Settings > Permissions 的刷新和系统设置按钮。
  - 预期：Input Monitoring 与 Notifications 设置页能正确打开。
- [ ] 确认 tray/menu 动作。
  - 预期：Today/Pet/Settings 跳转、widget 开关、pet 开关、暂停提醒、休息切换、退出均可用。
- [ ] 确认桌面状态卡与浮动桌宠。
  - 预期：状态卡/节奏卡能显示，自由移动可持久化，浮动桌宠能移动到角落/Dock/custom 位置。
- [ ] 分别从 folder、`pet.json`、单 zip、多 zip 导入桌宠资源包。
  - 预期：preview、帧动画、音频、隐藏/删除、重新导入恢复均可用。
- [ ] 重启 packaged app。
  - 预期：设置、导入资源包、会话/历史状态、widget/pet 位置持久化。
- [ ] 导出并清空本地数据。
  - 预期：生成脱敏导出文件；清空后本地状态被清除。

### Task 2: 验证 Windows 目标

**相关文件：**

- 读取：`docs/target-machine-validation.md`
- 新增证据：`docs/validation/windows-<date>.md`

- [ ] 运行 `npm ci`。
- [ ] 运行 `npm run verify:preflight`。
  - 预期：Windows 所需 helper 和 toolchain 可用。
- [ ] 运行 `npm run verify:native`。
  - 预期：直接 Win32 前台窗口、idle、键鼠钩子与锁屏探针工作。
- [ ] 运行 `npm run verify:native:notify`。
  - 预期：BurntToast 或 fallback 通知出现。
- [ ] 运行 `npm run verify:platform`。
  - 预期：自动 build/test/bundle 链路通过。
- [ ] 启动生成的 Windows bundle。
  - 预期：主 dashboard 打开；关闭主窗口后 tray 仍可用。
- [ ] 验证 Tauri 原生 picker 和全部资源包导入形态。
- [ ] 验证 taskbar-near 浮动桌宠位置。
- [ ] 验证 export/delete/log folder/current-log 动作。

### Task 3: 验证 Linux 目标

**相关文件：**

- 读取：`docs/target-machine-validation.md`
- 新增证据：`docs/validation/linux-<date>.md`

- [ ] 安装 `.github/workflows/verify-platforms.yml` 中列出的 Linux 依赖。
- [ ] 运行 `npm ci`。
- [ ] 运行 `npm run verify:preflight`。
  - 预期：WebKitGTK、app-indicator、xdo、打包工具、opener、notification、picker helper 可用。
- [ ] 运行 `npm run verify:native`。
  - 预期：X11/KDE 探针可用；受限 Wayland 环境明确返回 `wayland-limited`。
- [ ] 运行 `npm run verify:native:notify`。
  - 预期：`notify-send` 通知出现。
- [ ] 运行 `npm run verify:platform`。
  - 预期：自动 build/test/bundle 链路通过。
- [ ] 在目标基线发行版上启动 AppImage/deb/rpm 产物。
- [ ] 验证 `zenity` 或 `kdialog` picker 导入路径。
- [ ] 验证 panel-near 浮动桌宠位置。
- [ ] 验证 export/delete/log folder/current-log 动作。

### Task 4: 关闭产品等价性缺口

**相关文件：**

- 新增证据：`docs/product-equivalence-audit.md`
- 复查：`/Users/vhahahav/Code/focus_pet/README.md`
- 复查：`/Users/vhahahav/Code/focus_pet/docs/project-summary.md`
- 复查：`/Users/vhahahav/Code/focus_pet/docs/release-packaging.md`
- 复查：`README.md`
- 复查：`docs/original-swift/*`

- [x] 对照原 README 的用户功能承诺与 Tauri README/UI。
  - 预期：每个对用户可见的承诺都已经实现、明确延期，或从发布文案中移除。
- [x] 对照 Swift dashboard 截图与 React UI。
  - 预期：主要工作流都可达，即使视觉实现不完全一致。
- [x] 检查设置页中的隐私、提醒、数据、日志控制。
  - 预期：没有缺失关键控制项。
- [x] 对照 WidgetKit 时代的小组件概念与 Tauri widget 行为。
  - 预期：状态卡和节奏卡仍承担轻量扫读入口。
- [x] 对照原桌宠 renderer 交互说明。
  - 预期：拖动、落地、召回/切动作、隐藏/显示、位置、气泡行为可接受。

### Task 5: 发布硬化

**相关文件：**

- 可能修改：`package.json`
- 可能修改：`src-tauri/Cargo.toml`
- 可能修改：`src-tauri/tauri.conf.json`
- 可能修改：`README.md`
- 可能修改：`docs/platform-adapters.md`
- 可能修改：`docs/target-machine-validation.md`

- [x] 对齐 `package.json`、`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json` 的版本元数据。
  - 预期：发布产物显示预期版本。
- [ ] 决定 macOS 签名/notarization 策略。
  - 预期：记录 Developer ID、entitlements、notarization、DMG 分发流程。
- [ ] 决定 Windows installer 签名策略。
  - 预期：记录证书、安装包格式、SmartScreen 预期。
- [ ] 决定 Linux 发行基线。
  - 预期：记录支持的发行版与 artifact 类型。
- [ ] 决定第三方桌宠资源包分发策略。
  - 预期：未确认再分发权的素材只作为 local fixture，不作为默认内置资源。
- [ ] 在 `docs/validation/` 下补充各平台验证证据。
  - 预期：每个目标 OS 都有带日期的 sign-off 文件，包含命令输出摘要和人工 smoke 结果。

### Task 6: CI 与仓库卫生

**相关文件：**

- 复查：`.github/workflows/verify-platforms.yml`
- 复查：`scripts/verify-platform.mjs`
- 复查：`scripts/verify-native-adapters.mjs`
- 复查：`scripts/verify-migration.mjs`

- [ ] 运行或检查 GitHub Actions 的 macOS/Windows/Linux matrix。
  - 预期：所有自动化平台 job 通过，或有明确环境原因说明。
- [ ] 确认 `verify:platform` 是发布前必跑门禁。
  - 预期：发布 checklist 以一个命令覆盖自动化 bundle gate。
- [ ] 确认生成产物不会被误提交。
  - 预期：`dist/`、`src-tauri/target/`、生成 bundle 的跟踪策略明确。
- [ ] 如果开始分发，新增短 release checklist。
  - 预期：维护者可以按文档切 build，不需要重新梳理验证步骤。

## 发布就绪定义

只有以下条件都满足时，迁移才算 release-ready：

- [ ] `npm run verify:platform` 在 macOS、Windows、Linux 都通过。
- [ ] 使用 `docs/target-machine-validation.md` 为 macOS、Windows、Linux 记录可见桌面验证证据。
- [ ] packaged app 启动、重启后持久化、导出/删除、日志动作、桌宠资源包导入、tray/menu、桌面状态卡、浮动桌宠、通知、OS 设置入口均被人工确认。
- [ ] 版本元数据已对齐。
- [ ] 签名、notarization、installer 策略已记录。
- [ ] 第三方桌宠资源包分发策略已记录。
- [ ] README 只描述当前支持的迁移后行为。

## 常用命令

```bash
npm install
npm run build
npm test
npm run test:ui
npm run verify:native
npm run verify:native:notify
npm run verify:tauri-contract
npm run verify:migration
npm run verify:preflight
npm run verify:platform
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:build
npm run tauri:dev
```

## 相关文档

- `README.md`：迁移后架构、开发命令与验证摘要。
- `docs/platform-adapters.md`：平台原生适配器设计与验证边界。
- `docs/target-machine-validation.md`：目标机器验证证据模板。
- `docs/original-swift/project-summary.md`：Swift 时代架构摘要。
- `docs/original-swift/release-packaging.md`：Swift 时代发布说明。
- `docs/original-swift/pet-action-module-design.md`：原桌宠动作模型。
- `docs/original-swift/widget-concepts/focus-pet-widgets.md`：原小组件概念说明。
