import {
  Bell,
  Bot,
  CheckCircle2,
  Clock3,
  CircleAlert,
  CircleCheck,
  Globe2,
  Info,
  Keyboard,
  LoaderCircle,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useFocusPet } from "../app/AppContext";
import { categoryLabels } from "../core/labels";
import { formatDate, formatDuration } from "../core/formatters";
import { judgmentPresetSettings, matchingJudgmentPreset, type JudgmentSensitivityPreset } from "../core/settings";
import { CommandButton } from "./common";
import { SegmentedControl, Stepper, TogglePill } from "./ui";
import { appThemes } from "../themes";
import { codexSessionIsActive } from "../core/codexSessions";

type SettingsModuleID = "appearance" | "desktopWidgets" | "reminders" | "recognition" | "about";
type SettingsStatus = "focus" | "distracted" | "info" | "warning" | "pet" | "success" | "neutral";

const settingsModules: Array<{
  id: SettingsModuleID;
  title: string;
  subtitle: string;
  Icon: LucideIcon;
  status: SettingsStatus;
}> = [
  { id: "appearance", title: "外观主题", subtitle: "全局视觉语言", Icon: Palette, status: "pet" },
  { id: "desktopWidgets", title: "桌面状态卡", subtitle: "当前与节奏卡", Icon: Monitor, status: "focus" },
  { id: "reminders", title: "提醒", subtitle: "气泡与系统通知", Icon: Bell, status: "focus" },
  { id: "recognition", title: "识别", subtitle: "状态判断", Icon: SlidersHorizontal, status: "distracted" },
  { id: "about", title: "关于", subtitle: "应用信息", Icon: Info, status: "warning" },
];

const AppearanceSettings = () => {
  const { bundle, actions } = useFocusPet();
  const activeTheme = bundle.state.settings.appearance.theme;
  return (
    <div className="theme-choice-grid" role="radiogroup" aria-label="外观主题">
      {appThemes.map((theme) => {
        const selected = activeTheme === theme.id;
        return (
          <button
            className={`theme-choice-card ${selected ? "is-selected" : ""}`}
            data-theme-preview={theme.id}
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-pressed={selected}
            onClick={() => actions.updateSettings((settings) => ({
              ...settings,
              appearance: { ...settings.appearance, theme: theme.id },
            }))}
          >
            <span className="theme-choice-preview" aria-hidden>
              <img src={theme.artURL} alt="" draggable={false} />
              <span className="theme-preview-window">
                <i />
                <b />
                <em />
              </span>
              <span className="theme-preview-swatches">
                {theme.swatches.map((swatch) => <i key={swatch} style={{ backgroundColor: swatch }} />)}
              </span>
            </span>
            <span className="theme-choice-copy">
              <strong>{theme.name}</strong>
              <small>{theme.englishName}</small>
              <span>{theme.description}</span>
            </span>
            <span className="theme-choice-check" aria-hidden>{selected ? "✓" : ""}</span>
          </button>
        );
      })}
    </div>
  );
};

const judgmentPresetLabels: Record<JudgmentSensitivityPreset, string> = {
  relaxed: "宽松",
  balanced: "平衡",
  strict: "严格",
  custom: "自定义",
};

const sampleQualityTitle = (quality?: string): string => {
  if (!quality) return "等待采样";
  if (quality === "screen-locked") return "锁屏隔离";
  if (quality.includes("low-level-input-hooks")) return "Win32 原生钩子";
  if (quality.includes("fallback")) return "空闲状态回退";
  if (quality === "browser-preview") return "浏览器预览";
  return quality;
};

const SettingsSegmentedControl = <T extends string | number,>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; title: string }>;
  onChange: (value: T) => void;
}) => (
  <div className="swift-settings-field">
    <span>{label}</span>
    <SegmentedControl className="settings-segmented-control" label={label} value={value} options={options.map((option) => ({ value: option.value, label: option.title }))} onChange={onChange} />
  </div>
);

