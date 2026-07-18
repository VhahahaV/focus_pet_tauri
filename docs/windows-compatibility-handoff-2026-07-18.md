# Windows 兼容性阶段记录（2026-07-18）

## 当前结论

`focus_pet_tauri` 的 Windows 主阻塞项已经解决：桌宠可以显示和切换位置，输入与前台切换事件可以持续采集，GPU 显示真实 PDH 数据，数据目录与安装目录已隔离，NSIS 安装版可以启动并保留 XiaoDai 资源和用户历史。

- 工作分支：`codex/windows-compatibility`
- 基线提交：`5d4006c`（`Polish dashboard cards and desktop widgets`）
- 阶段提交：`41f61eb`（`feat: improve Windows compatibility and persistence`）
- 测试平台：Windows x86_64、PowerShell、Rust `stable-x86_64-pc-windows-gnullvm`
- 最终安装回归：NSIS 已通过；MSI 已成功构建，但本机无提权权限，静默安装按预期被 Windows Installer 以错误 1925 拒绝

本轮不是“所有功能均已验收完成”。文末仍列有托盘、通知、锁屏、全部桌宠动作等后续项目。

## 已完成的兼容性开发

### 1. 桌宠不可见与 IPC 停滞

根因是同步 Tauri command 在 Windows WebView2 线程中创建子窗口，执行会停在 `WebviewWindowBuilder::build` / `window.hwnd()`。失败时只能看到 `about:blank` 子窗口，并会阻塞之后的 IPC、监控采样和存储写入。

修复内容：

- `sync_widget_windows` 改为异步命令。
- 新窗口在 builder 阶段直接设置初始坐标。
- 已存在窗口使用 Tauri `set_position` 更新位置。
- 移除 HWND 获取、直接 `SetWindowPos` 和延迟重试线程。
- 桌宠窗口发送 `focus-pet-companion-ready` 后，主窗口会重发状态和资源包，消除监听安装时序竞争。
- 新增 `usePetFrames`，统一预加载动作帧，并在动作资源短暂不可用时回退预览图。
- 显示开关会立即刷新窗口并持久化设置。

真实窗口验证：

- `bottomRight`：`(2206, 956)`。
- `topLeft`：`(24, 24)`，切回右下角成功。
- 当前桌宠窗口外框：`330 x 480`；逻辑桌宠大小设置为 `150px`。
- 重启后仅存在一个桌宠窗口；XiaoDai、`feed_1` 映射、显示状态、大小和位置均保留。
- NSIS 安装版桌宠已真实渲染 XiaoDai 动画。

### 2. Windows 输入与前台切换监控

`src-tauri/src/native/windows.rs` 现直接使用 Win32 API：

- `GetForegroundWindow`、`GetWindowTextW`、`GetWindowThreadProcessId` 获取前台程序。
- `GetLastInputInfo` 获取系统空闲时间。
- `WH_KEYBOARD_LL` 与 `WH_MOUSE_LL` 在独立消息线程中统计键盘和指针事件。
- `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` 记录同一个采样窗口内的多次进程切换。
- `OpenInputDesktop` / `SwitchDesktop` 检查锁屏或不可交互桌面。
- 计数使用饱和加法，避免长时间运行整数回绕。

真实数据验证：

- 后端状态：`win32-foreground-low-level-input-hooks`。
- 新分钟桶记录到 `keyboardCount: 1`、`pointerCount: 3`。
- Focus Pet 与记事本快速往返切换，分钟桶记录到 `switchCount: 2`。
- `app-usage.json`、`state-segments.json`、`input-activity.json` 在桌宠显示期间持续更新。

### 3. Windows GPU 采样

`src-tauri/src/system_monitor.rs` 使用持久 PDH query 和英文性能计数器 `GPU Engine(*)\\Utilization Percentage`。采样会按物理 GPU engine 聚合进程实例，并取各 engine 的忙碌度之和。

- 后端实测：`23.81718%`。
- 安装版 UI 实测：约 `21%`。
- 无计数器时返回 `null` 并显示 `—`，不再将不可用错误显示为 `0%`。

### 4. 数据目录、迁移与原子写入

