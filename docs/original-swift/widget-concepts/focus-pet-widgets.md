# Focus Pet 小组件规划

目标：让桌面小组件成为 Focus Pet 的扫读入口，而不是把 dashboard 缩小。先落地两个最高频入口：当前状态 Small 和最近节奏 Medium。

## 信息源

可直接复用现有模型：

| 信息 | 现有来源 | 小组件用途 |
| --- | --- | --- |
| 当前状态 | `currentDecision.state` / `stableDuration` | 判断现在是专注、走神、休息还是暂离 |
| 当前 App | `currentSnapshot.appName` / `category` | 只显示 App 名和分类，不显示窗口标题 |
| 今日统计 | `summary.focusSeconds` / `distractedSeconds` / `breakSeconds` / `awaySeconds` | 在当前状态里给出专注、走神、休息的短摘要 |
| 最近节奏 | `InputTimelineSnapshot(windowSeconds:)` / `stateSegments` / `inputActivity` | 按 4h、8h、12h 展示最近分布和微型时间线 |
| 当前专注任务 | `activeFocusSession` | 展示任务名、剩余时间、完成进度 |
| 当前休息 | `activeBreakSession` | 展示休息倒计时和恢复状态 |
| 输入与切换 | `todayWorkload` | 展示输入量、操作量、上下文切换 |
| 提醒状态 | `nudges` / `settings.reminder` | 展示最近提醒、暂停状态、下一步建议 |
| 宠物状态 | `currentPetIntentKind` / selected pack preview | 展示宠物心情和提醒语气 |

隐私默认：不在小组件展示窗口标题；只展示 App 名、状态、类别和本地汇总。用户打开原始标题存储时，也建议小组件默认仍不展示标题。

## 组件组

| 组件 | 尺寸 | 核心问题 | 展示内容 |
| --- | --- | --- | --- |
| 当前状态 | Small | 我现在处于什么节奏？ | 大号当前状态、持续时长、键盘/鼠标次数、专注/走神/休息时间 |
| 专注计时 | Medium | 当前任务还剩多久？ | 任务名、剩余时间、完成环、专注/走神短条 |
| 最近节奏 | Medium | 最近几个小时是否稳定？ | 4h / 8h / 12h 切换、专注占比、状态分布、微型时间线 |
| 宠物伙伴 | Medium | 桌宠现在在表达什么？ | 宠物图、当前意图、最近提醒、提醒开关状态 |
| 休息提醒 | Small | 现在该不该休息？ | 连续专注时长、建议休息分钟、提醒暂停状态 |
| 今日复盘 | Large | 今天整体质量如何？ | 总专注、专注占比、Top App/类别、输入和切换、最近工作段 |

## 设计原则

1. 当前状态 Small 以状态文字最大，例如“专注中”，时长和原因做副信息。
2. 当前状态 Small 参考悬浮窗做 2x2/2x3 的短摘要，信息只保留键盘、鼠标、专注、走神、休息。
3. 最近节奏 Medium 用一条主叙事加一个轻量图表，适合桌面常驻。
4. 大号用于复盘，允许更高信息密度，但仍不出现规则管理、诊断细节或设置项。
5. 颜色沿用 Focus Pet 状态色：专注蓝、走神琥珀、休息绿、暂离灰蓝，并加入少量宠物暖色。
6. 文案保持动作导向，例如“回到任务 2 分钟”“建议休息 5 分钟”，不解释识别算法。

## 落地建议

后续实现建议新增一个轻量共享快照：

```swift
public struct WidgetSnapshot: Codable, Sendable {
    public var generatedAt: Date
    public var currentState: FocusState
    public var stableDuration: TimeInterval
    public var currentAppName: String
    public var currentCategory: ActivityCategory
    public var summary: DailySummary
    public var workload: InputWorkloadSummary
    public var recentRhythms: [WidgetRhythmSnapshot]
    public var activeFocusSession: FocusSession?
    public var activeBreakSession: BreakSession?
    public var latestNudge: NudgeEvent?
    public var reminderPauseUntil: Date?
    public var petIntentTitle: String
    public var selectedPetPackID: String
}

public struct WidgetRhythmSnapshot: Codable, Sendable {
    public var windowHours: Int
    public var focusSeconds: Int
    public var distractedSeconds: Int
    public var breakSeconds: Int
    public var awaySeconds: Int
    public var timelineRanges: [WidgetRhythmRange]
}

public struct WidgetRhythmRange: Codable, Sendable {
    public var state: FocusState
    public var startOffsetRatio: Double
    public var widthRatio: Double
}
```

主 App 每次 `advanceStateTick()`、summary 刷新、专注/休息 session 变化时写入轻量 JSON；Widget extension 的 TimelineProvider 只读这个快照。这样 WidgetKit 不需要直接依赖活跃监听器，也不会重复采样系统权限。分发构建应使用真实 Apple Development 或 Developer ID 签名；如后续启用 App Group，应把主 App 和 Widget extension 的 entitlements 同步到同一个 group，再把快照路径迁移到 group 容器。

最近节奏的 4h / 8h / 12h 推荐做成 Widget 配置项或 AppIntent 参数；如果先做静态版本，默认选 4h，并在小组件右上角展示分段按钮样式。

刷新策略：

| 场景 | 刷新 |
| --- | --- |
| 状态切换 | 主 App 写快照并触发 `WidgetCenter.shared.reloadTimelines` |
| 最近节奏切换 | Widget 配置选择 4h / 8h / 12h 后读取对应 `WidgetRhythmSnapshot` |
| 专注/休息倒计时 | Timeline 每 1 分钟刷新 |
| 今日复盘 | 每 10 到 15 分钟刷新 |
| 记录暂停或权限缺失 | 小组件显示“本地记录已暂停”或“需要打开主 App” |

## 备用入口

macOS 原生小组件图库不提供公开 API 让第三方应用强制把组件加入桌面。当前测试机只有 ad-hoc 签名时，PlugInKit 可以注册扩展，但 `chronod` 仍可能把它识别为 restricted or unknown extension 并从图库里隐藏。

为保证流程可用，Focus Pet 同时提供应用内“桌面状态卡”：菜单栏图标中选择“桌面状态卡”，主 App 会用普通 `NSPanel` 在桌面上渲染当前状态 Small 和最近节奏 Medium 两张卡片。它复用同一份 `FocusPetWidgetSnapshot` 和小组件 SwiftUI 视图，不依赖系统小组件编辑器。

优先实现顺序：

1. 当前状态 Small
2. 最近节奏 Medium
3. 专注计时 Medium
4. 宠物伙伴 Medium
5. 今日复盘 Large
6. 休息提醒 Small