const TogglePillButton = ({
  checked,
  onChange,
  label,
  Icon,
  status = "focus",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  Icon: LucideIcon;
  status?: SettingsStatus;
}) => (
  <TogglePill
    checked={checked}
    status={status}
    className={`settings-toggle-pill status-${status} ${checked ? "active" : ""}`}
    onCheckedChange={onChange}
  >
    <Icon size={15} strokeWidth={2.4} />
    <span>{label}</span>
  </TogglePill>
);

const NumberControl = ({
  title,
  value,
  min,
  max,
  suffix,
  status,
  onChange,
}: {
  title: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  status: SettingsStatus;
  onChange: (value: number) => void;
}) => <Stepper className={`settings-number-stepper status-${status}`} label={title} value={value} min={min} max={max} suffix={suffix} status={status} onChange={onChange} />;

const SettingsSubsection = ({
  title,
  Icon,
  status,
  children,
}: {
  title: string;
  Icon: LucideIcon;
  status: SettingsStatus;
  children: ReactNode;
}) => (
  <section className={`settings-subcard status-${status}`}>
    <h3>
      <Icon size={15} strokeWidth={2.4} />
      {title}
    </h3>
    {children}
  </section>
);

const RecognitionSettings = () => {
  const { bundle, actions } = useFocusPet();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const settings = bundle.state.settings.judgment;
  const diagnostic = bundle.state.recognitionDiagnostic;
  const activePreset = matchingJudgmentPreset(settings);
  const statusTitle = diagnostic.catalogEntryCount < 20
      ? "规则待检查"
      : diagnostic.inputMonitoringStatus !== "已允许"
        ? "权限待补"
        : "运行中";
  const statusClass: SettingsStatus = statusTitle === "运行中" ? "success" : "warning";
  const refresh = async () => {
    setIsRefreshing(true);
    try {
      await actions.refreshRecognitionDiagnostics();
    } finally {
      setIsRefreshing(false);
    }
  };
  return (
    <div className="settings-module-stack">
      <section className="recognition-diagnostic-panel">
        <div className="recognition-diagnostic-head">
          <h3>
            <Keyboard size={16} strokeWidth={2.4} />
            识别状态
          </h3>
          <button aria-label="刷新诊断" aria-busy={isRefreshing || undefined} className="settings-icon-button" disabled={isRefreshing} type="button" onClick={() => void refresh()}>
            {isRefreshing ? <LoaderCircle className="button-spinner" size={14} /> : <RefreshCw size={14} strokeWidth={2.5} />}
          </button>
        </div>
        <div className="recognition-summary-row">
          <span className={`recognition-category-dot category-${diagnostic.category}`}>{categoryLabels[diagnostic.category].title.slice(0, 1)}</span>
          <div>
            <strong>{diagnostic.appName || "Unknown"}</strong>
            <small>
              {categoryLabels[diagnostic.category].title} · {diagnostic.catalogEntryCount >= 20 ? "规则库正常" : "规则库偏少"}
            </small>
          </div>
          <em className={`settings-status-badge status-${statusClass}`}>
            <CheckCircle2 size={12} />
            {statusTitle}
          </em>
        </div>
        <div className="settings-chip-row">
          <span className={diagnostic.inputMonitoringStatus === "已允许" ? "ok" : "warn"}>
            <ShieldCheck size={13} />
            输入监控 {diagnostic.inputMonitoringStatus}
          </span>
          <span className={diagnostic.sampleQuality?.includes("fallback") ? "warn" : "ok"}>
            <Monitor size={13} />
            采样链路 {sampleQualityTitle(diagnostic.sampleQuality)}
          </span>
        </div>
        <div className="recognition-tile-grid">
          <div>
            <small>Bundle ID</small>
            <strong>{diagnostic.bundleID ?? "未读取到"}</strong>
          </div>
          <div>
            <small>窗口标题</small>
            <strong>{diagnostic.windowTitle ? "已读取" : "未读取到"}</strong>
          </div>
          <div>
            <small>规则库</small>
            <strong>
              {diagnostic.catalogEntryCount} 项 / {diagnostic.defaultRuleCount} 条
            </strong>
          </div>
          <div>
            <small>用户例外</small>
            <strong>{diagnostic.userRuleCount} 条</strong>
          </div>
          <div>
            <small>空闲时间</small>
            <strong>{diagnostic.isScreenLocked ? "锁屏" : formatDuration(diagnostic.idleSeconds)}</strong>
          </div>
          <div>
            <small>本轮键盘</small>
            <strong>{diagnostic.keyboardCount} 次</strong>
          </div>
          <div>
            <small>本轮鼠标</small>
            <strong>{diagnostic.pointerCount} 次</strong>
          </div>
          <div>
            <small>本轮切换</small>
            <strong>{diagnostic.switchCount} 次</strong>
          </div>
        </div>
        {diagnostic.windowTitle ? <p className="recognition-window-title">{diagnostic.windowTitle}</p> : null}
        <div className="settings-right-actions">
          <CommandButton variant="danger" onClick={actions.resetRecognitionRules} disabled={diagnostic.userRuleCount === 0}>
            <Trash2 size={15} /> 清空例外
          </CommandButton>
        </div>
      </section>

      <SettingsSegmentedControl<JudgmentSensitivityPreset>
        label="识别灵敏度"
        value={activePreset}
        options={(Object.keys(judgmentPresetLabels) as JudgmentSensitivityPreset[]).map((preset) => ({
          value: preset,
          title: judgmentPresetLabels[preset],
        }))}
        onChange={(preset) => {
          if (preset === "custom") return;
          actions.updateSettings((current) => ({ ...current, judgment: judgmentPresetSettings(preset) }));
        }}
      />

      <div className="settings-control-grid">
        <NumberControl
          title="无输入走神"
          value={settings.inputIdleDistractedSeconds}
          min={30}
          max={900}
          suffix="秒"
          status="distracted"
          onChange={(value) => actions.updateSettings((current) => ({ ...current, judgment: { ...current.judgment, inputIdleDistractedSeconds: value } }))}
        />
        <NumberControl
          title="娱乐走神"
          value={settings.entertainmentDistractedSeconds}
          min={15}
          max={900}
          suffix="秒"
          status="distracted"
          onChange={(value) => actions.updateSettings((current) => ({ ...current, judgment: { ...current.judgment, entertainmentDistractedSeconds: value } }))}
        />
        <NumberControl
          title="输入恢复专注"
          value={settings.focusRecoverySeconds}
          min={1}
          max={120}
          suffix="秒"
          status="focus"
          onChange={(value) => actions.updateSettings((current) => ({ ...current, judgment: { ...current.judgment, focusRecoverySeconds: value } }))}
        />
        <NumberControl
          title="暂离回填"
          value={settings.idleAwaySeconds}
          min={180}
          max={3600}
          suffix="秒"
          status="neutral"
          onChange={(value) => actions.updateSettings((current) => ({ ...current, judgment: { ...current.judgment, idleAwaySeconds: value } }))}
        />
      </div>
    </div>
  );
};