Windows 正式数据根目录改为：

`C:\Users\crush\AppData\Local\Focus Pet Data`

NSIS 当前用户安装目录为：

`C:\Users\crush\AppData\Local\Focus Pet`

二者分离，避免卸载程序删除历史、设置和桌宠包。迁移逻辑只复制已知 JSON、`Logs` 和 `PetPacks`，不会复制 `focus-pet.exe`、`uninstall.exe` 等安装文件，也不会主动删除旧数据源。

其他修复：

- 使用当前进程令牌和 `GetUserProfileDirectoryW` 获取真实用户目录，避免宿主环境路径重定向。
- Windows JSON 快照使用 `MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)` 原子替换。
- `data_storage_path`、`open_data_folder` 和文件/目录区分的 `open_path` 已接入。
- 新增回归测试验证重复覆盖保存与安全迁移；Rust 测试总数增至 28。

安装、卸载、重新安装验证后，`Focus Pet Data\schema.json` 和 `PetPacks\xiaodai_local\pet.json` 均保留。

### 5. 安装版缺少 WebView2Loader

LLVM-MinGW/gnullvm 产物会动态依赖 `WebView2Loader.dll`。最初的 NSIS 仅安装 EXE，导致进程存在但没有窗口，并弹出“找不到 WebView2Loader.dll”。

修复内容：

- 将 webview2-com-sys 0.38.2 的官方 x64 loader 作为 Windows 专用资源放入 `src-tauri/resources/windows/WebView2Loader.dll`。
- 新增 `src-tauri/tauri.windows.conf.json`，将 loader 安装到应用 EXE 同级目录。
- NSIS 生成脚本和 MSI WiX 定义均已确认包含该文件。

Loader 校验：

- 大小：160,320 字节。
- SHA-256：`8427B1FC58EC707813E5C0A51EB5D69397BB333250A7B891BE4D3B123F1E0F1C`。

重新安装 NSIS 后，主窗口和桌宠都能从 `C:\Users\crush\AppData\Local\Focus Pet\focus-pet.exe` 启动。历史缺 DLL 诊断弹窗已全部清除。

### 6. 权限、目录跳转与验证脚本

- 文件和文件夹选择改用 `tauri-plugin-dialog`，移除 PowerShell/Windows Forms 依赖。
- Windows 设置跳转使用 `ms-settings:privacy-general` 和 `ms-settings:notifications`。
- Windows 全局输入计数不伪装成 macOS 式授权；UI 统一显示“已允许 / 待开启 / 预览环境 / 检查中”。
- Node ESM 脚本使用 `fileURLToPath(import.meta.url)`，正确处理 Windows 盘符路径。
- 验证脚本只在运行 npm 包装命令时使用 shell，不再让全部 Windows 子进程强制 `shell: true`。
- 修复 `GetLastInputInfo` 32 位 tick 回绕验证。
- 验证并保留 VBScript/WiX 打包前置条件。

## XiaoDaiLocal 资源包验证

测试源：`C:\Users\crush\Downloads\XiaoDaiLocal.zip`

本地资源库：`C:\Users\crush\AppData\Local\Focus Pet Data\PetPacks\xiaodai_local`

已验证：

- 可通过原生选择器导入，重启后可重新列出。
- 资源包名称“小呆”，格式 `original_2d_catgirl`。
- 共 581 个文件、20,459,904 字节，其中 579 个 PNG、0 个音频文件。
- 23 个动作目录的 PNG 数量均与清单 `frameCount` 一致，结构校验 0 个不匹配。
- 主界面预览和透明桌宠窗口均可播放动作。
- 手工触发过 `focus` 与 `feed_1`，动画开关有效。
- 资源包选择和动作映射在重启及卸载/重装后保留。

限制：资源包不包含音频，无法用该包验证音频链路；许可状态按仅限本地测试处理，安装包不会捆绑该用户资源。

## 自动化验证结果

完整 `verify:platform` 在本轮主功能改动后通过，覆盖 contracts、migration、frontend tokens、TypeScript、Vite、Vitest、Oxlint、Playwright、Rust fmt/check/test 和 Tauri bundle。

