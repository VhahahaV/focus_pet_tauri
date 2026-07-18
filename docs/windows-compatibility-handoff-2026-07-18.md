# Windows 兼容性阶段记录（2026-07-18）

## 目的与当前结论

本文记录 `focus_pet_tauri` 在 Windows 平台的本轮兼容性开发、验证证据和剩余工作，供后续继续开发与验收。

- 工作分支：`codex/windows-compatibility`
- 基线提交：`5d4006c`（`Polish dashboard cards and desktop widgets`）
- 测试平台：Windows x86_64，PowerShell，Rust `stable-x86_64-pc-windows-gnullvm`
- 当前状态：主要 Windows 原生接口、数据目录、桌宠资源导入和窗口定位问题已经实现或修复；最终真实 UI 回归、最新安装包重建和安装验证尚未完成，不能据此宣称 Windows 全面验收完成。

## 本轮已完成的代码

### 1. Windows 原生输入与活动监控

`src-tauri/src/native/windows.rs` 已改为直接使用 Win32 API，不再依赖 PowerShell 采样：

- `GetForegroundWindow`、`GetWindowTextW` 和 `GetWindowThreadProcessId` 获取前台窗口、标题和进程。
- `GetLastInputInfo` 获取系统空闲时间。
- `WH_KEYBOARD_LL` 与 `WH_MOUSE_LL` 低级钩子在独立消息线程中统计键盘和指针事件。
- `OpenInputDesktop` / `SwitchDesktop` 检查锁屏或不可交互桌面状态。
- 计数采用饱和加法，避免长时间运行时整数回绕。
- Windows 输入钩子可用时，权限接口返回可用状态；前端统一显示为“已允许”。
- 系统设置跳转使用 `ms-settings:privacy-general` 与 `ms-settings:notifications`。

### 2. Windows 数据目录与持久化

`src-tauri/src/store.rs` 已完成以下适配：

