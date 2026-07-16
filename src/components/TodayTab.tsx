import { ArrowRight, Clock3, Coffee, Keyboard, MousePointer2, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useFocusPet } from "../app/AppContext";
import { categoryLabels, focusStateLabels } from "../core/labels";
import { formatClock, formatCount, formatDuration, formatPercentage } from "../core/formatters";
import { summaryTotalSeconds } from "../core/summary";
import { remainingBreakSeconds } from "../core/sessions";
import { makeInputTimelineSnapshot } from "../core/timeline";
import type {
  ActivityCategory,
  AppUsageSegment,
  FocusState,
  InputTimelineInputBar,
  InputTimelineSnapshot,
  InputTimelineStateRange,
  InputTimelineSwitchMarker,
  StateSegment,
} from "../core/types";
import { secondsBetween } from "../core/utils";
import { nativeAppIcon } from "../store/native";
import { FilledPieChart, ProgressRing } from "./charts";
import { Badge, HoverCard, PrimaryButton, SegmentedControl, SemanticCard } from "./ui";

const timelineWindows = [2, 4, 6, 8, 12, 24] as const;

const appIconCache = new Map<string, string | null>();

const NativeAppIcon = ({ appName, bundleID, category }: { appName: string; bundleID?: string; category: ActivityCategory }) => {
  const key = (bundleID?.trim() || appName.trim()).toLowerCase();
  const [iconURL, setIconURL] = useState<string | null | undefined>(() => appIconCache.get(key));
  useEffect(() => {
    let active = true;
    if (appIconCache.has(key)) {
      setIconURL(appIconCache.get(key));
      return () => { active = false; };
    }
    void nativeAppIcon(bundleID, appName).then((url) => {
      appIconCache.set(key, url ?? null);
      if (active) setIconURL(url ?? null);
    });
    return () => { active = false; };
  }, [appName, bundleID, key]);
  return iconURL ? (
    <span className="today-app-icon"><img src={iconURL} alt="" /></span>
  ) : (
    <span className={`today-app-icon fallback category-${category}`}>{appName.trim().slice(0, 1).toUpperCase()}</span>
  );
};

const stateChartColors: Record<FocusState, string> = {
  focus: "var(--focus-500)",
  distracted: "var(--distracted-500)",
  break: "var(--rest-500)",
  away: "var(--away-500)",
};

interface TodayAppInsightItem {
  id: string;
  appName: string;
  bundleID?: string;
  category: ActivityCategory;
  seconds: number;
  stateBreakdown: Record<FocusState, number>;
}

interface TodayAppInsightAccumulator extends TodayAppInsightItem {
  categorySeconds: Record<ActivityCategory, number>;
  hasUsageSeconds: boolean;
}

interface TodayInsightSnapshot {
  start: Date;
  end: Date;
  rangeLabel: string;
  stateItems: Array<{ state: FocusState; seconds: number }>;
  rhythmItems: Array<{ state: FocusState; seconds: number }>;
  rhythmTotalSeconds: number;
  appItems: TodayAppInsightItem[];
}

interface TimelineHourTick {
  id: string;
  label: string;
  progress: number;
}

interface TimelineHoverDetail {
  id: string;
  title: string;
  lines: string[];
  color: string;
  xPercent: number;
  top: number;
}

const stateHeadline = (state: FocusState, focusSeconds: number): string => {
  switch (state) {
    case "focus":
      return focusSeconds === 0 ? "正在自动识别" : "已进入稳定工作";
    case "distracted":
      return "注意力正在偏离";
    case "break":
      return "正在休息恢复";
    case "away":
      return "暂离中";
  }
};

const stateSubtitle = (state: FocusState): string => {
  switch (state) {
    case "focus":
      return "App、输入和切换节奏保持稳定";
    case "distracted":
      return "建议先回到当前任务两分钟";
    case "break":
      return "这段时间会单独记录";
    case "away":
      return "回来后继续接上今日记录";
  }
};

