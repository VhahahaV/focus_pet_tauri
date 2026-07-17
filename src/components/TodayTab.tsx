import { AppWindow, Clock3, Keyboard, MousePointer2, RefreshCw, RotateCcw, Target, TimerReset } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useFocusPet } from "../app/AppContext";
import { resolveDisplaySourceAction } from "../app/petCompanionLogic";
import { categoryLabels, focusStateLabels, petIntentLabels } from "../core/labels";
import { formatClock, formatCount, formatDuration, formatPercentage } from "../core/formatters";
import { summaryTotalSeconds } from "../core/summary";
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
import { FilledPieChart } from "./charts";
import { Badge, HoverCard, SegmentedControl, SemanticCard } from "./ui";
import { AppIcon } from "./AppIcon";
import { SystemMonitorCard } from "./SystemMonitorCard";
import { sourceActionAssetsForID } from "../resources/petPack";

const timelineWindows = [2, 4, 6, 8, 12, 24] as const;

const stateChartColors: Record<FocusState, string> = {
  focus: "var(--focus-500)",
  distracted: "var(--distracted-500)",
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

const hiddenSystemUsage = (appName: string, bundleID?: string): boolean => {
  const normalizedName = appName.trim().toLowerCase();
  const normalizedBundleID = bundleID?.toLowerCase() ?? "";
  return ["sleep", "loginwindow", "locked screen", "away"].includes(normalizedName) || normalizedBundleID.includes("loginwindow");
};

const normalizedCategory = (category: ActivityCategory): ActivityCategory => category === "neutral" ? "ignore" : category;

const appInsightKey = (appName: string, bundleID?: string): string => (bundleID?.trim() || appName.trim()).toLowerCase();

const emptyStateBreakdown = (): Record<FocusState, number> => ({ focus: 0, distracted: 0, away: 0 });

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
  const startMs = start.getTime();
  const endMs = end.getTime();
  const durations: Record<FocusState, number> = { focus: 0, distracted: 0, away: 0 };
  const apps = new Map<string, TodayAppInsightAccumulator>();
  const indexedStateSegments = stateSegments
    .map((segment) => ({
      segment,
      startMs: Math.max(startMs, new Date(segment.start).getTime()),
      endMs: Math.min(endMs, new Date(segment.end).getTime()),
    }))
    .filter((item) => item.endMs > item.startMs)
    .sort((lhs, rhs) => lhs.startMs - rhs.startMs);

  for (const item of indexedStateSegments) {
    durations[item.segment.state] += (item.endMs - item.startMs) / 1000;
  }

  for (const usage of appUsage) {
    if (hiddenSystemUsage(usage.appName, usage.bundleID)) continue;
    const usageStartMs = Math.max(startMs, new Date(usage.start).getTime());
    const usageEndMs = Math.min(endMs, new Date(usage.end).getTime());
    const seconds = Math.max(0, (usageEndMs - usageStartMs) / 1000);
    if (seconds <= 0) continue;
    const category = normalizedCategory(usage.category);
    const key = appInsightKey(usage.appName, usage.bundleID);
    const current = apps.get(key) ?? appInsightAccumulator(usage.appName, usage.bundleID, category, key);
    current.seconds += seconds;
    current.hasUsageSeconds = true;
    current.bundleID = current.bundleID ?? usage.bundleID;
    current.categorySeconds[category] += seconds;
    current.category = dominantCategory(current.categorySeconds);
    let low = 0;
    let high = indexedStateSegments.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (indexedStateSegments[middle].endMs <= usageStartMs) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < indexedStateSegments.length; index += 1) {
      const item = indexedStateSegments[index];
      if (item.startMs >= usageEndMs) break;
      const overlap = Math.max(0, Math.min(usageEndMs, item.endMs) - Math.max(usageStartMs, item.startMs)) / 1000;
      if (overlap <= 0) continue;
      current.stateBreakdown[item.segment.state] += overlap;
    }
    apps.set(key, current);
  }

  for (const { segment, startMs: segmentStartMs, endMs: segmentEndMs } of indexedStateSegments) {
    if (hiddenSystemUsage(segment.appName, segment.bundleID)) continue;
    const seconds = (segmentEndMs - segmentStartMs) / 1000;
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

  const stateItems = (["focus", "distracted", "away"] as FocusState[]).map((state) => ({
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
  const states = (["focus", "distracted", "away"] as FocusState[]).filter((state) => item.stateBreakdown[state] > 0);

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
          <div className="today-app-usage-list" role="list" aria-label="应用使用排行，显示五行高度，可滚动查看更多">
            {snapshot.appItems.map((item, index) => (
              <div className="today-app-usage-row" key={item.id}>
                <em>{index + 1}</em>
                <AppIcon className="today-app-icon" appName={item.appName} bundleID={item.bundleID} category={item.category} />
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
  const { bundle, petPacks } = useFocusPet();
  const [windowHours, setWindowHours] = useState<(typeof timelineWindows)[number]>(4);
  const [detailsReady, setDetailsReady] = useState(false);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setDetailsReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const decision = bundle.state.currentDecision;
  const summary = bundle.state.summary;
  const inputTimeline = useMemo(
    () => makeInputTimelineSnapshot(
      windowHours * 60 * 60,
      detailsReady ? bundle.state.stateSegments : [],
      detailsReady ? bundle.state.appUsage : [],
      detailsReady ? bundle.state.inputActivity : [],
    ),
    [bundle.state.appUsage, bundle.state.inputActivity, bundle.state.stateSegments, detailsReady, windowHours],
  );
  const insightSnapshot = useMemo(
    () => makeTodayInsightSnapshot(
      windowHours,
      detailsReady ? bundle.state.stateSegments : [],
      detailsReady ? bundle.state.appUsage : [],
    ),
    [bundle.state.appUsage, bundle.state.stateSegments, detailsReady, windowHours],
  );
  const total = summaryTotalSeconds(summary);
  const attentionSeconds = summary.focusSeconds + summary.distractedSeconds;
  const focusRatio = attentionSeconds > 0 ? summary.focusSeconds / attentionSeconds : 0;
  const activeAppCount = summary.appUsage.filter((item) => item.seconds > 0).length;
  const topApp = summary.appUsage[0];
  const selectedPet = petPacks.find((record) => record.id === bundle.state.settings.pet.selectedPackID) ?? petPacks[0];
  const miniPetURL = useMemo(() => {
    const action = resolveDisplaySourceAction(
      bundle.state.currentPetIntent,
      selectedPet,
      bundle.state.settings.pet,
      {},
    ).action;
    return sourceActionAssetsForID(selectedPet, action?.id)?.frameURLs[0]
      ?? selectedPet?.previewURL
      ?? `${import.meta.env.BASE_URL}assets/pet-pixel-cat.png`;
  }, [bundle.state.currentPetIntent, bundle.state.settings.pet, selectedPet]);
  const hourTicks = useMemo(() => timelineHourTicks(inputTimeline), [inputTimeline]);
  const [timelineHover, setTimelineHover] = useState<TimelineHoverDetail | null>(null);

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
      color: bar.pointerCount > bar.keyboardCount ? "var(--chart-pointer)" : "var(--chart-kbd)",
      xPercent: ((bar.startProgress + bar.endProgress) / 2) * 100,
      top: 76,
    };
  };

  const switchHoverDetail = (marker: InputTimelineSwitchMarker): TimelineHoverDetail => ({
    id: `switch-${marker.progress}-${marker.count}`,
    title: `切换 ${formatCount(marker.count)} 次`,
    lines: [`约 ${formatClock(dateAtProgress(inputTimeline, marker.progress))}`, "App 或窗口焦点变化"],
    color: "var(--chart-switch)",
    xPercent: marker.progress * 100,
    top: 76,
  });

  return (
    <div className="swift-today">
      <h1 className="sr-only">今日</h1>
      <div className="today-top-grid">
        <SemanticCard status={decision.state} className={`swift-focus-card state-${decision.state}`}>
          <div className="today-focus-header">
            <div>
              <p className="swift-section-kicker">今日态势</p>
              <Badge compact status={decision.state} className="today-current-state">{focusStateLabels[decision.state].title}</Badge>
            </div>
            <span>当前状态已持续 {formatDuration(decision.stableDuration)}</span>
          </div>
          <div className="today-focus-dashboard">
            <div className="today-focus-hero">
              <div className="focus-duration today-focus-duration">
                <strong>{formatDuration(summary.focusSeconds)}</strong>
                <span>今日专注</span>
              </div>
              <div className="today-mini-pet" aria-label={`桌宠：${petIntentLabels[bundle.state.currentPetIntent.kind]}`}>
                <span className="today-mini-pet-avatar"><img src={miniPetURL} alt="" draggable={false} /></span>
                <span className="today-mini-pet-copy">
                  <small>桌宠状态</small>
                  <strong>{petIntentLabels[bundle.state.currentPetIntent.kind]}</strong>
                  <em>{selectedPet?.pack.name ?? "Focus Pet"}</em>
                </span>
              </div>
            </div>
            <div className="today-focus-stat-grid">
              <span><Target size={14} /><small>专注占比</small><strong>{formatPercentage(focusRatio)}</strong></span>
              <span><TimerReset size={14} /><small>最长连贯</small><strong>{formatDuration(summary.longestFocusSeconds)}</strong></span>
              <span><AppWindow size={14} /><small>活跃应用</small><strong>{activeAppCount}</strong></span>
              <span className="today-top-app-stat" title={topApp?.appName ?? "等待记录"} aria-label={`使用最多 ${topApp?.appName ?? "等待记录"}`}>
                <Clock3 size={14} />
                <small>使用最多</small>
                {topApp ? (
                  <AppIcon
                    appName={topApp.appName}
                    bundleID={topApp.bundleID}
                    category={topApp.category}
                    className="today-top-app-icon"
                  />
                ) : <strong>—</strong>}
              </span>
            </div>
          </div>
        </SemanticCard>

        <SystemMonitorCard />
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
              const keyboardHeight = (bar.keyboardCount / Math.max(1, inputTimeline.maxKeyboardCount)) * 50;
              const pointerHeight = (bar.pointerCount / Math.max(1, inputTimeline.maxPointerCount)) * 50;
              const bucketWidth = Math.max(0, (bar.endProgress - bar.startProgress) * 100);
              const density = Math.min(0.98, 0.88 + Math.log2(windowHours) * 0.025);
              const barWidth = Math.max(0.1, bucketWidth * density);
              const barOffset = Math.max(0, (bucketWidth - barWidth) / 2);
              return (
                <span
                  className="input-stack"
                  key={index}
                  onFocus={() => setTimelineHover(inputHoverDetail(bar))}
                  onPointerEnter={() => setTimelineHover(inputHoverDetail(bar))}
                  style={{
                    "--timeline-x": `${bar.startProgress * 100 + barOffset}%`,
                    "--timeline-width": `${barWidth}%`,
                    "--timeline-density": density,
                    "--timeline-opacity": count > 0 ? 1 : 0.28,
                  } as CSSProperties}
                  tabIndex={0}
                >
                  <i className="pointer-segment" style={{ "--segment-height": `${pointerHeight}%` } as CSSProperties} />
                  <i className="keyboard-segment" style={{ "--segment-height": `${keyboardHeight}%` } as CSSProperties} />
                </span>
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