最新数据目录和打包资源改动后又复跑：

| 检查 | 结果 |
| --- | --- |
| `git diff --check` | 通过，仅有 Git 的 LF/CRLF 提示 |
| TypeScript build | 通过 |
| Oxlint | 通过，0 条错误 |
| Vitest | 3 个文件、37 个测试全部通过 |
| Playwright | desktop/mobile 共 18 个测试全部通过 |
| `cargo fmt --check` | 通过 |
| Rust release / gnullvm | 28 个测试全部通过 |
| 原生适配验证 | 输入、前台进程、idle、通知 helper、原生对话框全部通过 |
| 打包 preflight | 通过，包含 VBScript |

## 构建与安装产物

### NSIS

- 路径：`src-tauri/target-gnullvm/release/bundle/nsis/Focus Pet_0.1.0_x64-setup.exe`
- 大小：7,472,200 字节
- 时间：2026-07-18 16:51:20
- SHA-256：`5D246472EE76BCF131DDCF9F8845C67D89EFAE683CEF115E6E3228E1EEC288D5`
- 状态：安装、启动、桌宠、实时监控、卸载数据保留、重新安装均已通过。

### MSI

- 路径：`src-tauri/target-gnullvm/release/bundle/msi/Focus Pet_0.1.0_x64_en-US.msi`
- 大小：8,896,512 字节
- 时间：2026-07-18 16:51:06
- SHA-256：`137372868F61239AFFF6CC59FB2FF0C4FBB6ED32DCFA9F80CBCF024E50682F63`
- 状态：构建通过。当前 MSI 为按机器安装，本机无管理员提权权限；静默安装返回 1603，日志中的精确原因是错误 1925（权限不足）。需要在管理员终端或干净 VM 中完成最终安装回归。

## 真实 UI 已验证范围

- Today、History、Pet、Settings 页面可访问。
- CPU、内存、磁盘、GPU 实时更新。
- 活动时间窗能显示键盘、鼠标和切换信号。
- `current-status` 与 `recent-rhythm` 两种桌面卡均可创建、渲染且保持唯一实例；测试后已全部隐藏。
- 桌宠在主程序运行期间不阻塞监控和存储。
- NSIS 安装版最终状态为一个主窗口和一个桌宠窗口，无缺 DLL 错误弹窗。

## 仍未完成的工作（后续优先级）

### P0：需要继续做真实 Windows 回归

1. 托盘菜单全链路：重新打开主窗口、页面跳转、桌宠/小组件开关、休息、提醒暂停和退出。
2. 测试通知真实进入 Windows 通知中心，并验证通知设置跳转；不要自动修改系统隐私策略。
3. 小组件拖动、固定、位置跨重启持久化。
4. 数据导出、日志目录、当前日志和“清理数据”接口；清理必须只在临时测试数据上验证。
5. 长时间监控：空闲恢复、锁屏/解锁、32 位 tick 回绕附近行为、钩子线程异常恢复。
6. 在管理员终端或干净 Windows VM 安装 MSI，并复验 loader、启动、卸载和数据保留。

### P1：桌宠完整验收

1. 逐个目视验证 XiaoDai 的 23 个动作，而不仅是结构校验。
2. 补测大小滑杆跨重启和多 DPI / 多显示器位置。
3. 使用包含音频且许可清晰的测试包验证音频播放链路。
4. 验证异常包、超大包、中断导入、重复导入和删除资源包后的恢复行为。

### P1：发布准备

1. 在干净 Windows 机器验证没有预装开发工具时的启动行为。
2. 给 EXE/MSI/NSIS 增加正式代码签名并验证 SmartScreen/安装来源显示。
3. 决定 MSI 是否继续按机器安装，或另行提供无需管理员权限的按用户 MSI。
4. 将上述手工回归项目固化为发布清单，保留屏幕截图和日志证据。

## 继续开发建议

下一轮从托盘、通知和数据导出/清理接口开始，再做锁屏长稳与 23 个桌宠动作目视验收。桌宠不显示、IPC 停滞、输入信号缺失、GPU 假 0、数据目录与安装目录冲突、NSIS 缺 WebView2Loader 已不再是阻塞项。
