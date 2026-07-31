import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bell, BellOff, CheckCircle2, Eye, EyeOff, LayoutDashboard, PanelsTopLeft, Power, Settings, SquareArrowDown } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { NativeMenuAction } from "../app/nativeMenu";
import type { MenuBarPayload } from "../app/menuBarPayload";
import { focusStateLabels } from "../core/labels";
import { formatClock, formatDuration, formatPercentage } from "../core/formatters";
import { defaultAppSettings } from "../core/settings";
import { nativePerformMenuBarAction, nativeQuitApp } from "../store/native";
import { useDocumentTheme } from "../themes";

const fallbackMenuPayload = (): MenuBarPayload => {
  const now = new Date().toISOString();
  return {
    currentDecision: {
      timestamp: now,
      state: "focus",
      category: "work",
      confidence: 0.62,
      reason: ["neutralDefault"],
      stableDuration: 0,
    },
    summary: {
      date: now.slice(0, 10),
      focusSeconds: 0,
      distractedSeconds: 0,
      breakSeconds: 0,
      awaySeconds: 0,
      nudgeCount: 0,
      longestFocusSeconds: 0,
      focusSessionCount: 0,
      distractedCount: 0,
      awayCount: 0,
      switchCount: 0,
      appUsage: [],
      categoryUsage: [],
    },
    currentSnapshot: {
      timestamp: now,
      appName: "Focus Pet",
      titleStored: false,
      category: "work",
      idleSeconds: 0,
      switchCountLast5Min: 0,
      switchCountLast15Min: 0,
      activeCategoryDuration: 0,
      activeAppDuration: 0,
      isFocusSessionActive: false,
      isSystemSleeping: false,
      isScreenLocked: false,
      source: ["frontmostApplication"],
    },
    settings: defaultAppSettings(),
    statusMessage: "等待主窗口同步",
    hasAvailablePetPacks: true,
  };
};

const sendMenuAction = async (action: NativeMenuAction) => {
  if (!("__TAURI_INTERNALS__" in window)) return;
  await nativePerformMenuBarAction(action).catch(() => false);
  await getCurrentWindow().hide().catch(() => undefined);
};

const terminateApp = async () => {
  if (!("__TAURI_INTERNALS__" in window)) return;
  await nativeQuitApp().catch(() => getCurrentWindow().close().catch(() => false));
};

const reminderPauseTitle = (payload: MenuBarPayload): string => {
  const pauseUntil = payload.settings.reminder.pauseUntil;
  if (pauseUntil && new Date(pauseUntil) > new Date()) return `暂停至 ${formatClock(pauseUntil)}`;
  return "提醒开启";
};

const MenuMetricChip = ({ title, value, state }: { title: string; value: string; state: "focus" | "distracted" }) => (
  <span className={`menu-metric-chip state-${state}`}>
    <i />
    <small>{title}</small>
    <strong>{value}</strong>
  </span>
);

const MenuActionButton = ({
  title,
  icon,
  action,
  tone = "focus",
}: {
  title: string;
  icon: ReactNode;
  action: NativeMenuAction;
  tone?: "focus" | "neutral" | "warning" | "pet";
}) => (
  <button className={`menu-action-button tone-${tone}`} type="button" onClick={() => void sendMenuAction(action)}>
    <span>{icon}</span>
    {title}
  </button>
);

export const MenuBarView = () => {
  const [payload, setPayload] = useState<MenuBarPayload>(() => fallbackMenuPayload());
  useDocumentTheme(payload.settings.appearance.theme);
  const stateLabel = focusStateLabels[payload.currentDecision.state];
  const hasVisibleWidgets =
    payload.settings.desktopWidget.currentStatusVisible || payload.settings.desktopWidget.recentRhythmVisible;
  const pauseUntil = payload.settings.reminder.pauseUntil;
  const remindersPaused = Boolean(pauseUntil && new Date(pauseUntil) > new Date());
  const petActionTitle = !payload.hasAvailablePetPacks ? "导入桌宠资源" : payload.settings.pet.hidden ? "显示桌宠" : "隐藏桌宠";
  const petActionIcon = !payload.hasAvailablePetPacks
    ? <SquareArrowDown size={15} />
    : payload.settings.pet.hidden
      ? <Eye size={15} />
      : <EyeOff size={15} />;
  const visualKey = useMemo(
    () => [
      payload.currentDecision.state,
      payload.activeFocus?.id ?? "no-focus",
      remindersPaused ? "paused" : "active",
      hasVisibleWidgets ? "widgets" : "no-widgets",
      payload.settings.pet.hidden ? "pet-hidden" : "pet-visible",
    ].join("|"),
    [hasVisibleWidgets, payload.activeFocus?.id, payload.currentDecision.state, payload.settings.pet.hidden, remindersPaused],
  );

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    let unlisten: (() => void) | undefined;
    void listen<MenuBarPayload>("focus-pet-menu-bar-state", (event) => setPayload(event.payload)).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    const hideOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void getCurrentWindow().hide().catch(() => undefined);
    };
    window.addEventListener("keydown", hideOnEscape);
    return () => window.removeEventListener("keydown", hideOnEscape);
  }, []);

  return (
    <main className={`menu-bar-card state-${payload.currentDecision.state}`} data-visual-key={visualKey}>
      <section className="menu-status-header">
        <div className="menu-status-icon">{stateLabel.short}</div>
        <div>
          <div className="menu-title-row">
            <h1>{stateLabel.title}</h1>
            <span>{formatPercentage(payload.currentDecision.confidence)}</span>
          </div>
          <strong>今日专注 {formatDuration(payload.summary.focusSeconds)}</strong>
          <small>{payload.currentSnapshot.appName}</small>
        </div>
      </section>

      <section className="menu-status-strip" aria-label="状态摘要">
        <MenuMetricChip title="专注" value={formatDuration(payload.summary.focusSeconds)} state="focus" />
        <MenuMetricChip title="走神" value={formatDuration(payload.summary.distractedSeconds)} state="distracted" />
      </section>

      <div className="menu-glass-divider" />

      <section className="menu-action-grid" aria-label="菜单动作">
        <MenuActionButton title="打开面板" icon={<LayoutDashboard size={15} />} action="open-today" />
        <MenuActionButton title="设置" icon={<Settings size={15} />} action="open-settings" tone="neutral" />
        <MenuActionButton
          title={hasVisibleWidgets ? "隐藏全部状态卡" : "桌面状态卡"}
          icon={<PanelsTopLeft size={15} />}
          action="toggle-widgets"
        />
        {payload.activeFocus ? (
          <MenuActionButton title="完成任务" icon={<CheckCircle2 size={15} />} action="finish-focus" />
        ) : null}
        <MenuActionButton
          title={remindersPaused ? "恢复提醒" : "暂停提醒"}
          icon={remindersPaused ? <Bell size={15} /> : <BellOff size={15} />}
          action={remindersPaused ? "resume-reminders" : "pause-reminders"}
          tone="warning"
        />
        <MenuActionButton title={petActionTitle} icon={petActionIcon} action={payload.hasAvailablePetPacks ? "toggle-pet" : "open-pet"} tone="pet" />
      </section>

      <div className="menu-glass-divider" />

      <footer className="menu-footer">
        <span>
          <Bell size={14} />
          {reminderPauseTitle(payload)}
        </span>
        <button type="button" onClick={() => void terminateApp()}>
          <Power size={14} />
          退出
        </button>
      </footer>
    </main>
  );
};
