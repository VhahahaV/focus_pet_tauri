import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Keyboard, MousePointer2 } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { formatCount, formatPercentage } from "../core/formatters";
import type {
  ActivitySnapshot,
  AppThemeID,
  DailySummary,
  FocusState,
  InputTimelineSnapshot,
  InputWorkloadSummary,
  StateDecision,
} from "../core/types";
import { SegmentedControl } from "./ui";
import { defaultAppTheme, useDocumentTheme } from "../themes";

type WidgetMode = "currentStatus" | "recentRhythm";
type WidgetMoveLabel = "currentStatus" | "recentRhythm";
type RhythmWindowHours = 4 | 8 | 12;

const rhythmWindowHours = [4, 8, 12] as const;

interface WidgetPayload {
  theme: AppThemeID;
  currentDecision: StateDecision;
  summary: DailySummary;
  todayWorkload: InputWorkloadSummary;
  currentSnapshot: ActivitySnapshot;
  inputTimeline: InputTimelineSnapshot;
  recentRhythms?: Partial<Record<RhythmWindowHours, InputTimelineSnapshot>>;
  selectedRecentRhythmWindowHours?: number;
  statusMessage: string;
  latestPetBubble?: string;
  movementMode?: "fixed" | "free";
}

const shortDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}秒`;
  const minutes = Math.floor(safe / 60);
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours}小时` : `${hours}小时${remaining}分`;
};