const DesktopWidgetSettings = () => {
  const { bundle, actions } = useFocusPet();
  const desktop = bundle.state.settings.desktopWidget;
  const setDesktop = (patch: Partial<typeof desktop>) =>
    actions.updateSettings((settings) => ({
      ...settings,
      desktopWidget: { ...settings.desktopWidget, ...patch },
      desktopWidgetVisible:
        (patch.currentStatusVisible ?? settings.desktopWidget.currentStatusVisible) ||
        (patch.recentRhythmVisible ?? settings.desktopWidget.recentRhythmVisible),
    }));
  return (
    <div className="settings-module-stack">
      <div className="settings-toggle-grid">
        <TogglePillButton
          label="当前状态卡"
          Icon={Monitor}
          checked={desktop.currentStatusVisible}
          onChange={(checked) => setDesktop({ currentStatusVisible: checked })}
        />
        <TogglePillButton
          label="最近节奏卡"
          Icon={Clock3}
          checked={desktop.recentRhythmVisible}
          status="info"
          onChange={(checked) => setDesktop({ recentRhythmVisible: checked })}
        />
      </div>
      <SettingsSegmentedControl
        label="最近节奏范围"
        value={desktop.recentRhythmWindowHours}
        options={[4, 8, 12].map((hours) => ({ value: hours, title: `${hours}h` }))}
        onChange={(hours) => setDesktop({ recentRhythmWindowHours: hours })}
      />
      <SettingsSegmentedControl
        label="位置模式"
        value={desktop.movementMode}
        options={[
          { value: "fixed", title: "固定位置" },
          { value: "free", title: "自由拖动" },
        ]}
        onChange={(movementMode) => setDesktop({ movementMode })}
      />
      <div className="settings-command-row">
        <CommandButton onClick={() => setDesktop({ currentStatusVisible: true, recentRhythmVisible: true })}>
          <CheckCircle2 size={15} /> 全部显示
        </CommandButton>
        <CommandButton onClick={() => setDesktop({ currentStatusVisible: false, recentRhythmVisible: false })}>
          <Monitor size={15} /> 全部隐藏
        </CommandButton>
      </div>
    </div>
  );
};

