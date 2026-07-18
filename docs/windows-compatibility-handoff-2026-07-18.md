# Windows 兼容性阶段记录（2026-07-18）

## 当前结论

`focus_pet_tauri` 的 Windows 主阻塞项已经解决：桌宠可以显示和切换位置，输入与前台切换事件可以持续采集，GPU 显示真实 PDH 数据，数据目录与安装目录已隔离，NSIS 安装版可以启动并保留 XiaoDai 资源和用户历史。继续回归时又修复了原生脱敏导出仍包含私密字段、诊断按钮未写入本机日志，以及“清空数据”误删桌宠包和设置三个问题。

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
- 拖动事件保存的是物理像素坐标；新建窗口现在先隐藏创建，再用 `PhysicalPosition` 精确落位后显示，避免 125%/150% DPI 下把物理坐标误当逻辑坐标。
- 有效的负坐标会保留给左侧/上方副屏；显示器拔除或坐标失效时，窗口会按目标显示器缩放比例钳制回可见工作区。

真实窗口验证：

- `bottomRight`：`(2206, 956)`。
- `topLeft`：`(24, 24)`，切回右下角成功。
- 当前桌宠窗口外框：`330 x 480`；逻辑桌宠大小设置为 `150px`。
- 重启后仅存在一个桌宠窗口；XiaoDai、`feed_1` 映射、显示状态、大小和位置均保留。
- NSIS 安装版桌宠已真实渲染 XiaoDai 动画。

### 2. Windows 输入与前台切换监控

`src-tauri/src/native/windows.rs` 现直接使用 Win32 API：

- `GetForegroundWindow`、`GetWindowTextW`、`GetWindowThreadProcessId` 获取前台程序。
- `QueryFullProcessImageNameW` 因受限进程权限失败时，使用 ToolHelp 进程快照解析 exe 名称，避免分类和排行退化成 `Windows process <pid>`。
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
- 移除只能启动一次的 `OnceLock`：钩子安装失败或消息循环退出后，会在 5 秒退避后重新创建监控线程；线程异常退出时由守卫复位运行状态。
- idle 输入补偿只在采样明确标记为 fallback 时启用，低级钩子可用时不再伪造键盘/鼠标双计数。
- 键盘、鼠标和前台切换三类钩子现在必须全部安装成功才标记为“完整可用”；任一钩子失败都会释放本轮钩子并进入 5 秒自愈重试，避免前台切换钩子失效时仍假报健康。
- Windows 安全桌面单独输出 `Locked Screen` 采样，清除 bundle ID、窗口标题和输入/切换计数，避免泄露锁屏前窗口或把锁屏过渡计数延迟写到解锁后的活动桶。
- Tauri 原生采样失败时不再把浏览器预览的模拟键盘、鼠标、切换和应用信号写入真实历史；该轮会跳过并显示故障状态，原生采样恢复后再继续记录。浏览器预览环境仍保留模拟数据。
- 最新安装版复验显示键盘 258 次、鼠标 163 次、切换 31 次，计数和 GPU 采样持续更新。

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
- NSIS 的当前用户安装目录 `%LOCALAPPDATA%\Focus Pet` 现在会被正确识别为已安装，不再只认可 `%LOCALAPPDATA%\Programs`；路径判断带目录边界，不会把相似前缀误判为安装目录。
- Agent 完成事件 inbox 已从分裂的 `%APPDATA%\Focus Pet\agent-events.jsonl` 统一到 `%LOCALAPPDATA%\Focus Pet Data\agent-events.jsonl`；读取端仍会排空旧 Roaming 路径中的遗留事件，并按发生时间合并，避免升级后漏通知。
- Windows 全局输入计数不伪装成 macOS 式授权；UI 统一显示“已允许 / 待开启 / 预览环境 / 检查中”。
- Node ESM 脚本使用 `fileURLToPath(import.meta.url)`，正确处理 Windows 盘符路径。
- Windows `app_icon` 不再无条件返回空值：当原生采样提供可执行文件路径时，后端通过系统 `System.Drawing.Icon` 提取关联图标并缓存为 PNG；路径以环境变量传入子进程，避免脚本拼接注入，提取失败时安全回退字母占位。
- 验证脚本只在运行 npm 包装命令时使用 shell，不再让全部 Windows 子进程强制 `shell: true`。
- 修复 `GetLastInputInfo` 32 位 tick 回绕验证。
- 验证并保留 VBScript/WiX 打包前置条件。
- Windows 通知 fallback 会保持 NotifyIcon 到完整显示时长，通知命令改到阻塞线程执行，避免 4 秒 PowerShell fallback 卡住 Tauri IPC。标题和正文只通过子进程环境变量传递，不再拼接进 PowerShell 脚本；换行、Unicode 和类似 here-string 终止符的内容不会改变脚本结构，且 PowerShell 使用无窗口启动标志，避免通知时闪出控制台。
- UI 明确提示 Windows 勿扰模式可能抑制系统横幅。本机实测通知命令成功返回，但通知中心显示“勿扰模式已开启”，因此当前环境没有显示 Focus Pet 横幅；应用没有擅自关闭系统勿扰设置。

