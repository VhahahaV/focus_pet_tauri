import {
  Bell,
  CheckCircle2,
  Clock3,
  Database,
  FileText,
  FolderOpen,
  Info,
  Keyboard,
  LoaderCircle,
  Lock,
  Monitor,
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
import { formatDate } from "../core/formatters";
import { judgmentPresetSettings, matchingJudgmentPreset, type JudgmentSensitivityPreset } from "../core/settings";
import { CommandButton } from "./common";
import { SegmentedControl, Stepper, TogglePill } from "./ui";

type SettingsModuleID = "desktopWidgets" | "reminders" | "recognition" | "permissions" | "data" | "about";
type SettingsStatus = "focus" | "distracted" | "privacy" | "warning" | "pet" | "rest" | "neutral";

const settingsModules: Array<{
  id: SettingsModuleID;
  title: string;
  subtitle: string;
  Icon: LucideIcon;
  status: SettingsStatus;
}> = [
  { id: "desktopWidgets", title: "桌面状态卡", subtitle: "当前与节奏卡", Icon: Monitor, status: "focus" },
  { id: "reminders", title: "提醒", subtitle: "气泡与系统通知", Icon: Bell, status: "focus" },
  { id: "recognition", title: "识别", subtitle: "状态判断", Icon: SlidersHorizontal, status: "distracted" },
  { id: "permissions", title: "权限", subtitle: "系统设置入口", Icon: Lock, status: "privacy" },
  { id: "data", title: "数据", subtitle: "本地记录", Icon: Database, status: "privacy" },
  { id: "about", title: "关于", subtitle: "应用信息", Icon: Info, status: "warning" },
];

const judgmentPresetLabels: Record<JudgmentSensitivityPreset, string> = {
  relaxed: "宽松",
  balanced: "平衡",
  strict: "严格",
  custom: "自定义",
};

const formatBytes = (bytes: number): string => {
  const safe = Math.max(0, bytes);
  if (safe >= 1024 * 1024) return `${(safe / 1024 / 1024).toFixed(1)} MB`;
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${Math.round(safe)} B`;
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
  const statusTitle = diagnostic.recordingPaused
    ? "已暂停"
    : diagnostic.catalogEntryCount < 20
      ? "规则待检查"
      : diagnostic.inputMonitoringStatus !== "已允许"
        ? "权限待补"
        : "运行中";
  const statusClass: SettingsStatus = statusTitle === "运行中" ? "rest" : statusTitle === "已暂停" ? "distracted" : "warning";
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
        </div>
        {diagnostic.windowTitle ? <p className="recognition-window-title">{diagnostic.windowTitle}</p> : null}
        {diagnostic.recordingPaused ? <p className="settings-warning-line">本地记录已暂停</p> : null}
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
          status="privacy"
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
  const { bundle, actions } = useFocusPet();
  const reminder = bundle.state.settings.reminder;
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

      <SettingsSubsection title="触发条件" Icon={Clock3} status="rest">
        <div className="settings-toggle-grid">
          <TogglePillButton
            label="走神提醒事件"
            Icon={Bell}
            status="distracted"
            checked={reminder.enableDistractedNudges}
            onChange={(checked) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, enableDistractedNudges: checked } }))}
          />
          <TogglePillButton
            label="专注休息事件"
            Icon={Clock3}
            status="rest"
            checked={reminder.enableFocusRestNudges}
            onChange={(checked) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, enableFocusRestNudges: checked } }))}
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
            title="长专注阈值"
            value={reminder.longFocusMinutes}
            min={5}
            max={180}
            suffix="分钟"
            status="rest"
            onChange={(value) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, longFocusMinutes: value } }))}
          />
          <NumberControl
            title="超长专注阈值"
            value={reminder.veryLongFocusMinutes}
            min={10}
            max={240}
            suffix="分钟"
            status="rest"
            onChange={(value) => actions.updateSettings((settings) => ({ ...settings, reminder: { ...settings.reminder, veryLongFocusMinutes: value } }))}
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
          <article>
            <strong>专注休息提示</strong>
            <span>
              连续专注达到 {reminder.longFocusMinutes} 分钟触发休息提示，达到 {reminder.veryLongFocusMinutes} 分钟升级为超长专注提示。
            </span>
          </article>
        </div>
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

const PermissionSettings = () => {
  const { bundle, actions } = useFocusPet();
  const snapshot = bundle.state.permissionSnapshot;
  const [pendingAction, setPendingAction] = useState<string | undefined>(undefined);
  const runPermissionAction = async (key: string, action: () => Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(key);
    try {
      await action();
    } finally {
      setPendingAction(undefined);
    }
  };
  const permissionRows = [
    {
      id: "inputMonitoring",
      title: "输入监控",
      subtitle: "键盘与鼠标事件计数",
      status: snapshot.inputMonitoring,
      Icon: Keyboard,
      destination: "inputMonitoring",
      canRequest: true,
    },
    {
      id: "notifications",
      title: "通知",
      subtitle: "系统提醒横幅",
      status: snapshot.notifications,
      Icon: Bell,
      destination: "notifications",
      canRequest: true,
    },
    {
      id: "privacySecurity",
      title: "隐私与安全",
      subtitle: "macOS 隐私面板",
      status: "系统设置",
      Icon: Lock,
      destination: "privacySecurity",
      canRequest: false,
    },
  ];
  return (
    <div className="settings-module-stack">
      <div className="permission-refresh-row">
        <small>刷新于 {new Date(snapshot.refreshedAt).toLocaleTimeString("zh-CN")}</small>
        <CommandButton loading={pendingAction === "refresh"} loadingLabel="刷新中" onClick={() => void runPermissionAction("refresh", actions.refreshPermissions)}>
          <RefreshCw size={15} /> 刷新
        </CommandButton>
      </div>
      <div className="settings-list-stack">
        {permissionRows.map((item) => {
          const { Icon } = item;
          const allowed = item.status === "已允许";
          return (
            <div className={`settings-list-row ${allowed ? "allowed" : ""}`} key={item.id}>
              <span className="settings-list-icon">
                <Icon size={16} />
              </span>
              <div>
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </div>
              <em className={`settings-status-badge status-${allowed ? "rest" : "warning"}`}>{item.status}</em>
              {item.canRequest && !allowed ? (
                <CommandButton loading={pendingAction === `request:${item.id}`} loadingLabel="请求中" disabled={Boolean(pendingAction)} onClick={() => void runPermissionAction(`request:${item.id}`, () => actions.requestSystemPermission(item.destination))}>
                  <ShieldCheck size={15} /> 请求
                </CommandButton>
              ) : null}
              <CommandButton loading={pendingAction === `open:${item.id}`} loadingLabel="打开中" disabled={Boolean(pendingAction)} onClick={() => void runPermissionAction(`open:${item.id}`, () => actions.openSystemSettings(item.destination))}>打开</CommandButton>
              {item.id === "notifications" ? (
                <CommandButton loading={pendingAction === "test:notifications"} loadingLabel="发送中" disabled={Boolean(pendingAction)} onClick={() => void runPermissionAction("test:notifications", actions.sendTestNotification)}>测试</CommandButton>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const PrivacyDataSettings = () => {
  const { bundle, actions } = useFocusPet();
  const privacy = bundle.state.settings.privacy;
  const logging = bundle.state.settings.logging;
  const [lastExportURL, setLastExportURL] = useState<string | undefined>();
  const [pendingAction, setPendingAction] = useState<string | undefined>(undefined);
  const recordingEnabled = !privacy.pauseActivityRecording;
  const runDataAction = async (key: string, action: () => Promise<void>) => {
    if (pendingAction) return;
    setPendingAction(key);
    try {
      await action();
    } finally {
      setPendingAction(undefined);
    }
  };
  const confirmAndDelete = async () => {
    if (!window.confirm("清空所有本地统计、会话与提醒记录？此操作无法撤销。")) return;
    await runDataAction("delete", actions.deleteAllData);
  };
  return (
    <div className="settings-module-stack">
      <TogglePillButton
        label="记录本地统计"
        Icon={Database}
        status="privacy"
        checked={recordingEnabled}
        onChange={(enabled) => actions.updateSettings((settings) => ({ ...settings, privacy: { ...settings.privacy, pauseActivityRecording: !enabled } }))}
      />
      <div className="data-summary-row">
        <span className="settings-list-icon">
          <Database size={16} />
        </span>
        <div>
          <strong>本机数据</strong>
          <small>{recordingEnabled ? "本地记录中" : "记录已暂停"}</small>
        </div>
        <em>{formatBytes(bundle.state.dataSizeBytes)}</em>
      </div>
      <div className="settings-command-grid">
        <CommandButton loading={pendingAction === "export-redacted"} loadingLabel="导出中" disabled={Boolean(pendingAction)} onClick={() => void runDataAction("export-redacted", async () => setLastExportURL(await actions.exportData(true)))}>
          <FileText size={15} /> 导出脱敏统计
        </CommandButton>
        <CommandButton loading={pendingAction === "export-full"} loadingLabel="导出中" disabled={Boolean(pendingAction)} onClick={() => void runDataAction("export-full", async () => setLastExportURL(await actions.exportData(false)))}>
          <FileText size={15} /> 导出完整统计
        </CommandButton>
        <CommandButton loading={pendingAction === "delete"} loadingLabel="清理中" disabled={Boolean(pendingAction)} variant="danger" onClick={() => void confirmAndDelete()}>
          <Trash2 size={15} /> 清空数据
        </CommandButton>
      </div>
      {lastExportURL ? (
        <a className="export-link" href={lastExportURL} target="_blank" rel="noreferrer">
          打开最近导出
        </a>
      ) : null}
      <section className="settings-subcard status-privacy">
        <h3>
          <FileText size={15} />
          日志与诊断
        </h3>
        <div className="settings-toggle-grid">
          <TogglePillButton
            label="启用日志"
            Icon={FileText}
            status="privacy"
            checked={logging.isEnabled}
            onChange={(checked) => actions.updateSettings((settings) => ({ ...settings, logging: { ...settings.logging, isEnabled: checked } }))}
          />
        </div>
        <div className="settings-command-grid">
          <CommandButton onClick={() => void actions.openCurrentLogFile()}>
            <FileText size={15} /> 打开日志
          </CommandButton>
          <CommandButton onClick={() => void actions.openLogFolder()}>
            <FolderOpen size={15} /> 打开文件夹
          </CommandButton>
          <CommandButton onClick={() => void actions.copyLogPath()}>
            <ShieldCheck size={15} /> 复制路径
          </CommandButton>
          <CommandButton disabled={!logging.isEnabled} onClick={actions.writeDiagnosticsLogSnapshot}>
            <ShieldCheck size={15} /> 写入诊断
          </CommandButton>
        </div>
      </section>
    </div>
  );
};

const AboutSettings = () => (
  <div className="about-copy swift-about-copy">
    <strong>Focus Pet</strong>
    <span>Focus Pet 使用前台 App、窗口标题、输入空闲和专注/休息会话判断状态。所有统计保存在本机。</span>
    <small>迁移构建日期 {formatDate(new Date())}</small>
  </div>
);

const moduleContent: Record<SettingsModuleID, ReactNode> = {
  desktopWidgets: <DesktopWidgetSettings />,
  reminders: <ReminderSettings />,
  recognition: <RecognitionSettings />,
  permissions: <PermissionSettings />,
  data: <PrivacyDataSettings />,
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