const ReminderSettings = () => {
  const { bundle, actions, codexIntegration, codexSessions, codexManagedStatusEnabled, codexSshHosts, codexSshConnections } = useFocusPet();
  const reminder = bundle.state.settings.reminder;
  const codexConfigured = codexIntegration?.mode === "configured";
  const managedDaemonStatus = codexIntegration?.managedDaemonStatus ?? "unknown";
  const activeCodexSessions = codexSessions.filter(codexSessionIsActive).length;
  const connectedSshHosts = codexSshConnections.filter((connection) => connection.status === "connected").length;
  const codexReady = codexManagedStatusEnabled
    || codexConfigured
    || connectedSshHosts > 0
    || codexSessions.length > 0
    || managedDaemonStatus !== "unavailable" && managedDaemonStatus !== "unknown";
  return (
    <div className="settings-module-stack">
      <SettingsSubsection title="提醒通道" Icon={Bell} status="focus">
        <div className="settings-toggle-grid">
          <TogglePillButton
            label="桌宠气泡"
            Icon={Bell}
            checked={reminder.enablePetBubbles}
            onChange={(checked) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, enablePetBubbles: checked } }))}
          />
          <TogglePillButton
            label="系统通知"
            Icon={Bell}
            checked={reminder.enableSystemNotifications}
            onChange={(checked) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, enableSystemNotifications: checked } }))}
          />
          <TogglePillButton
            label="回归提醒"
            Icon={RotateCcw}
            status="pet"
            checked={reminder.enableWelcomeBackNudges}
            onChange={(checked) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, enableWelcomeBackNudges: checked } }))}
          />
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="触发条件" Icon={Clock3} status="neutral">
        <div className="settings-toggle-grid">
          <TogglePillButton
            label="走神提醒事件"
            Icon={Bell}
            status="distracted"
            checked={reminder.enableDistractedNudges}
            onChange={(checked) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, enableDistractedNudges: checked } }))}
          />
        </div>
        <div className="settings-control-grid">
          <NumberControl
            title="温和走神阈值"
            value={reminder.lightDistractedMinutes}
            min={1}
            max={60}
            suffix="分钟"
            status="distracted"
            onChange={(value) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, lightDistractedMinutes: value } }))}
          />
          <NumberControl
            title="强提醒阈值"
            value={reminder.strongDistractedMinutes}
            min={2}
            max={120}
            suffix="分钟"
            status="distracted"
            onChange={(value) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, strongDistractedMinutes: value } }))}
          />
          <NumberControl
            title="提醒冷却"
            value={reminder.cooldownMinutes}
            min={1}
            max={60}
            suffix="分钟"
            status="neutral"
            onChange={(value) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, cooldownMinutes: value } }))}
          />
        </div>
        <div className="reminder-explanation-grid">
          <article>
            <strong>走神观察</strong>
            <span>
              状态判断进入走神时立即作为基础桌宠状态；达到 {reminder.lightDistractedMinutes} 分钟触发温和提醒，达到 {reminder.strongDistractedMinutes} 分钟触发强提醒。
            </span>
          </article>
        </div>
      </SettingsSubsection>

      <SettingsSubsection title="智能体任务" Icon={Bot} status="pet">
        <section className="codex-sync-panel" aria-label="Codex 会话同步配置">
          <header>
            <span className="codex-sync-icon"><Bot size={18} /></span>
            <span>
              <strong>Codex 会话同步</strong>
              <small>{activeCodexSessions
                ? `${activeCodexSessions} 个任务运行中`
                : codexReady ? "正在自动发现本机与服务器会话" : "等待 Codex CLI"}</small>
            </span>
            <em className={codexReady ? "is-ready" : "is-pending"}>{codexReady ? <><CircleCheck size={13} /> 已就绪</> : <><CircleAlert size={13} /> 未检测到</>}</em>
          </header>
          <p>Focus Pet 会自动完成 Hook、App Server、rollout 与 SSH 会话发现，不需要手动安装、刷新或连接。</p>
          <div className="settings-toggle-grid">
            <TogglePillButton
              label="今日显示 Codex 实时会话"
              Icon={Bot}
              status="pet"
              checked={bundle.state.settings.codex.showInToday}
              onChange={(showInToday) => actions.updateSettings((settings) => ({
                ...settings,
                codex: { ...settings.codex, showInToday },
              }))}
            />
          </div>
          <p><strong>Assistant 摘要（默认）</strong> · 实时窗口展示 Codex 的可见回复。</p>
          <div className="settings-inline-action">
            <span><ShieldCheck size={15} /> 本机同步 {codexConfigured ? "已配置" : codexReady ? "自动初始化中" : "等待 Codex CLI"}</span>
          </div>
          <div className="settings-inline-action">
            <span><Globe2 size={15} /> SSH 服务器 {codexSshHosts.length ? `${connectedSshHosts}/${codexSshHosts.length} 已连接` : "未发现具体 Host alias"}</span>
          </div>
        </section>
      </SettingsSubsection>

      <SettingsSubsection title="暂停" Icon={RotateCcw} status="warning">
        <div className="settings-control-grid single">
          <NumberControl
            title="暂停时长"
            value={reminder.pauseMinutes}
            min={5}
            max={240}
            suffix="分钟"
            status="warning"
            onChange={(value) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, pauseMinutes: value } }))}
          />
          <div className="settings-inline-action">
            <span>{reminder.pauseUntil ? `暂停至 ${new Date(reminder.pauseUntil).toLocaleTimeString("zh-CN")}` : "提醒可用"}</span>
            {reminder.pauseUntil && new Date(reminder.pauseUntil) > new Date() ? (
              <CommandButton onClick={actions.resumeReminders}>
                <RotateCcw size={15} /> 恢复
              </CommandButton>
            ) : (
              <CommandButton onClick={() => actions.pauseReminders(reminder.pauseMinutes)}>
                <Bell size={15} /> 暂停
              </CommandButton>
            )}
          </div>
        </div>
      </SettingsSubsection>
    </div>
  );
};