### 7. 脱敏导出与诊断日志

- 修复 Tauri 原生脱敏导出：脱敏转换现在发生在调用 Rust 写文件之前，而不是只用于浏览器 Blob fallback。
- Rust `export_snapshot` 同样执行服务端脱敏，形成前端预处理与原生写盘的双重保护；即使未来调用方漏做转换，也不会把规则、标题、bundle ID、真实应用名或任务名写入脱敏文件。
- 安装版生成的最新脱敏文件已验证：规则数 0、`storeRawTitle: false`、`storeOnlyCategoryResult: true`、bundle ID 0、保留标题 0、异常真实应用名 0、私密专注任务名 0。
- 完整导出和脱敏导出都会写入 `Focus Pet Data`，并能在 UI 显示“打开最近导出”。
- 新增 `append_log_entry` Tauri 接口；“写入诊断”现在会向每日 `focus-pet-YYYY-MM-DD.log` 追加 JSON Lines，而不再只写 WebView 控制台。
- 安装版实测日志条目包含 kind、time、state、app、reason 和输入监控状态，文件可从日志目录和“打开日志”入口访问。

### 8. 数据清理安全与托盘动作

- Windows 原生 `delete_all_data` 过去会递归删除整个 `Focus Pet Data`，与前端“仅清空统计数据”的语义不一致，并会误删 `PetPacks`、设置、规则、日志和导出。
- 原生层现在只删除状态片段、应用使用、输入活动、专注会话和提醒记录五类活动文件。
- 隔离临时目录回归确认：活动数据全部归零，设置、分类规则、XiaoDai 类桌宠包、日志、导出和 schema 全部保留；没有在当前用户真实历史上执行破坏性清理。
- Windows 托盘和桌面菜单补齐“恢复提醒”“结束当前专注”，并为原生动作增加白名单；前端测试覆盖页面跳转、桌宠/小组件切换、暂停/恢复提醒和结束专注。

## XiaoDaiLocal 资源包验证

测试源：`C:\Users\crush\Downloads\XiaoDaiLocal.zip`

本地资源库：`C:\Users\crush\AppData\Local\Focus Pet Data\PetPacks\xiaodai_local`

已验证：

- 可通过原生选择器导入，重启后可重新列出。
- 资源包名称“小呆”，格式 `original_2d_catgirl`。
- 共 581 个文件、20,459,904 字节，其中 579 个 PNG、0 个音频文件。
- 579 个 PNG 已全部通过 Windows `System.Drawing.Image` 实际解码，0 个损坏；图片尺寸分布覆盖 7 组，主体帧宽度均为 358 px。
- 23 个源动作与 19 个运行时意图映射的 PNG 数量均与各自清单 `frameCount` 一致，结构校验 0 个不匹配。
- 主界面预览和透明桌宠窗口均可播放动作。
- 手工触发过 `focus` 与 `feed_1`，动画开关有效。
- 为 23 个源动作生成了首帧/中间帧/末帧联系表并逐行目视检查：行走、睡眠、拖拽、边缘、坠落、落地、抚摸、喂食、玩球和受扰等姿态与动作 ID 一致，未发现空帧、错目录或明显损坏。
- 将安装版桌宠临时移到左上角避开系统通知遮罩后，Computer Use 两次观察到不同 XiaoDai 动画帧；窗口为 `(24, 24)`、`330 x 480`，重启后仍保持唯一窗口和相同位置。测试后已恢复用户原来的 `bottomRight` 设置。
- 帧推进逻辑已抽成可测试纯函数，覆盖循环回到首帧、一次性动作停在末帧、关闭动画保持当前帧和越界索引钳制；Playwright 还真实点击桌宠“动作”按钮，验证 `待机 → 睡觉 → 轻提醒 → 待机` 完整循环。
- 资源包选择和动作映射在重启及卸载/重装后保留。
- 导入器现在会拒绝缺失或重复的源动作 ID、源动作帧数不匹配、绝对路径和 `..` 越界的动作/音频资源路径；目录复制不会跟随符号链接。