const microDuration = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours}h` : `${hours}h${String(remaining).padStart(2, "0")}`;
};

const stateHeadline = (state: FocusState): string => {
  switch (state) {
    case "focus":
      return "专注中";
    case "distracted":
      return "走神中";
    case "away":
      return "暂离中";
  }
};

const stateDuration = (summary: DailySummary, state: FocusState): number => {
  switch (state) {
    case "focus":
      return summary.focusSeconds;
    case "distracted":
      return summary.distractedSeconds;
    case "away":
      return summary.awaySeconds;
  }
};

const selectedRhythmWindow = (value: number | undefined): RhythmWindowHours =>
  rhythmWindowHours.includes(value as RhythmWindowHours) ? (value as RhythmWindowHours) : 4;

const fallbackPayload = (): WidgetPayload => {
  const now = new Date().toISOString();
  const inputTimeline: InputTimelineSnapshot = {
    start: now,
    end: now,
    stateRanges: [
      { state: "focus", startProgress: 0, endProgress: 0.62 },
      { state: "distracted", startProgress: 0.62, endProgress: 0.72 },
      { state: "away", startProgress: 0.72, endProgress: 0.86 },
      { state: "focus", startProgress: 0.86, endProgress: 1 },
    ],
    appSegments: [],
    inputBars: [],
    switchMarkers: [],
    stateDurations: { focus: 96 * 60, distracted: 14 * 60, away: 18 * 60 },
    keyboardCount: 1240,
    pointerCount: 386,
    switchCount: 11,
    maxInputCount: 1,
    maxKeyboardCount: 1,
    maxPointerCount: 1,
  };
  return {
    theme: defaultAppTheme,
    currentDecision: {
      timestamp: now,
      state: "focus",
      category: "work",
      confidence: 0.6,
      reason: ["neutralDefault"],
      stableDuration: 0,
    },
    summary: {
      date: now.slice(0, 10),
      focusSeconds: 0,
      distractedSeconds: 0,
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
    todayWorkload: {
      start: now,
      end: now,
      estimatedTypedCharacters: 0,
      pointerActionCount: 0,
      contextSwitchCount: 0,
      activeSeconds: 0,
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
    inputTimeline,
    recentRhythms: { 4: inputTimeline, 8: inputTimeline, 12: inputTimeline },
    selectedRecentRhythmWindowHours: 4,
    statusMessage: "等待主窗口同步",
    movementMode: "free",
  };
};

export const WidgetView = ({ mode }: { mode: WidgetMode }) => {
  const [payload, setPayload] = useState<WidgetPayload>(() => fallbackPayload());
  useDocumentTheme(payload.theme);
  const moveLabel: WidgetMoveLabel = mode === "recentRhythm" ? "recentRhythm" : "currentStatus";

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    let unlisten: (() => void) | undefined;
    void listen<WidgetPayload>("focus-pet-widget-state", (event) => setPayload(event.payload)).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    let unlisten: (() => void) | undefined;
    const currentWindow = getCurrentWindow();
    void currentWindow.onMoved((event) => {
      void currentWindow.emitTo("main", "focus-pet-widget-moved", {
        label: moveLabel,
        x: event.payload.x,
        y: event.payload.y,
      });
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [moveLabel]);

  const startDragging = () => {
    if (payload.movementMode === "fixed") return;
    if (!("__TAURI_INTERNALS__" in window)) return;
    void getCurrentWindow().startDragging().catch(() => undefined);
  };

  if (mode === "recentRhythm") return <RecentRhythmWidget payload={payload} onDragStart={startDragging} />;
  return <CurrentStatusWidget payload={payload} onDragStart={startDragging} />;
};

const CurrentStatusWidget = ({ payload, onDragStart }: { payload: WidgetPayload; onDragStart: () => void }) => {
  const currentState = payload.currentDecision.state;
  const durationChips: Array<{ state: FocusState; title: string }> = [
    { state: "focus", title: "专" },
    { state: "distracted", title: "走" },
    { state: "away", title: "离" },
  ];
  return (
    <main className={`widget-card widget-status state-${currentState} movement-${payload.movementMode ?? "free"}`} onPointerDown={onDragStart}>
      <WidgetLabel title="当前状态" state={currentState} />
      <div className="widget-status-title">
        <strong>{stateHeadline(currentState)}</strong>
        <span>已稳定 {shortDuration(payload.currentDecision.stableDuration)}</span>
      </div>
      <div className="widget-status-spacer" aria-hidden />
      <div className="widget-micro-row">
        <MicroItem icon="keyboard" text={`${formatCount(payload.inputTimeline.keyboardCount)} 键`} />
        <MicroItem icon="pointer" text={`${formatCount(payload.inputTimeline.pointerCount)} 鼠`} />
      </div>
      <div className="widget-duration-strip" aria-label="今日状态时长">
        {durationChips.map((chip) => (
          <span className={`state-${chip.state}`} key={chip.state}>
            <b>{chip.title}</b>
            {microDuration(stateDuration(payload.summary, chip.state))}
          </span>
        ))}
      </div>
    </main>
  );
};

const RecentRhythmWidget = ({ payload, onDragStart }: { payload: WidgetPayload; onDragStart: () => void }) => {
  const selectedWindow = selectedRhythmWindow(payload.selectedRecentRhythmWindowHours);
  const [activeWindowHours, setActiveWindowHours] = useState<RhythmWindowHours>(selectedWindow);

  useEffect(() => {
    setActiveWindowHours(selectedWindow);
  }, [selectedWindow]);

  const rhythm = payload.recentRhythms?.[activeWindowHours] ?? payload.inputTimeline;
  const stateDurations = rhythm.stateDurations;
  const focusSeconds = stateDurations.focus ?? 0;
  const distractedSeconds = stateDurations.distracted ?? 0;
  const activeSeconds = focusSeconds + distractedSeconds;
  const focusRatio = activeSeconds > 0 ? focusSeconds / activeSeconds : 0;
  const caption = focusRatio >= 0.7 ? "稳定" : focusRatio >= 0.5 ? "有波动" : "偏离较多";
  const metrics = useMemo(
    () => [
      { state: "focus" as const, title: "专注", seconds: focusSeconds },
      { state: "distracted" as const, title: "走神", seconds: distractedSeconds },
    ],
    [distractedSeconds, focusSeconds],
  );
  const timelineRanges = useMemo(
    () => {
      const visibleRanges = rhythm.stateRanges.filter((range) => range.state !== "away" && range.endProgress > range.startProgress);
      const totalWidth = visibleRanges.reduce((total, range) => total + range.endProgress - range.startProgress, 0);
      if (totalWidth <= 0) return [];
      let cursor = 0;
      return visibleRanges.map((range, index) => {
        const width = (range.endProgress - range.startProgress) / totalWidth;
        const normalized = { id: `${range.state}-${index}`, state: range.state, startProgress: cursor, width };
        cursor += width;
        return normalized;
      });
    },
    [rhythm.stateRanges],
  );
  const focusDeg = focusRatio * 360;
  const distractedDeg = (activeSeconds > 0 ? distractedSeconds / activeSeconds : 0) * 360;

  return (
    <main className={`widget-card widget-rhythm movement-${payload.movementMode ?? "free"}`} onPointerDown={onDragStart}>
      <header className="widget-rhythm-header">
        <WidgetLabel title="最近节奏" state="focus" />
        <div onPointerDown={(event) => event.stopPropagation()}>
          <SegmentedControl className="widget-rhythm-switch" label="最近节奏时间窗口" value={activeWindowHours} options={rhythmWindowHours.map((hours) => ({ value: hours, label: `${hours}h` }))} onChange={setActiveWindowHours} />
        </div>
      </header>
      <div className="widget-rhythm-body">
        <div
          className="widget-donut"
          style={{
            "--focus-end": `${focusDeg}deg`,
            "--distracted-end": `${focusDeg + distractedDeg}deg`,
          } as CSSProperties}
          aria-label={`专注占比 ${formatPercentage(focusRatio)}`}
        >
          <span>{formatPercentage(focusRatio)}</span>
        </div>
        <div className="widget-rhythm-copy">
          <strong>
            近 {activeWindowHours} 小时{caption}
          </strong>
          <div className="widget-rhythm-metrics">
            {metrics.map((metric) => (
              <span className={`state-${metric.state}`} key={metric.state}>
                <b>{shortDuration(metric.seconds)}</b>
                {metric.title}
              </span>
            ))}
          </div>
          <div className="widget-rhythm-timeline" aria-label="最近状态时间线">
            {timelineRanges.map((range) => (
              <i
                className={`state-${range.state}`}
                key={range.id}
                style={{ "--timeline-x": `${range.startProgress * 100}%`, "--timeline-width": `${Math.max(0.8, range.width * 100)}%` } as CSSProperties}
              />
            ))}
          </div>
        </div>
      </div>
    </main>
  );
};

const WidgetLabel = ({ title, state }: { title: string; state: FocusState }) => (
  <div className={`widget-label state-${state}`}>
    <i />
    <span>{title}</span>
  </div>
);

const MicroItem = ({ icon, text }: { icon: "keyboard" | "pointer"; text: string }) => {
  const Icon = icon === "keyboard" ? Keyboard : MousePointer2;
  return (
    <span className="widget-micro-item">
      <Icon size={11} strokeWidth={3} />
      {text}
    </span>
  );
};