- Windows 正式数据根目录固定为当前登录用户的 `%USERPROFILE%\AppData\Local\Focus Pet`。
- 通过当前进程令牌和 `GetUserProfileDirectoryW` 获取真实用户目录，避免 MSIX/Codex 宿主环境把路径重定向到 `Packages\...\LocalCache`。
- 支持从旧的 Tauri/Roaming 根目录迁移已有数据。
- 修复 Windows 上 `std::fs::rename` 无法覆盖已存在目标文件的问题；现在使用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` 原子替换 JSON 快照。
- 新增回归测试，验证连续两次保存会读取到第二次的值，且不会遗留 `.tmp` 文件。
- 新增 `data_storage_path` 与 `open_data_folder` Tauri 命令；设置页可以打开数据目录或复制路径。
- `open_path` 会区分文件与目录，不再把尚不存在的文件路径误创建成目录。

这一修复很关键：此前第一次原生保存成功、后续保存失败，前端会退回 WebView `localStorage`，重启时又优先读取旧原生文件，导致桌宠显示、位置等设置看似修改成功但重启丢失。

### 3. 桌宠资源导入与大资源包启动

- 使用 `tauri-plugin-dialog` 提供跨平台原生文件/目录选择器，移除 Windows PowerShell/Windows Forms 选择器依赖。
- 选择器在阻塞线程中运行，避免占用 Tauri 异步执行线程。
- 修复 Windows 路径断言，按路径组件验证 `idle/000.png` 等资源。
- 启动时桌宠包扫描超时从 2.2 秒提高到 8 秒。
- 当已有 `selectedPackID` 且扫描仍在进行时，不再把桌宠错误地设为隐藏。

### 4. 桌宠窗口同步与 Windows 定位

- 桌宠子窗口监听器安装完成后发送 `focus-pet-companion-ready`，主窗口收到后重发状态与资源包，修复创建窗口时事件先发后监听的竞态。
- DPI 计算将逻辑尺寸乘以显示器缩放因子，再与物理工作区坐标组合。
- Windows 使用同步 Win32 `SetWindowPos` 设置透明桌宠窗口位置，并进行延迟重试，规避 WebView 新窗口创建后被系统级联位置覆盖。
- 窗口尺寸和位置错误不再静默吞掉；前端状态栏会显示同步失败原因。
- 添加任务栏在底部或侧边、屏幕四角等定位计算测试。

### 5. 权限、脚本和构建兼容性

- Windows 设置页使用 Windows 文案，并说明全局键鼠计数无需额外 macOS 式授权。
- 统一原生权限状态到 UI 的“已允许 / 待开启 / 预览环境 / 检查中”。
- Node ESM 脚本使用 `fileURLToPath(import.meta.url)`，避免 Windows 盘符路径被解析为 `/C:/...`。
- 验证脚本不再对所有 Windows 子进程强制 `shell: true`，仅在确实需要执行 `npm` 包装脚本时使用 shell。
- 修正 Windows `GetLastInputInfo` 验证脚本的 32 位 tick 回绕计算。
- 忽略独立 Rust target 目录，避免构建产物进入 lint 和 Git 范围。
- 添加 `windows-sys` 所需 Win32 feature 以及 `tauri-plugin-dialog` 依赖。

## XiaoDaiLocal 桌宠资源验证

测试源：`C:\Users\crush\Downloads\XiaoDaiLocal.zip`

已验证：

- 通过原生选择器成功导入。
- 资源包显示名称“小呆”，作者“栎曦_Nuo”，样式 `original_2d_catgirl`。
- 导入后位置：`C:\Users\crush\AppData\Local\Focus Pet\PetPacks\xiaodai_local`。
- 共 581 个文件、20,459,904 字节，其中 579 个 PNG、0 个音频文件。
- 23 个动作目录的 PNG 数量均与清单中的 `frameCount` 一致，结构校验 0 个不匹配。
- 主界面预览能够渲染并播放动画。
- 手工触发过 `focus`、`feed_1`，并验证过动画开关。
- 重启后资源包能够从本地库重新列出。

尚未完成：

- 23 个动作没有逐个进行真实窗口动画目视验收；目前只有结构级自动验证和部分动作手工验证。
- 资源包不包含音频，因此无法验证音频播放链路。
- 资源许可状态按本地使用处理，未确认可再分发许可；构建产物不应捆绑此用户资源包。
- 最新存储覆盖修复之后，仍需再次验证显示开关、动作设置和选择状态的跨重启持久化。

## 当前测试证据

### 本次提交前，在当前代码上重新通过

| 检查 | 结果 |
| --- | --- |
| `git diff --check` | 通过（只有 Git 的 LF/CRLF 提示） |
| TypeScript `tsc --noEmit` | 通过 |
| Oxlint | 通过，0 条错误 |
| Vitest | 3 个测试文件、37 个测试全部通过 |
| `cargo fmt --check` | 通过 |
| Rust release / gnullvm 测试 | 26 个测试全部通过 |

Rust 使用 release 模式是因为当前 Windows 环境没有 MSVC linker，gnullvm debug 测试二进制存在导出符号问题；应用和 release 测试均可使用 LLVM-MinGW 工具链构建。

### 本轮较早阶段已经观察到，但最新改动后需要复跑

- Playwright 浏览器 UI：18 个测试通过。
- 原生应用能够启动，Today、History、Pet、Settings 页面可访问。
- Windows 原生输入计数在重启后的应用中出现非零变化。
- 权限页输入监控和通知均显示“已允许”。
- “打开数据目录”成功打开资源管理器，面包屑为 `AppData > Local > Focus Pet`。
- XiaoDaiLocal 原生导入、预览和部分动作可用。
- PowerShell 直接调用同步 `SetWindowPos` 可把桌宠窗口从系统级联坐标移动到计算出的右下角坐标 `(2206, 956)`，窗口尺寸为 `330 x 460`。

这些证据不能替代最新代码的最终回归。最后一次准备点击“显示桌宠”复验时，Computer Use 被物理 Esc 中止，因此以下真实 UI 项仍标记为未完成。

## 构建产物状态

- 当前 release EXE 存在：`src-tauri/target-gnullvm/x86_64-pc-windows-gnullvm/release/focus-pet.exe`。
- 现有 NSIS 文件存在：`src-tauri/target-gnullvm/x86_64-pc-windows-gnullvm/release/bundle/nsis/Focus Pet_0.1.0_x64-setup.exe`。
- 上述 EXE 和 NSIS 的时间早于最后一批存储/窗口修复，均不能作为最终交付包，必须重新构建。
- MSI 尚未完成构建和安装验证。

## 未完成清单（按优先级）

### P0：最新代码真实窗口回归

1. 运行最新 release EXE，打开 Pet 页并启用“显示桌宠”。
2. 验证只存在一个 `Focus Pet Widget` 桌宠窗口。
3. `bottomRight` 在当前双显示器环境应落到约 `(2206, 956)`，尺寸 `330 x 460`；验证不是 Windows 级联坐标。
4. 切换 `topLeft` 后验证窗口立即移动，再切回 `bottomRight`。
5. 检查 `%LOCALAPPDATA%\Focus Pet\settings.json` 已被覆盖为最新 `hidden`/`placement`，且无 `.tmp` 残留。
6. 退出并重新启动，验证桌宠自动出现、位置与资源包选择保持不变。
7. 拖动桌宠尺寸滑杆，验证窗口尺寸变化并跨重启保留。

### P0：主功能和后端接口验收

1. 逐项冒烟测试 Today、History、Pet、Settings 的可交互功能。
2. 验证 current-status 与 recent-rhythm 两种桌面小组件的显示、隐藏、拖动/固定、位置持久化和唯一实例。
3. 验证托盘菜单：重新打开主窗口、页面跳转、桌宠/小组件开关、休息、提醒暂停和退出。
4. 验证测试通知真实出现；只打开 Windows 隐私/通知设置页面，不修改系统安全策略。
5. 验证前台应用切换、键盘、鼠标、空闲恢复和锁屏检测的长时间计数稳定性。
6. 验证数据导出、日志目录/当前日志、清理数据等接口；删除或清理动作需在测试数据上明确确认后执行。

### P0：完整自动门禁

需要在最新代码上重新执行：

```powershell
npm run lint
npm run verify:preflight
npm run verify:native
npm run verify:tauri-contract
npm run verify:migration
npm run verify:frontend-tokens
npm run build
npm test
npm run test:ui
```

还应运行：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --release --target x86_64-pc-windows-gnullvm --manifest-path src-tauri/Cargo.toml
```