限制：资源包不包含音频，无法用该包验证音频链路；许可状态按仅限本地测试处理，安装包不会捆绑该用户资源。

## 自动化验证结果

完整 `verify:platform` 在本轮主功能改动后通过，覆盖 contracts、migration、frontend tokens、TypeScript、Vite、Vitest、Oxlint、Playwright、Rust fmt/check/test 和 Tauri bundle。

最新数据目录和打包资源改动后又复跑：

| 检查 | 结果 |
| --- | --- |
| `git diff --check` | 通过，仅有 Git 的 LF/CRLF 提示 |
| TypeScript build | 通过 |
| Oxlint | 通过，0 条错误 |
| Vitest | 3 个文件、40 个测试全部通过 |
| Playwright | desktop/mobile 共 18 个测试全部通过 |
| `cargo fmt --check` | 通过 |
| Rust release / gnullvm | 44 个测试全部通过；新增通知文本环境变量隔离回归 |
| 原生适配验证 | 输入、前台进程、idle、通知 helper、原生对话框全部通过 |
| 打包 preflight | 通过，包含 VBScript |

## 构建与安装产物

### NSIS

- 路径：`src-tauri/target-gnullvm/x86_64-pc-windows-gnullvm/release/bundle/nsis/Focus Pet_0.1.0_x64-setup.exe`
- 大小：7,500,830 字节
- 时间：2026-07-18 20:42:02
- SHA-256：`065C6B4B24084780C48F231C7170DB71F516CBBE6CFF8960C497489494C5D2E2`
- 状态：安装、启动、桌宠、实时监控、卸载数据保留、重新安装均已通过。

### MSI

- 路径：`src-tauri/target-gnullvm/x86_64-pc-windows-gnullvm/release/bundle/msi/Focus Pet_0.1.0_x64_en-US.msi`
- 大小：8,933,376 字节
- 时间：2026-07-18 20:41:50
- SHA-256：`37C14359A43C2C66C04D6CBE961A2464F98C398E9D538A7832A7BAA1024A4B24`
- 状态：构建通过。当前 MSI 为按机器安装，本机无管理员提权权限；静默安装返回 1603，日志中的精确原因是错误 1925（权限不足）。需要在管理员终端或干净 VM 中完成最终安装回归。

## 真实 UI 已验证范围