const stateSeconds = (state: FocusState, summary: ReturnType<typeof useFocusPet>["bundle"]["state"]["summary"]): number => {
  switch (state) {
    case "focus":
      return summary.focusSeconds;
    case "distracted":
      return summary.distractedSeconds;
    case "break":
      return summary.breakSeconds;
    case "away":
      return summary.awaySeconds;
  }
};

const clippedSeconds = (start: string, end: string, bounds: { start: Date; end: Date }): number => {
  const clippedStart = new Date(Math.max(new Date(start).getTime(), bounds.start.getTime()));
  const clippedEnd = new Date(Math.min(new Date(end).getTime(), bounds.end.getTime()));
  return clippedEnd > clippedStart ? secondsBetween(clippedStart, clippedEnd) : 0;
};

const overlappedSeconds = (
  lhsStart: string,
  lhsEnd: string,
  rhsStart: string,
  rhsEnd: string,
  bounds: { start: Date; end: Date },
): number => {
  const clippedStart = new Date(Math.max(new Date(lhsStart).getTime(), new Date(rhsStart).getTime(), bounds.start.getTime()));
  const clippedEnd = new Date(Math.min(new Date(lhsEnd).getTime(), new Date(rhsEnd).getTime(), bounds.end.getTime()));
  return clippedEnd > clippedStart ? secondsBetween(clippedStart, clippedEnd) : 0;
};

const hiddenSystemUsage = (appName: string, bundleID?: string): boolean => {
  const normalizedName = appName.trim().toLowerCase();
  const normalizedBundleID = bundleID?.toLowerCase() ?? "";
  return ["sleep", "loginwindow", "locked screen", "break", "away"].includes(normalizedName) || normalizedBundleID.includes("loginwindow");
};

const normalizedCategory = (category: ActivityCategory): ActivityCategory => category === "neutral" ? "ignore" : category;

const appInsightKey = (appName: string, bundleID?: string): string => (bundleID?.trim() || appName.trim()).toLowerCase();

const emptyStateBreakdown = (): Record<FocusState, number> => ({ focus: 0, distracted: 0, break: 0, away: 0 });

const emptyCategorySeconds = (): Record<ActivityCategory, number> => ({ work: 0, entertainment: 0, ignore: 0, neutral: 0 });

const appInsightAccumulator = (
  appName: string,
  bundleID: string | undefined,
  category: ActivityCategory,
  key: string,
): TodayAppInsightAccumulator => ({
  id: key,
  appName,
  bundleID,
  category: normalizedCategory(category),
  seconds: 0,
  stateBreakdown: emptyStateBreakdown(),
  categorySeconds: emptyCategorySeconds(),
  hasUsageSeconds: false,
});

const dominantCategory = (categorySeconds: Record<ActivityCategory, number>): ActivityCategory => {
  const entries = (Object.entries(categorySeconds) as Array<[ActivityCategory, number]>)
    .filter(([category]) => category !== "neutral")
    .sort((lhs, rhs) => rhs[1] - lhs[1]);
  return entries[0]?.[1] > 0 ? entries[0][0] : "ignore";
};