### P1：最终安装包

1. 先重新构建前端和最新 Tauri release EXE。
2. 构建 NSIS，并确认时间戳、文件大小与最新提交对应。
3. 尝试构建 MSI；若 WiX/VBScript 或 gnullvm 组合不支持，记录精确错误并补齐 Windows 构建依赖。
4. 在本机安装 NSIS/MSI，验证启动、数据目录、桌宠导入、托盘、通知和卸载。
5. 确认安装/卸载不删除用户数据，除非安装器明确提供并由用户选择该选项。

## 当前 Windows 构建环境

本机没有可用的 MSVC linker，因此使用以下组合：

- Node：`C:\Users\crush\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`
- Rust target：`stable-x86_64-pc-windows-gnullvm`
- LLVM-MinGW：`C:\Users\crush\AppData\Local\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\llvm-mingw-20260616-ucrt-x86_64\bin`
- Cargo target dir：`src-tauri\target-gnullvm`

示例：

```powershell
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-gnullvm'
$env:PATH = 'C:\Users\crush\AppData\Local\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\llvm-mingw-20260616-ucrt-x86_64\bin;C:\Users\crush\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:USERPROFILE + '\.cargo\bin;' + $env:PATH
$env:CARGO_TARGET_DIR = 'C:\Users\crush\code\focus_pet_tauri\src-tauri\target-gnullvm'
```

前端可直接调用 bundled Node：

```powershell
& 'C:\Users\crush\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' '.\node_modules\vite\bin\vite.js' build
```

## 续作建议

下一步应从“最新代码真实窗口回归”开始。先验证 Windows 原子覆盖修复让 `settings.json` 真正更新，再验证 `SetWindowPos` 的自动定位；这两项决定桌宠窗口是否能稳定跨重启工作。完成后再扩展到小组件、托盘、通知、完整门禁和安装器。不要使用现有旧 NSIS 文件作为验收证据。