- Today、History、Pet、Settings 页面可访问。
- CPU、内存、磁盘、GPU 实时更新。
- 活动时间窗能显示键盘、鼠标和切换信号。
- `current-status` 与 `recent-rhythm` 两种桌面卡均可创建、渲染且保持唯一实例；测试后已全部隐藏。
- 桌宠在主程序运行期间不阻塞监控和存储。
- NSIS 安装版最终状态为一个主窗口和一个桌宠窗口，无缺 DLL 错误弹窗。
- 最新 NSIS 静默安装返回 0，安装前后 schema、XiaoDai 清单和诊断日志 SHA-256 完全一致；安装后主窗口复验显示 GPU 从 4% 更新到 25%，键盘 253 次、鼠标 151 次、切换 33 次，专注持续时间继续增长。
- 监控可靠性修复后的安装版再次静默安装返回 0，schema 与 XiaoDai 清单哈希不变；主界面显示“Focus Pet 0.1.0 已就绪”，确认 `%LOCALAPPDATA%\Focus Pet` 被识别为已安装。等待两个采样周期后活动文件持续更新，全部本地 JSON 中 `browser-preview` 命中数为 0；界面显示 GPU 4%、键盘 273 次、鼠标 151 次、切换 34 次。
- Agent inbox 修复后的安装版静默安装返回 0；应用停止时执行正式 `focus-pet.exe --agent-notify codex <payload>` 返回 0，只在 Local 数据根创建包含指定测试 ID 的 inbox，Roaming 路径未创建；启动应用 4 秒后 inbox 已被轮询排空。
- 应用图标修复后的安装版静默安装返回 0；Today 排行自然触发后在 `%LOCALAPPDATA%\com.focuspet.FocusPet\app-icons` 生成 6 个 PNG 缓存，Explorer 与 Focus Pet 图标已实际打开确认有效，Computer Use 截图也显示 ShellExperienceHost 和最常用应用已从字母占位切换为原生图标。
- ToolHelp 进程名兜底后的安装版静默安装返回 0；历史中的 `Windows process <pid>` 段安装前后均为 1，没有新增，最新三个应用段均解析为 `ShellExperienceHost` 及完整 exe 路径，最新输入分钟桶继续写入。
- 通知文本隔离修复后的 gnullvm NSIS 静默覆盖安装返回 0；安装前后的 schema、用户设置和 XiaoDai `pet.json` SHA-256 完全一致。Computer Use 捕获主界面显示 CPU 22%、内存 67%、磁盘 93%、GPU 23%，最近 4 小时键盘 298 次、鼠标 116 次、切换 40 次，原生监控数据仍可读取。
- 数据目录、日志目录、完整导出、脱敏导出和 JSON Lines 诊断日志已在安装版验证。
- Windows 通知测试命令完成，但当前系统“勿扰模式”开启；通知中心没有记录 Focus Pet 横幅，此项需在关闭勿扰模式的测试机复验。
- 当前 Windows 通知/日历遮罩占据右下角并拒绝 Computer Use 激活其他窗口；默认位置的桌宠窗口存在于 `(2206, 956)`、大小 `330 x 480`，画面被遮罩完整覆盖。为排除渲染故障，本轮将最新安装版桌宠临时移至 `(24, 24)`，Computer Use 实际看到 XiaoDai，且相隔 1.4 秒的两次截图显示不同动画帧；随后已恢复 `bottomRight`，设置文件哈希恢复到安装前值并重新启动应用。

## 仍未完成的工作（后续优先级）

### P0：需要继续做真实 Windows 回归

1. 托盘动作代码链和自动化测试已经通过；仍需在没有系统通知中心遮罩的会话中逐项物理点击托盘菜单，复验重新打开、页面跳转、桌宠/小组件开关、暂停/恢复提醒、结束专注和退出。
2. 在关闭 Windows 勿扰模式的测试机验证通知横幅和通知中心记录，并验证通知设置跳转；不要自动修改系统隐私策略。
3. 小组件的物理/逻辑 DPI 换算、负坐标副屏和失效坐标回屏已由自动化覆盖；仍需真实拖动、固定并跨重启目视复验。
4. 长时间监控：空闲恢复、锁屏/解锁与 32 位 tick 回绕附近行为；锁屏字段隔离、钩子完整健康判定、线程异常恢复和 5 秒重试已由自动化覆盖，仍需真实锁屏/解锁长程复验。
5. 在管理员终端或干净 Windows VM 安装 MSI，并复验 loader、启动、卸载和数据保留。

### P1：桌宠完整验收

1. XiaoDai 的 579 个图片、23 个源动作和 19 个意图映射已完成解码、帧数校验与首/中/末帧目视检查；通用循环/一次性播放逻辑和组件动作切换已自动化覆盖。若发布验收要求逐动作实时录像，仍需在无系统遮罩会话中录制 23 个动作的完整播放过程。
2. 补测大小滑杆跨重启和多 DPI / 多显示器位置。
3. 使用包含音频且许可清晰的测试包验证音频播放链路。
4. 验证异常包、超大包、中断导入、重复导入和删除资源包后的恢复行为。

### P1：发布准备

1. 在干净 Windows 机器验证没有预装开发工具时的启动行为。
2. 给 EXE/MSI/NSIS 增加正式代码签名并验证 SmartScreen/安装来源显示。
3. 决定 MSI 是否继续按机器安装，或另行提供无需管理员权限的按用户 MSI。
4. 将上述手工回归项目固化为发布清单，保留屏幕截图和日志证据。

## 继续开发建议

下一轮从无系统遮罩状态下的托盘物理点击、关闭勿扰模式后的通知回归开始，再做小组件拖动持久化、锁屏长稳与 23 个桌宠动作目视验收。桌宠不显示、IPC 停滞、输入信号缺失、GPU 假 0、数据目录与安装目录冲突、NSIS 缺 WebView2Loader、原生脱敏泄露、诊断日志空写和清理数据误删资源已不再是阻塞项。