const makeTodayInsightSnapshot = (
  windowHours: number,
  stateSegments: StateSegment[],
  appUsage: AppUsageSegment[],
  now = new Date(),
): TodayInsightSnapshot => {
  const end = now;
  const start = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  const bounds = { start, end };
  const durations: Record<FocusState, number> = { focus: 0, distracted: 0, break: 0, away: 0 };
  const apps = new Map<string, TodayAppInsightAccumulator>();

  for (const segment of stateSegments) {
    const seconds = clippedSeconds(segment.start, segment.end, bounds);
    if (seconds <= 0) continue;
    durations[segment.state] += seconds;
  }

  for (const usage of appUsage) {
    if (hiddenSystemUsage(usage.appName, usage.bundleID)) continue;
    const seconds = clippedSeconds(usage.start, usage.end, bounds);
    if (seconds <= 0) continue;
    const category = normalizedCategory(usage.category);
    const key = appInsightKey(usage.appName, usage.bundleID);
    const current = apps.get(key) ?? appInsightAccumulator(usage.appName, usage.bundleID, category, key);
    current.seconds += seconds;
    current.hasUsageSeconds = true;
    current.bundleID = current.bundleID ?? usage.bundleID;
    current.categorySeconds[category] += seconds;
    current.category = dominantCategory(current.categorySeconds);
    for (const segment of stateSegments) {
      const overlap = overlappedSeconds(usage.start, usage.end, segment.start, segment.end, bounds);
      if (overlap <= 0) continue;
      current.stateBreakdown[segment.state] += overlap;
    }
    apps.set(key, current);
  }

  for (const segment of stateSegments) {
    if (hiddenSystemUsage(segment.appName, segment.bundleID)) continue;
    const seconds = clippedSeconds(segment.start, segment.end, bounds);
    if (seconds <= 0) continue;
    const category = normalizedCategory(segment.category);
    const key = appInsightKey(segment.appName, segment.bundleID);
    const current = apps.get(key) ?? appInsightAccumulator(segment.appName, segment.bundleID, category, key);
    if (current.hasUsageSeconds) continue;
    current.bundleID = current.bundleID ?? segment.bundleID;
    current.stateBreakdown[segment.state] += seconds;
    current.seconds += seconds;
    current.categorySeconds[category] += seconds;
    current.category = dominantCategory(current.categorySeconds);
    apps.set(key, current);
  }

  const stateItems = (["focus", "distracted", "break", "away"] as FocusState[]).map((state) => ({
    state,
    seconds: durations[state],
  }));
  const rhythmItems = stateItems.filter((item) => item.state !== "away");
  return {
    start,
    end,
    rangeLabel: `${formatClock(start)} - ${formatClock(end)}`,
    stateItems,
    rhythmItems,
    rhythmTotalSeconds: rhythmItems.reduce((total, item) => total + item.seconds, 0),
    appItems: [...apps.values()]
      .filter((item) => item.seconds > 0)
      .map(({ categorySeconds: _categorySeconds, hasUsageSeconds: _hasUsageSeconds, ...item }) => item)
      .sort((lhs, rhs) => rhs.seconds === lhs.seconds ? lhs.appName.localeCompare(rhs.appName, "zh-CN") : rhs.seconds - lhs.seconds)
      .slice(0, 10),
  };
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const progressInTimeline = (snapshot: InputTimelineSnapshot, date: string | Date): number => {
  const start = new Date(snapshot.start).getTime();
  const end = new Date(snapshot.end).getTime();
  const value = typeof date === "string" ? new Date(date).getTime() : date.getTime();
  return clamp((value - start) / Math.max(1, end - start), 0, 1);
};

const dateAtProgress = (snapshot: InputTimelineSnapshot, progress: number): Date => {
  const start = new Date(snapshot.start).getTime();
  const end = new Date(snapshot.end).getTime();
  return new Date(start + (end - start) * clamp(progress, 0, 1));
};

const durationFromProgress = (snapshot: InputTimelineSnapshot, startProgress: number, endProgress: number): number =>
  secondsBetween(dateAtProgress(snapshot, startProgress), dateAtProgress(snapshot, endProgress));

const timelineHourTicks = (snapshot: InputTimelineSnapshot): TimelineHourTick[] => {
  const start = new Date(snapshot.start);
  const end = new Date(snapshot.end);
  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  if (cursor <= start) cursor.setHours(cursor.getHours() + 1);
  const ticks: TimelineHourTick[] = [];
  while (cursor < end) {
    const progress = progressInTimeline(snapshot, cursor);
    ticks.push({
      id: `${cursor.getTime()}-${Math.round(progress * 10_000)}`,
      label: formatClock(cursor),
      progress,
    });
    cursor.setHours(cursor.getHours() + 1);
  }
  return ticks;
};

const TimelineHoverBubble = ({ detail }: { detail: TimelineHoverDetail }) => (
  <HoverCard
    className="timeline-hover-bubble"
    style={
      {
        "--hover-x": `${clamp(detail.xPercent, 8, 90)}%`,
        "--hover-y": `${detail.top}px`,
        "--timeline-hover-color": detail.color,
      } as CSSProperties
    }
  >
    <strong>
      <i />
      {detail.title}
    </strong>
    {detail.lines.map((line) => (
      <span key={line}>{line}</span>
    ))}
  </HoverCard>
);

const RhythmFilledPieChart = ({ snapshot, dominant }: { snapshot: TodayInsightSnapshot; dominant: { state: FocusState; seconds: number } }) => {
  const dominantRatio = snapshot.rhythmTotalSeconds > 0 ? dominant.seconds / snapshot.rhythmTotalSeconds : 0;
  return (
    <FilledPieChart
      className="rhythm-filled-pie"
      label="窗口节奏填充饼图"
      primaryValue={snapshot.rhythmTotalSeconds > 0 ? formatPercentage(dominantRatio) : undefined}
      primaryDetail={snapshot.rhythmTotalSeconds > 0 ? formatDuration(dominant.seconds) : undefined}
      data={snapshot.rhythmItems.map((item) => ({
        id: item.state,
        label: focusStateLabels[item.state].title,
        value: item.seconds,
        valueLabel: `${formatDuration(item.seconds)} · ${formatPercentage(item.seconds / Math.max(snapshot.rhythmTotalSeconds, 1))}`,
        color: stateChartColors[item.state],
      }))}
    />
  );
};

const TodayAppMiniMeter = ({ item, maxSeconds }: { item: TodayAppInsightItem; maxSeconds: number }) => {
  const ratio = item.seconds / Math.max(1, maxSeconds);
  const filledWidth = Math.max(item.seconds > 0 ? 8 : 0, ratio * 100);
  const states = (["focus", "distracted", "break", "away"] as FocusState[]).filter((state) => item.stateBreakdown[state] > 0);

  return (
    <div
      className="today-app-meter"
      aria-label={`${item.appName} 状态分段 ${states.map((state) => `${focusStateLabels[state].title}${formatDuration(item.stateBreakdown[state])}`).join(" ") || "暂无状态分段"}`}
    >
      <div className={`today-app-meter-fill category-${item.category}`} style={{ "--meter-width": `${filledWidth}%` } as CSSProperties}>
        {states.length > 0 ? states.map((state) => (
          <span
            className={`state-${state}`}
            key={state}
            style={{ "--meter-width": `${Math.max(4, (item.stateBreakdown[state] / Math.max(1, item.seconds)) * 100)}%` } as CSSProperties}
            title={`${focusStateLabels[state].title} ${formatDuration(item.stateBreakdown[state])}`}
          />
        )) : <span className={`category-${item.category}`} />}
      </div>
    </div>
  );
};

const TodayInsightsGrid = ({ snapshot }: { snapshot: TodayInsightSnapshot }) => {
  const maxAppSeconds = Math.max(1, ...snapshot.appItems.map((item) => item.seconds));
  const dominant = snapshot.rhythmItems
    .filter((item) => item.seconds > 0)
    .sort((lhs, rhs) => rhs.seconds - lhs.seconds)[0] ?? { state: "focus" as FocusState, seconds: 0 };
  return (
    <div className="today-insights-grid">
      <section className="today-app-usage-card">
        <div className="today-insight-header">
          <h2>时间去哪了</h2>
          <span><Clock3 size={13} /> {snapshot.rangeLabel}</span>
          <span>{snapshot.appItems.length} 个应用</span>
        </div>
        {snapshot.appItems.length === 0 ? (
          <div className="today-insight-empty">暂无应用记录。</div>
        ) : (
          <div className="today-app-usage-list">
            {snapshot.appItems.slice(0, 6).map((item, index) => (
              <div className="today-app-usage-row" key={item.id}>
                <em>{index + 1}</em>
                <NativeAppIcon appName={item.appName} bundleID={item.bundleID} category={item.category} />
                <div className="today-app-name">
                  <strong>{item.appName}</strong>
                  <small>{categoryLabels[item.category].title}</small>
                </div>
                <TodayAppMiniMeter item={item} maxSeconds={maxAppSeconds} />
                <strong className="today-app-duration">{formatDuration(item.seconds)}</strong>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="today-rhythm-card">
        <div className="today-insight-header">
          <h2>窗口节奏</h2>
          <span><Clock3 size={13} /> {Math.round((snapshot.end.getTime() - snapshot.start.getTime()) / 3_600_000)}h</span>
        </div>
        <RhythmFilledPieChart snapshot={snapshot} dominant={dominant} />
      </section>
    </div>
  );
};

export const TodayTab = () => {
  const { bundle, activeBreak, actions } = useFocusPet();
  const [windowHours, setWindowHours] = useState<(typeof timelineWindows)[number]>(4);
  const decision = bundle.state.currentDecision;
  const summary = bundle.state.summary;
  const workload = bundle.state.todayWorkload;
  const inputTimeline = useMemo(
    () => makeInputTimelineSnapshot(windowHours * 60 * 60, bundle.state.stateSegments, bundle.state.appUsage, bundle.state.inputActivity),
    [bundle.state.appUsage, bundle.state.inputActivity, bundle.state.stateSegments, windowHours],
  );
  const insightSnapshot = useMemo(
    () => makeTodayInsightSnapshot(windowHours, bundle.state.stateSegments, bundle.state.appUsage),
    [bundle.state.appUsage, bundle.state.stateSegments, windowHours],
  );
  const total = summaryTotalSeconds(summary);
  const activeSeconds = stateSeconds(decision.state, summary);
  const hourTicks = useMemo(() => timelineHourTicks(inputTimeline), [inputTimeline]);
  const [timelineHover, setTimelineHover] = useState<TimelineHoverDetail | null>(null);
  const breakSeconds = activeBreak ? remainingBreakSeconds(activeBreak) : bundle.state.settings.breakMinutes * 60;
  const breakProgress = activeBreak ? clamp(1 - breakSeconds / Math.max(1, activeBreak.targetDurationSeconds), 0, 1) : undefined;

  const stateHoverDetail = (range: InputTimelineStateRange): TimelineHoverDetail => {
    const start = dateAtProgress(inputTimeline, range.startProgress);
    const end = dateAtProgress(inputTimeline, range.endProgress);
    const seconds = durationFromProgress(inputTimeline, range.startProgress, range.endProgress);
    return {
      id: `state-${range.state}-${range.startProgress}`,
      title: focusStateLabels[range.state].title,
      lines: [`${formatClock(start)} - ${formatClock(end)}`, `持续 ${formatDuration(seconds)}`],
      color: stateChartColors[range.state],
      xPercent: ((range.startProgress + range.endProgress) / 2) * 100,
      top: 78,
    };
  };

  const inputHoverDetail = (bar: InputTimelineInputBar): TimelineHoverDetail => {
    const start = dateAtProgress(inputTimeline, bar.startProgress);
    const end = dateAtProgress(inputTimeline, bar.endProgress);
    const totalInput = bar.keyboardCount + bar.pointerCount;
    const minutes = Math.max(1, secondsBetween(start, end) / 60);
    return {
      id: `input-${bar.startProgress}-${bar.endProgress}`,
      title: `输入 ${formatCount(totalInput)} 次`,
      lines: [
        `${formatClock(start)} - ${formatClock(end)}`,
        `频率 ${(totalInput / minutes).toFixed(1)} 次/分钟`,
        `键盘 ${formatCount(bar.keyboardCount)} 次`,
        `鼠标 ${formatCount(bar.pointerCount)} 次`,
        `切换 ${formatCount(bar.switchCount)} 次`,
        "本地估算，不记录输入内容",
      ],
      color: bar.pointerCount > bar.keyboardCount ? "var(--chart-hover-pointer)" : "var(--chart-hover-keyboard)",
      xPercent: ((bar.startProgress + bar.endProgress) / 2) * 100,
      top: 76,
    };
  };

  const switchHoverDetail = (marker: InputTimelineSwitchMarker): TimelineHoverDetail => ({
    id: `switch-${marker.progress}-${marker.count}`,
    title: `切换 ${formatCount(marker.count)} 次`,
    lines: [`约 ${formatClock(dateAtProgress(inputTimeline, marker.progress))}`, "App 或窗口焦点变化"],
    color: "var(--chart-hover-switch)",
    xPercent: marker.progress * 100,
    top: 76,
  });

  return (
    <div className="swift-today">
      <h1 className="sr-only">今日</h1>
      <div className="today-top-grid">
        <SemanticCard status={decision.state === "break" ? "rest" : decision.state} className={`swift-focus-card state-${decision.state}`}>
          <div className="focus-card-main">
            <div>
              <p className="swift-section-kicker">今日态势</p>
              <h2>{stateHeadline(decision.state, summary.focusSeconds)}</h2>
              <p>{stateSubtitle(decision.state)}</p>
            </div>
            <div className="focus-duration">
              <strong>{formatDuration(activeSeconds)}</strong>
              <span>
                {decision.state === "focus"
                  ? "今日专注"
                  : decision.state === "distracted"
                    ? "今日走神"
                    : decision.state === "break"
                      ? "今日休息"
                      : "今日暂离"}
              </span>
              <em>{decision.state === "distracted" ? `今日专注 ${formatDuration(summary.focusSeconds)}` : `今日走神 ${formatDuration(summary.distractedSeconds)}`}</em>
            </div>
          </div>
          <div className="today-chip-row">
            <Badge compact status={decision.state === "break" ? "rest" : decision.state} className="today-chip state-chip">{focusStateLabels[decision.state].title}</Badge>
            <Badge compact className="today-chip app-chip">{bundle.state.currentSnapshot.appName || "Focus..."}</Badge>
            <Badge compact icon={<RotateCcw size={13} />} className="today-chip switch-chip">{formatCount(workload.contextSwitchCount)} 次切换</Badge>
            <Badge compact icon={<Keyboard size={13} />} className="today-chip key-chip">键盘 {formatCount(workload.estimatedTypedCharacters)} 次</Badge>
          </div>
        </SemanticCard>

        <SemanticCard status="rest" className="swift-break-card">
          <div className="break-header">
            <span className="break-icon"><Coffee size={18} /></span>
            <strong>{activeBreak ? "正在恢复" : "休息恢复"}</strong>
          </div>
          <div className="break-main">
            <strong>{activeBreak ? formatDuration(breakSeconds) : `${bundle.state.settings.breakMinutes} 分钟`}</strong>
            <ProgressRing className="break-ring" label={activeBreak ? "休息进度" : "建议休息时长"} value={activeBreak ? Math.max(0.04, breakProgress ?? 0) : 0.72}>
              <Coffee size={22} />
            </ProgressRing>
          </div>
          {activeBreak ? (
            <div className="break-progress-panel" aria-hidden>
              <span style={{ "--break-progress": Math.max(0.02, breakProgress ?? 0) } as CSSProperties} />
            </div>
          ) : (
            <SegmentedControl
              className="minute-selector"
              label="休息分钟"
              status="rest"
              value={bundle.state.settings.breakMinutes}
              options={[1, 5, 10, 30].map((minute) => ({ value: minute, label: `${minute}m` }))}
              onChange={(minute) => actions.updateSettings((settings) => ({ ...settings, breakMinutes: minute }))}
            />
          )}
          <PrimaryButton status="rest" className="start-rest-button" type="button" onClick={actions.toggleBreak}>
            <span><Coffee size={15} /></span>
            {activeBreak ? "结束休息" : "开始恢复"}
            <ArrowRight size={14} />
          </PrimaryButton>
        </SemanticCard>
      </div>

      <section className="swift-timeline-card">
        <div className="timeline-header">
          <div className="timeline-title-group">
            <h2>活动时间窗</h2>
            <span>自动记录</span>
          </div>
          <SegmentedControl
            className="window-picker"
            label="活动时间窗"
            value={windowHours}
            options={timelineWindows.map((hours) => ({ value: hours, label: `${hours}h` }))}
            onChange={setWindowHours}
          />
        </div>
        <div className="timeline-metrics">
          <span><RefreshCw size={14} /> 最近 {windowHours} 小时</span>
            <span className="key"><Keyboard size={14} /> 键盘 {formatCount(inputTimeline.keyboardCount)} 次</span>
            <span className="mouse"><MousePointer2 size={14} /> 鼠标 {formatCount(inputTimeline.pointerCount)} 次</span>
            <span className="switch"><RotateCcw size={14} /> 切换 {formatCount(inputTimeline.switchCount)} 次</span>
            <span>{formatClock(inputTimeline.start)} - {formatClock(inputTimeline.end)}</span>
        </div>
        <div className="activity-chart" aria-label="活动时间窗" onPointerLeave={() => setTimelineHover(null)}>
          <div className="axis-label state-label">状态</div>
          <div className="axis-label input-label">输入</div>
          <div className="timeline-hour-grid" aria-hidden>
            {hourTicks.map((tick) => (
              <span className="timeline-hour-grid-tick" key={tick.id} style={{ "--timeline-x": `${tick.progress * 100}%` } as CSSProperties} />
            ))}
          </div>
          <div className="state-track">
            <span className="muted-range" />
            {inputTimeline.stateRanges.map((range, index) => (
              <span
                className={`state-block state-${range.state}`}
                key={`${range.state}-${index}-${range.startProgress}`}
                onFocus={() => setTimelineHover(stateHoverDetail(range))}
                onPointerEnter={() => setTimelineHover(stateHoverDetail(range))}
                style={{
                  "--timeline-x": `${range.startProgress * 100}%`,
                  "--timeline-width": `${Math.max(0.8, (range.endProgress - range.startProgress) * 100)}%`,
                } as CSSProperties}
                tabIndex={0}
              >
                {range.endProgress - range.startProgress > 0.055 ? focusStateLabels[range.state].title : ""}
              </span>
            ))}
          </div>
          <div className="input-bars">
            {inputTimeline.switchMarkers.map((marker, index) => (
              <i
                className="switch-marker"
                key={`switch-${index}-${marker.progress}`}
                onFocus={() => setTimelineHover(switchHoverDetail(marker))}
                onPointerEnter={() => setTimelineHover(switchHoverDetail(marker))}
                style={{
                  "--timeline-x": `${marker.progress * 100}%`,
                  "--timeline-height": `${Math.min(100, 22 + marker.count * 12)}%`,
                } as CSSProperties}
                tabIndex={0}
              />
            ))}
            {inputTimeline.inputBars.map((bar, index) => {
              const count = bar.keyboardCount + bar.pointerCount;
              const height = inputTimeline.maxInputCount > 0 ? (count / inputTimeline.maxInputCount) * 100 : 2;
              const bucketWidth = Math.max(0, (bar.endProgress - bar.startProgress) * 100);
              const barWidth = Math.max(0.1, bucketWidth * 0.56);
              const barOffset = Math.max(0, (bucketWidth - barWidth) / 2);
              return (
                <span
                  className={bar.keyboardCount >= bar.pointerCount ? "green" : "purple"}
                  key={index}
                  onFocus={() => setTimelineHover(inputHoverDetail(bar))}
                  onPointerEnter={() => setTimelineHover(inputHoverDetail(bar))}
                  style={{
                    "--timeline-x": `${bar.startProgress * 100 + barOffset}%`,
                    "--timeline-width": `${barWidth}%`,
                    "--timeline-height": `${Math.max(7, height)}%`,
                    "--timeline-opacity": count > 0 ? 1 : 0.28,
                  } as CSSProperties}
                  tabIndex={0}
                />
              );
            })}
          </div>
          <div className="chart-grid-lines" />
          <div className="timeline-hour-axis" aria-hidden>
            {hourTicks.map((tick) => (
              <span key={tick.id} style={{ "--timeline-x": `${tick.progress * 100}%` } as CSSProperties}>
                <i />
                <em>{tick.label}</em>
              </span>
            ))}
          </div>
          {timelineHover ? <TimelineHoverBubble detail={timelineHover} /> : null}
        </div>
        <div className="sr-only">状态分布总计 {formatDuration(total)}</div>
      </section>

      <TodayInsightsGrid snapshot={insightSnapshot} />
    </div>
  );
};
