import {
  Bell,
  Bot,
  CheckCircle2,
  Clock3,
  CircleAlert,
  CircleCheck,
  Database,
  FileText,
  FolderOpen,
  Globe2,
  Info,
  Keyboard,
  LoaderCircle,
  Lock,
  Monitor,
  MessageSquareText,
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

type SettingsModuleID = "appearance" | "desktopWidgets" | "reminders" | "recognition" | "permissions" | "data" | "about";
type SettingsStatus = "focus" | "distracted" | "privacy" | "warning" | "pet" | "success" | "neutral";

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
  { id: "permissions", title: "权限", subtitle: "系统设置入口", Icon: Lock, status: "privacy" },
  { id: "data", title: "数据", subtitle: "本地记录", Icon: Database, status: "privacy" },
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

const formatBytes = (bytes: number): string => {
  const safe = Math.max(0, bytes);
  if (safe >= 1024 * 1024) return `${(safe / 1024 / 1024).toFixed(1)} MB`;
  if (safe >= 1024) return `${(safe / 1024).toFixed(1)} KB`;
  return `${Math.round(safe)} B`;
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
  const statusTitle = diagnostic.recordingPaused
    ? "已暂停"
    : diagnostic.catalogEntryCount < 20
      ? "规则待检查"
      : diagnostic.inputMonitoringStatus !== "已允许"
        ? "权限待补"
        : "运行中";
  const statusClass: SettingsStatus = statusTitle === "运行中" ? "success" : statusTitle === "已暂停" ? "distracted" : "warning";
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
  const { bundle, actions, codexIntegration, codexSessions, codexManagedStatusEnabled, codexSshHosts, codexSshConnections, codexSshDiagnostics } = useFocusPet();
  const reminder = bundle.state.settings.reminder;
  const codexConfigured = codexIntegration?.mode === "configured";
  const codexReady = codexManagedStatusEnabled || codexConfigured;
  const codexContentMode = codexIntegration?.contentMode === "statusOnly" ? "statusOnly" : "assistantVisible";
  const managedDaemonStatus = codexIntegration?.managedDaemonStatus ?? "unknown";
  const [sshHostForm, setSshHostForm] = useState({ alias: "", hostname: "", user: "", port: "22" });
  const saveSshHost = () => {
    const port = Number(sshHostForm.port);
    if (!sshHostForm.alias.trim() || !sshHostForm.hostname.trim() || !Number.isInteger(port) || port < 1 || port > 65535) return;
    void actions.saveCodexSshHost({
      alias: sshHostForm.alias.trim(),
      hostname: sshHostForm.hostname.trim(),
      user: sshHostForm.user.trim() || undefined,
      port,
      source: "focusPet",
    }).then(() => setSshHostForm({ alias: "", hostname: "", user: "", port: "22" })).catch(() => undefined);
  };
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
              <small>{codexManagedStatusEnabled ? `官方 App Server 已接入 · 正在管理 ${codexSessions.length} 个会话` : codexConfigured ? `Hook 兼容模式 · 正在管理 ${codexSessions.length} 个会话` : "尚未接入 · 先启用官方 App Server"}</small>
            </span>
            <em className={codexReady ? "is-ready" : "is-pending"}>{codexReady ? <><CircleCheck size={13} /> 已接入</> : <><CircleAlert size={13} /> 待配置</>}</em>
          </header>
          <div className="codex-sync-steps" aria-label="Codex 接入进度">
            <span className={codexManagedStatusEnabled ? "done" : "current"}><b>1</b> App Server</span>
            <span className={codexReady ? "current" : ""}><b>2</b> 内容等级</span>
            <span className={codexConfigured ? "done" : ""}><b>3</b> Hook 兼容</span>
          </div>
          <p>{codexManagedStatusEnabled
            ? "Focus Pet 通过官方 App Server 只读观察会话状态，并只在完成后读取最终 assistant 输出；不会发送 prompt、审批或工具指令。"
            : codexConfigured
              ? "Hook 兼容模式已启用；它可提供 lifecycle 与最终消息，但无法保证等待审批/输入等精确状态。"
              : "先启用精确状态以连接官方 App Server；若当前 Codex 不支持，再安装 Hook 作为兼容降级。"}</p>
          <div className={`codex-daemon-prerequisite status-${managedDaemonStatus === "unavailable" ? "warning" : managedDaemonStatus === "running" || managedDaemonStatus === "ephemeralAvailable" ? "success" : "neutral"}`}>
            <Info size={14} />
            <span>{codexIntegration?.managedDaemonMessage ?? "正在读取本机 App Server 前置条件。"}</span>
          </div>
          <SettingsSegmentedControl
            label="可展示内容"
            value={codexContentMode}
            options={[
              { value: "statusOnly", title: "仅状态" },
              { value: "assistantVisible", title: "Assistant 摘要" },
            ]}
            onChange={(contentMode) => void actions.updateCodexSyncPreferences({ contentMode }).catch(() => undefined)}
          />
          <div className="codex-sync-privacy-note">
            <MessageSquareText size={14} />
            <span>{codexContentMode === "statusOnly" ? "仅保存会话和运行状态；assistant 文本会立即从当前面板清除。" : "仅展示 assistant 的可见输出；用户 prompt、推理、工具参数与终端输出不会同步。"}</span>
          </div>
        </section>
        <div className="settings-command-row">
          <CommandButton onClick={() => void actions.refreshCodexIntegration()}>
            <RefreshCw size={15} /> 刷新 Codex 状态
          </CommandButton>
          <CommandButton disabled={codexManagedStatusEnabled || managedDaemonStatus === "unavailable"} onClick={() => void actions.enableCodexManagedStatus().catch(() => undefined)}>
            <Bot size={15} /> {codexManagedStatusEnabled ? "精确状态已启用" : managedDaemonStatus === "running" ? "连接精确状态" : managedDaemonStatus === "ephemeralAvailable" ? "启动精确状态" : "启用持久精确状态"}
          </CommandButton>
          {managedDaemonStatus === "ephemeralAvailable" ? (
            <CommandButton onClick={() => void actions.copyCodexStandaloneInstallCommand().catch(() => undefined)}>
              <FileText size={15} /> 复制持久 daemon 安装命令
            </CommandButton>
          ) : null}
          <CommandButton onClick={() => void actions.installCodexHooks().catch(() => undefined)}>
            <ShieldCheck size={15} /> 安装 Codex Hook
          </CommandButton>
          <CommandButton onClick={() => void actions.uninstallCodexHooks().catch(() => undefined)}>
            <Trash2 size={15} /> 移除 Codex Hook
          </CommandButton>
          {!codexConfigured ? (
            <CommandButton onClick={() => void actions.copyCodexHookCommand().catch(() => undefined)}>
              <FileText size={15} /> 复制 Hook 命令
            </CommandButton>
          ) : null}
          <CommandButton onClick={actions.testAgentCompletion}>
            <Bot size={15} /> 测试桌宠通知
          </CommandButton>
        </div>
        {codexIntegration ? (
          <div className="settings-inline-action">
            <span>{codexIntegration.hasInlineHooks ? "检测到 config.toml 内联 Hook；请不要同时创建 hooks.json。" : `Hook 文件：${codexIntegration.hooksPath}`}</span>
          </div>
        ) : null}
        <div className="settings-inline-action">
          <span><Globe2 size={15} /> {codexSshHosts.length ? `已发现 ${codexSshHosts.length} 个 SSH Host` : "尚未发现 SSH Host；仅显示 ~/.ssh/config 中的具体 Host alias。"}</span>
          <CommandButton onClick={() => void actions.discoverCodexSshHosts().catch(() => undefined)}>
            <RefreshCw size={15} /> 发现 SSH Host
          </CommandButton>
        </div>
        <div className="codex-ssh-add-form" aria-label="添加 SSH 主机">
          <span>直连 SSH 主机（仅保存到 Focus Pet，不修改 ~/.ssh/config）</span>
          <input aria-label="SSH 主机别名" placeholder="别名，例如 research-codex" value={sshHostForm.alias} onChange={(event) => setSshHostForm((current) => ({ ...current, alias: event.target.value }))} />
          <input aria-label="SSH 主机地址" placeholder="主机地址或 IP" value={sshHostForm.hostname} onChange={(event) => setSshHostForm((current) => ({ ...current, hostname: event.target.value }))} />
          <input aria-label="SSH 用户" placeholder="用户" value={sshHostForm.user} onChange={(event) => setSshHostForm((current) => ({ ...current, user: event.target.value }))} />
          <input aria-label="SSH 端口" inputMode="numeric" placeholder="端口" value={sshHostForm.port} onChange={(event) => setSshHostForm((current) => ({ ...current, port: event.target.value }))} />
          <CommandButton onClick={saveSshHost} disabled={!sshHostForm.alias.trim() || !sshHostForm.hostname.trim()}>
            <Globe2 size={15} /> 保存主机
          </CommandButton>
        </div>
        {codexSshHosts.length ? (
          <div className="codex-ssh-host-list">
            {codexSshHosts.map((host) => (
              <div className="codex-ssh-host-row" key={host.alias}>
                <span className="codex-ssh-host-icon"><Globe2 size={15} /></span>
                <span>
                  <strong>{host.alias}</strong>
                  <small>{host.user ? `${host.user}@` : ""}{host.hostname}{host.port ? `:${host.port}` : ""} · {host.source === "focusPet" ? "Focus Pet 直连配置" : "~/.ssh/config"}</small>
                </span>
                {(() => {
                  const status = codexSshConnections.find((connection) => connection.alias === host.alias)?.status;
                  return <em className={status === "connected" ? "online" : status === "connecting" ? "connecting" : "offline"}>{status === "connected" ? "已连接" : status === "connecting" ? "连接中" : status === "disconnected" ? "已断开" : "未接入"}</em>;
                })()}
                {codexSshDiagnostics[host.alias] ? (
                  <span className="codex-ssh-row-actions">
                    <CommandButton onClick={() => void actions.provisionCodexSshHost(host.alias).catch(() => undefined)}>
                      <ShieldCheck size={15} /> 启用接入
                    </CommandButton>
                    <CommandButton onClick={() => void actions.uninstallCodexSshHost(host.alias).catch(() => undefined)}>
                      <Trash2 size={15} /> 断开
                    </CommandButton>
                    {host.source === "focusPet" ? (
                      <CommandButton onClick={() => void actions.forgetCodexSshHost(host.alias).catch(() => undefined)}>
                        <Trash2 size={15} /> 移除主机
                      </CommandButton>
                    ) : null}
                  </span>
                ) : (
                  <CommandButton onClick={() => void actions.diagnoseCodexSshHost(host.alias).catch(() => undefined)}>
                    <RefreshCw size={15} /> 检查
                  </CommandButton>
                )}
                {codexSshDiagnostics[host.alias] ? (
                  <div className="codex-ssh-diagnostic">
                    <span>{codexSshDiagnostics[host.alias].operatingSystem} · {codexSshDiagnostics[host.alias].architecture} · {codexSshDiagnostics[host.alias].codexVersion} · {codexSshDiagnostics[host.alias].daemonStatus === "ready" ? codexSshDiagnostics[host.alias].transport === "directUnixSocket" ? "直连 Socket 已验证" : "只读 proxy 已验证" : codexSshDiagnostics[host.alias].daemonStatus === "proxyUnresponsive" ? "daemon 已运行，但接入未响应" : codexSshDiagnostics[host.alias].daemonStatus === "running" ? "daemon 运行中，待验证" : "daemon 待启用"}</span>
                    <small>{codexSshDiagnostics[host.alias].daemonStatus === "proxyUnresponsive" ? "为保护已有 Codex 会话，Focus Pet 未执行 bootstrap、重启或连接劫持；标准 proxy 与直连 Socket 都未完成只读握手。" : `Codex：${codexSshDiagnostics[host.alias].codexPath} · ${codexSshDiagnostics[host.alias].transport === "directUnixSocket" ? "标准 proxy 无响应，已安全回退到 SSH 内的 Unix Socket 字节通道。" : "接入仅启用官方 App Server，不上传 Focus Pet agent。"}`}</small>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
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
  const systemNotificationsEnabled = bundle.state.settings.reminder.enableSystemNotifications;
  const isWindows = navigator.userAgent.includes("Windows");
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
      subtitle: isWindows ? "Windows 全局键盘与鼠标事件计数（无需额外授权）" : "键盘与鼠标事件计数",
      status: snapshot.inputMonitoring,
      Icon: Keyboard,
      destination: "inputMonitoring",
      canRequest: !isWindows,
    },
    {
      id: "notifications",
      title: "通知",
      subtitle: isWindows ? "系统提醒横幅（可能受 Windows 勿扰模式抑制）· 可在此开启或关闭 Focus Pet 通知" : "系统提醒横幅 · 可在此开启或关闭 Focus Pet 通知",
      status: snapshot.notifications,
      Icon: Bell,
      destination: "notifications",
      canRequest: true,
    },
    {
      id: "privacySecurity",
      title: isWindows ? "Windows 隐私设置" : "隐私与安全",
      subtitle: isWindows ? "Windows 系统隐私管理入口" : "macOS 隐私面板",
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
          const isNotifications = item.id === "notifications";
          const statusLabel = isNotifications ? (systemNotificationsEnabled ? "应用已开启" : "应用已关闭") : item.status;
          return (
            <div className={`settings-list-row ${allowed ? "allowed" : ""}`} key={item.id}>
              <span className="settings-list-icon">
                <Icon size={16} />
              </span>
              <div>
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </div>
              <em className={`settings-status-badge status-${isNotifications && systemNotificationsEnabled ? "success" : allowed ? "success" : "warning"}`}>{statusLabel}</em>
              {isNotifications ? (
                <TogglePillButton
                  label="启用通知"
                  Icon={Bell}
                  checked={systemNotificationsEnabled}
                  onChange={(checked) => actions.updateSettings((settings) => ({
                    ...settings,
                    reminder: { ...settings.reminder, enableSystemNotifications: checked },
                  }))}
                />
              ) : null}
              {item.canRequest && !allowed ? (
                <CommandButton loading={pendingAction === `request:${item.id}`} loadingLabel="请求中" disabled={Boolean(pendingAction)} onClick={() => void runPermissionAction(`request:${item.id}`, () => actions.requestSystemPermission(item.destination))}>
                  <ShieldCheck size={15} /> {isNotifications ? "请求授权" : "请求"}
                </CommandButton>
              ) : null}
              <CommandButton loading={pendingAction === `open:${item.id}`} loadingLabel="打开中" disabled={Boolean(pendingAction)} onClick={() => void runPermissionAction(`open:${item.id}`, () => actions.openSystemSettings(item.destination))}>{isNotifications ? "系统设置" : "打开"}</CommandButton>
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
        <CommandButton onClick={() => void actions.openDataFolder()}>
          <FolderOpen size={15} /> 打开数据目录
        </CommandButton>
        <CommandButton onClick={() => void actions.copyDataPath()}>
          <ShieldCheck size={15} /> 复制数据路径
        </CommandButton>
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
    <span>Focus Pet 使用前台 App、窗口标题、输入空闲和专注会话判断状态。所有统计保存在本机。</span>
    <small>迁移构建日期 {formatDate(new Date())}</small>
  </div>
);

const moduleContent: Record<SettingsModuleID, ReactNode> = {
  appearance: <AppearanceSettings />,
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