const AboutSettings = () => (
  <div className="about-copy swift-about-copy">
    <strong>Focus Pet</strong>
    <span>Focus Pet 使用前台 App、窗口标题、输入空闲和专注会话判断状态。所有统计保存在本机。</span>
    <small>迁移构建日期 {formatDate(new Date())}</small>
  </div>
);

const moduleContent: Record<SettingsModuleID, ReactNode> = {
  appearance: <AppearanceSettings />,
  desktopWidgets: <DesktopWidgetSettings />,
  reminders: <ReminderSettings />,
  recognition: <RecognitionSettings />,
  about: <AboutSettings />,
};

export const SettingsTab = () => {
  return (
    <div className="swift-settings-page">
      {settingsModules.map((module) => {
        const Icon = module.Icon;
        return (
          <section className={`settings-content-panel settings-module-${module.id} status-${module.status}`} aria-labelledby={`settings-${module.id}`} key={module.id}>
            <header>
              <span className="settings-module-icon"><Icon size={18} strokeWidth={2.4} /></span>
              <div>
                <h2 id={`settings-${module.id}`}>{module.title}</h2>
                <p>{module.subtitle}</p>
              </div>
            </header>
            <div className="settings-content-body">{moduleContent[module.id]}</div>
          </section>
        );
      })}
    </div>
  );
};
