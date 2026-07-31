import { BarChart3, CalendarDays, Clock3, Keyboard, MousePointer2, Percent, SquareStack, Zap } from "lucide-react";
import { useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { useFocusPet } from "../app/AppContext";
import { focusStateLabels } from "../core/labels";
import { formatCount, formatDate, formatDuration, formatPercentage } from "../core/formatters";
import { makeActivityHistorySnapshot, makeAttentionHistorySnapshot } from "../core/timeline";
import type { AttentionDayBucket, FocusState, StateSegment } from "../core/types";
import { secondsBetween } from "../core/utils";
import { Heatmap, HourlyBars, type HeatmapCell } from "./charts";
import { HoverCard, SegmentedControl, TogglePill } from "./ui";
import { AppIcon } from "./AppIcon";

const historyRanges = [3, 7, 15, 30, 60] as const;
type HistoryRange = (typeof historyRanges)[number];
type HeatmapScope = "week" | "month";

interface HourBucket {
  hour: number;
  focusSeconds: number;
  distractedSeconds: number;
  averageTotalMinutes: number;
  focusRatio: number;
}

interface HeatmapHoverState {
  day: AttentionDayBucket;
  x: number;
  y: number;
}

interface HourHoverState {
  bucket: HourBucket;
  x: number;
  y: number;
}

const attentionSeconds = (bucket: Pick<AttentionDayBucket, "focusSeconds" | "distractedSeconds">): number =>
  bucket.focusSeconds + bucket.distractedSeconds;

const bucketFocusRatio = (bucket: Pick<AttentionDayBucket, "focusSeconds" | "distractedSeconds">): number => {
  const total = attentionSeconds(bucket);
  return total > 0 ? bucket.focusSeconds / total : 0;
};

const dayTitle = (date: string): string =>
  new Date(date).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" });

const monthDayTitle = (date: string): string =>
  new Date(date).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

const dayKey = (date: Date): string => {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value.toISOString();
};

const rangeBounds = (rangeDays: number, now = new Date()): { start: Date; end: Date } => {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - Math.max(1, rangeDays) + 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { start, end: new Date(Math.max(start.getTime(), Math.min(now.getTime(), tomorrow.getTime()))) };
};

const includedDayKeys = ({ start, end }: { start: Date; end: Date }, skipsWeekends: boolean): Set<string> => {
  const included = new Set<string>();
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor < end) {
    const day = cursor.getDay();
    if (!skipsWeekends || (day !== 0 && day !== 6)) included.add(dayKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return included;
};

const makeHourlyBuckets = (
  segments: StateSegment[],
  rangeDays: number,
  skipsWeekends: boolean,
  dayCount: number,
): HourBucket[] => {
  const bounds = rangeBounds(rangeDays);
  const included = includedDayKeys(bounds, skipsWeekends);
  const buckets = Array.from({ length: 24 }, (_, hour) => ({ hour, focusSeconds: 0, distractedSeconds: 0 }));
  for (const segment of segments) {
    if (segment.state !== "focus" && segment.state !== "distracted") continue;
    let cursor = new Date(Math.max(new Date(segment.start).getTime(), bounds.start.getTime()));
    const end = new Date(Math.min(new Date(segment.end).getTime(), bounds.end.getTime()));
    while (cursor < end) {
      const nextHour = new Date(cursor);
      nextHour.setHours(cursor.getHours() + 1, 0, 0, 0);
      const next = new Date(Math.min(nextHour.getTime(), end.getTime()));
      if (included.has(dayKey(cursor))) {
        const seconds = secondsBetween(cursor, next);
        const bucket = buckets[cursor.getHours()];
        if (segment.state === "focus") bucket.focusSeconds += seconds;
        if (segment.state === "distracted") bucket.distractedSeconds += seconds;
      }
      cursor = next;
    }
  }
  return buckets.map((bucket) => {
    const total = bucket.focusSeconds + bucket.distractedSeconds;
    return {
      ...bucket,
      averageTotalMinutes: total / Math.max(1, dayCount) / 60,
      focusRatio: total > 0 ? bucket.focusSeconds / total : 0,
    };
  });
};

const makePeakFocusSeconds = (segments: StateSegment[], rangeDays: number, skipsWeekends: boolean): number => {
  const bounds = rangeBounds(rangeDays);
  const included = includedDayKeys(bounds, skipsWeekends);
  const daily = new Map<string, number>();
  for (const segment of segments) {
    if (segment.state !== "focus") continue;
    let cursor = new Date(Math.max(new Date(segment.start).getTime(), bounds.start.getTime()));
    const end = new Date(Math.min(new Date(segment.end).getTime(), bounds.end.getTime()));
    while (cursor < end) {
      const nextDay = new Date(cursor);
      nextDay.setHours(24, 0, 0, 0);
      const next = new Date(Math.min(nextDay.getTime(), end.getTime()));
      const key = dayKey(cursor);
      if (included.has(key)) daily.set(key, (daily.get(key) ?? 0) + secondsBetween(cursor, next));
      cursor = next;
    }
  }
  return Math.max(0, ...daily.values());
};

const InsightRow = ({ title, value, detail }: { title: string; value: string; detail: string }) => (
  <div className="attention-insight-row">
    <span>
      <strong>{value}</strong>
      <small>{title}</small>
    </span>
    <em>{detail}</em>
  </div>
);

const HoverLine = ({ title, value, state }: { title: string; value: string; state: FocusState }) => (
  <span className={`history-hover-line state-${state}`}>
    <i />
    <em>{title}</em>
    <strong>{value}</strong>
  </span>
);

const HeatmapHoverCard = ({ hover }: { hover: HeatmapHoverState }) => {
  const workSeconds = hover.day.focusSeconds + hover.day.distractedSeconds;
  const totalSeconds = workSeconds + hover.day.awaySeconds;
  return (
    <HoverCard className="history-hover-card heatmap-hover-card" style={{ "--hover-x": `${hover.x}px`, "--hover-y": `${hover.y}px` } as CSSProperties}>
      <div className="history-hover-title">
        <i style={{ "--ratio": bucketFocusRatio(hover.day), "--intensity": Math.min(1, attentionSeconds(hover.day) / 14_400) } as CSSProperties} />
        <strong>{monthDayTitle(hover.day.date)}</strong>
        <em>{formatDuration(totalSeconds)}</em>
      </div>
      <div className="history-hover-meter">
        <span>专注占比</span>
        <strong>{formatPercentage(attentionSeconds(hover.day) > 0 ? hover.day.focusSeconds / attentionSeconds(hover.day) : 0)}</strong>
        <i style={{ "--meter-width": `${Math.max(4, bucketFocusRatio(hover.day) * 100)}%` } as CSSProperties} />
      </div>
      <HoverLine title="专注" value={formatDuration(hover.day.focusSeconds)} state="focus" />
      <HoverLine title="走神" value={formatDuration(hover.day.distractedSeconds)} state="distracted" />
      {hover.day.awaySeconds > 0 ? <HoverLine title="暂离" value={formatDuration(hover.day.awaySeconds)} state="away" /> : null}
    </HoverCard>
  );
};

const HourHoverCard = ({ hover }: { hover: HourHoverState }) => (
  <HoverCard className="history-hover-card hour-hover-card" style={{ "--hover-x": `${hover.x}px`, "--hover-y": `${hover.y}px` } as CSSProperties}>
    <div className="history-hover-title">
      <strong>{`${String(hover.bucket.hour).padStart(2, "0")}:00-${String((hover.bucket.hour + 1) % 24).padStart(2, "0")}:00`}</strong>
      <em>{hover.bucket.averageTotalMinutes.toFixed(1)} 分钟/日</em>
    </div>
    <HoverLine title="专注累计" value={formatDuration(hover.bucket.focusSeconds)} state="focus" />
    <HoverLine title="走神累计" value={formatDuration(hover.bucket.distractedSeconds)} state="distracted" />
    <div className="history-hover-meter">
      <span>专注占比</span>
      <strong>{formatPercentage(hover.bucket.focusRatio)}</strong>
      <i style={{ "--meter-width": `${Math.max(4, hover.bucket.focusRatio * 100)}%` } as CSSProperties} />
    </div>
  </HoverCard>
);

const heatmapDurationLevels = Array.from({ length: 9 }, (_, level) => level);

const heatmapQualityLegend = [
  { title: "高", className: "quality-high" },
  { title: "稳", className: "quality-steady" },
  { title: "波动", className: "quality-variable" },
  { title: "偏离", className: "quality-offtrack" },
];

const HeatmapLegend = () => (
  <div className="swift-heatmap-legend" aria-label="热力图图例">
    <span>时长</span>
    <span className="heatmap-duration-scale" aria-label="时长等级">
      {heatmapDurationLevels.map((level) => (
        <i className={`level-${level}`} key={level} />
      ))}
    </span>
    <span>0-12h+</span>
    <b aria-hidden />
    {heatmapQualityLegend.map((item) => (
      <span className="heatmap-quality-item" key={item.title}>
        <i className={item.className} />
        {item.title}
      </span>
    ))}
  </div>
);

export const SessionsTab = () => {
  const { bundle } = useFocusPet();
  const state = bundle.state;
  const [historyRangeDays, setHistoryRangeDays] = useState<HistoryRange>(7);
  const [skipsWeekends, setSkipsWeekends] = useState(false);
  const [heatmapScope, setHeatmapScope] = useState<HeatmapScope>("week");
  const [heatmapHover, setHeatmapHover] = useState<HeatmapHoverState | null>(null);
  const [hourHover, setHourHover] = useState<HourHoverState | null>(null);
  const attentionHistory = useMemo(() => makeAttentionHistorySnapshot(state.stateSegments), [state.stateSegments]);
  const history = useMemo(
    () => makeActivityHistorySnapshot(historyRangeDays, state.stateSegments, state.appUsage, state.inputActivity, new Date(), skipsWeekends),
    [historyRangeDays, skipsWeekends, state.appUsage, state.inputActivity, state.stateSegments],
  );
  const hourlyBuckets = useMemo(
    () => makeHourlyBuckets(state.stateSegments, historyRangeDays, skipsWeekends, history.dayCount),
    [history.dayCount, historyRangeDays, skipsWeekends, state.stateSegments],
  );
  const peakFocusSeconds = useMemo(
    () => makePeakFocusSeconds(state.stateSegments, historyRangeDays, skipsWeekends),
    [historyRangeDays, skipsWeekends, state.stateSegments],
  );
  const maxHeatmapAttentionSeconds = useMemo(
    () => Math.max(
      1,
      ...attentionHistory.months.flatMap((month) => month.days.filter((day): day is AttentionDayBucket => day !== null).map(attentionSeconds)),
    ),
    [attentionHistory.months],
  );
  const selectedHeatmapDays = heatmapScope === "week"
    ? (attentionHistory.weeks.at(-1)?.days ?? [])
    : attentionHistory.months.at(-1)?.days.filter((day): day is AttentionDayBucket => day !== null) ?? [];
  const selectedHeatmapTotals = selectedHeatmapDays.reduce(
    (acc, day) => ({
      focusSeconds: acc.focusSeconds + day.focusSeconds,
      distractedSeconds: acc.distractedSeconds + day.distractedSeconds,
    }),
    { focusSeconds: 0, distractedSeconds: 0 },
  );
  const activeHeatmapDays = selectedHeatmapDays.filter((day) => attentionSeconds(day) > 0);
  const bestHeatmapDay = activeHeatmapDays.reduce<AttentionDayBucket | undefined>(
    (best, day) => (!best || day.focusSeconds > best.focusSeconds ? day : best),
    undefined,
  );
  const currentHeatmapTotal = selectedHeatmapTotals.focusSeconds + selectedHeatmapTotals.distractedSeconds;
  const historyAttentionSeconds = history.focusSeconds + history.distractedSeconds;
  const averageTotalInput = Math.round(
    (history.estimatedTypedCharacters + history.pointerActionCount + history.contextSwitchCount) / Math.max(1, history.dayCount),
  );
  const maxAverageMinutes = Math.max(1, ...hourlyBuckets.map((bucket) => bucket.averageTotalMinutes));
  const maxAppSeconds = Math.max(1, ...history.topApps.map((app) => app.averageSeconds));
  const stateTiles: Array<{ state: FocusState; seconds: number }> = [
    { state: "focus", seconds: history.focusSeconds },
    { state: "distracted", seconds: history.distractedSeconds },
    { state: "away", seconds: history.awaySeconds },
  ];
  const relativeHoverPoint = (event: PointerEvent<Element>, selector: string, width = 204): { x: number; y: number } => {
    const container = event.currentTarget.closest(selector) as HTMLElement | null;
    const bounds = container?.getBoundingClientRect();
    if (!bounds) return { x: 12, y: 12 };
    return {
      x: Math.min(Math.max(12, event.clientX - bounds.left + 12), Math.max(12, bounds.width - width - 12)),
      y: Math.max(12, event.clientY - bounds.top + 12),
    };
  };
  const showHeatmapHover = (day: AttentionDayBucket, event: PointerEvent<Element>) => {
    setHourHover(null);
    setHeatmapHover({ day, ...relativeHoverPoint(event, ".attention-history-card", 212) });
  };
  const showHourHover = (bucket: HourBucket, event: PointerEvent<Element>) => {
    setHeatmapHover(null);
    setHourHover({ bucket, ...relativeHoverPoint(event, ".activity-hourly-panel", 180) });
  };

  return (
    <div className="swift-sessions-page">
      <section className="history-card attention-history-card">
        <div className="history-card-header">
          <h2>
            <CalendarDays size={18} strokeWidth={2.5} />
            注意力热力图
          </h2>
          <SegmentedControl className="settings-segmented-control history-scope-control" label="热力图范围" value={heatmapScope} options={[{ value: "week", label: "周视图" }, { value: "month", label: "月视图" }]} onChange={setHeatmapScope} />
        </div>

        <div className="swift-heatmap-layout">
          <div className="swift-heatmap-main">
            {heatmapScope === "week" ? (
              <div className="swift-week-heatmap" onPointerLeave={() => setHeatmapHover(null)}>
                <div className="swift-week-chart">
                  <Heatmap
                    className="fp-week-heatmap"
                    label="周注意力热力图"
                    columns={attentionHistory.weeks.length}
                    rows={7}
                    columnLabels={attentionHistory.weeks.map((week) => monthDayTitle(week.start))}
                    rowLabels={["一", "二", "三", "四", "五", "六", "日"]}
                    cells={attentionHistory.weeks.flatMap((week, column) => week.days.map((day, row): HeatmapCell => ({
                      id: day.date,
                      column,
                      row,
                      ratio: bucketFocusRatio(day),
                      intensity: Math.min(1, attentionSeconds(day) / maxHeatmapAttentionSeconds),
                      label: `${dayTitle(day.date)} · 专注 ${formatDuration(day.focusSeconds)} · 走神 ${formatDuration(day.distractedSeconds)}`,
                    })))}
                    onHover={(cell, event) => {
                      const day = attentionHistory.weeks.flatMap((week) => week.days).find((item) => item.date === cell.id);
                      if (day) showHeatmapHover(day, event);
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="swift-month-heatmap" onPointerLeave={() => setHeatmapHover(null)}>
                {attentionHistory.months.map((month) => (
                  <div className="swift-month-panel" key={month.start}>
                    <div className="swift-month-panel-header" aria-label={`${month.title}专注 ${formatDuration(month.focusSeconds)}`}>
                      <strong>{month.title}</strong>
                      <span>{formatDuration(month.focusSeconds)}</span>
                    </div>
                    <Heatmap
                      className="swift-month-grid"
                      label={`${month.title}注意力热力图`}
                      columns={7}
                      rows={Math.ceil(month.days.length / 7)}
                      cells={month.days.map((day, index): HeatmapCell => ({
                        id: day?.date ?? `${month.start}-${index}`,
                        column: index % 7,
                        row: Math.floor(index / 7),
                        ratio: day ? bucketFocusRatio(day) : 0,
                        intensity: day ? Math.min(1, attentionSeconds(day) / maxHeatmapAttentionSeconds) : 0,
                        label: day ? `${dayTitle(day.date)} · 专注 ${formatDuration(day.focusSeconds)} · 走神 ${formatDuration(day.distractedSeconds)}` : "无日期",
                        disabled: !day,
                      }))}
                      onHover={(cell, event) => {
                        const day = month.days.find((item) => item?.date === cell.id);
                        if (day) showHeatmapHover(day, event);
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
            <HeatmapLegend />
          </div>

          <aside className="attention-insight-panel">
            <h3>
              <BarChart3 size={16} />
              历史洞察
            </h3>
            <InsightRow
              title={heatmapScope === "week" ? "本周专注" : "本月专注"}
              value={formatDuration(selectedHeatmapTotals.focusSeconds)}
              detail={formatPercentage(currentHeatmapTotal > 0 ? selectedHeatmapTotals.focusSeconds / currentHeatmapTotal : 0)}
            />
            <InsightRow
              title={heatmapScope === "week" ? "周内日均" : "月内日均"}
              value={formatDuration(selectedHeatmapTotals.focusSeconds / Math.max(1, activeHeatmapDays.length))}
              detail={`${activeHeatmapDays.length} 天活跃`}
            />
            <InsightRow
              title={heatmapScope === "week" ? "周内峰值" : "月内峰值"}
              value={bestHeatmapDay ? formatDate(bestHeatmapDay.date) : "暂无"}
              detail={bestHeatmapDay ? formatDuration(bestHeatmapDay.focusSeconds) : "无记录"}
            />
            <InsightRow
              title={heatmapScope === "week" ? "本周走神" : "本月走神"}
              value={formatDuration(selectedHeatmapTotals.distractedSeconds)}
              detail={formatPercentage(currentHeatmapTotal > 0 ? selectedHeatmapTotals.distractedSeconds / currentHeatmapTotal : 0)}
            />
            <div className="attention-focus-meter">
              <span>
                <small>专注占比</small>
                <strong>{formatPercentage(currentHeatmapTotal > 0 ? selectedHeatmapTotals.focusSeconds / currentHeatmapTotal : 0)}</strong>
              </span>
              <i style={{ "--meter-width": `${Math.max(4, (currentHeatmapTotal > 0 ? selectedHeatmapTotals.focusSeconds / currentHeatmapTotal : 0) * 100)}%` } as CSSProperties} />
            </div>
          </aside>
        </div>
        {heatmapHover ? <HeatmapHoverCard hover={heatmapHover} /> : null}
      </section>

      <section className="history-card activity-history-card">
        <div className="history-card-header activity-header">
          <h2>
            <BarChart3 size={18} strokeWidth={2.5} />
            活跃统计
            <span>{`最近 ${historyRangeDays} 天`}</span>
          </h2>
          <div className="history-header-actions">
            <TogglePill className={`history-weekend-toggle ${skipsWeekends ? "active" : ""}`} status="focus" checked={skipsWeekends} onCheckedChange={setSkipsWeekends}>跳过周末</TogglePill>
            <SegmentedControl className="settings-segmented-control history-range-control" label="历史范围" value={historyRangeDays} options={historyRanges.map((days) => ({ value: days, label: `${days}天` }))} onChange={setHistoryRangeDays} />
          </div>
        </div>

        <div className="activity-metric-grid">
          <article>
            <Zap size={18} />
            <span>活跃总计</span>
            <strong>{formatDuration(historyAttentionSeconds)}</strong>
            <small>{history.dayCount} 天有记录</small>
          </article>
          <article>
            <Percent size={18} />
            <span>专注占比</span>
            <strong>{formatPercentage(historyAttentionSeconds > 0 ? history.focusSeconds / historyAttentionSeconds : 0)}</strong>
            <small>走神 {formatPercentage(historyAttentionSeconds > 0 ? history.distractedSeconds / historyAttentionSeconds : 0)}</small>
          </article>
          <article>
            <Keyboard size={18} />
            <span>日均输入</span>
            <strong>{formatCount(averageTotalInput)}</strong>
            <small>
              键盘 {formatCount(history.estimatedTypedCharacters / Math.max(1, history.dayCount))} · 鼠标{" "}
              {formatCount(history.pointerActionCount / Math.max(1, history.dayCount))}
            </small>
          </article>
          <article>
            <Clock3 size={18} />
            <span>平均专注</span>
            <strong>{formatDuration(history.averageFocusSeconds)}</strong>
            <small>峰值 {formatDuration(peakFocusSeconds)}</small>
          </article>
        </div>

        <div className="activity-history-main">
          <section className="activity-hourly-panel" onPointerLeave={() => setHourHover(null)}>
            <div className="activity-panel-title">
              <h3>
                <BarChart3 size={16} />
                全天每小时活跃
              </h3>
              <span>
                <i className="state-focus" /> 专注
              </span>
              <span>
                <i className="state-distracted" /> 走神
              </span>
              <em>日均分钟</em>
            </div>
            <HourlyBars
              className="activity-hour-chart"
              label="全天每小时专注与走神日均分钟"
              maxValue={Math.max(60, maxAverageMinutes * 60)}
              data={hourlyBuckets.map((bucket) => ({
                id: String(bucket.hour),
                label: String(bucket.hour).padStart(2, "0"),
                focus: bucket.focusSeconds / Math.max(1, history.dayCount),
                distracted: bucket.distractedSeconds / Math.max(1, history.dayCount),
              }))}
              onHover={(datum, event) => {
                const bucket = hourlyBuckets.find((item) => String(item.hour) === datum.id);
                if (bucket) showHourHover(bucket, event);
              }}
            />
            {hourHover ? <HourHoverCard hover={hourHover} /> : null}
          </section>

          <section className="activity-app-panel">
            <div className="activity-panel-title">
              <h3>
                <SquareStack size={16} />
                日均应用活跃
              </h3>
              <em>日均</em>
            </div>
            {history.topApps.length === 0 ? (
              <div className="activity-empty-state">
                <strong>暂无应用记录</strong>
                <span>所选范围内还没有可展示的应用活跃数据。</span>
              </div>
            ) : (
              <div className="activity-app-list">
                {history.topApps.map((app, index) => (
                  <div className="activity-app-row" key={`${app.bundleID ?? app.appName}-${app.category}`}>
                    <em>{index + 1}</em>
                    <AppIcon className="activity-app-icon" appName={app.appName} bundleID={app.bundleID} category={app.category} />
                    <div>
                      <strong>{app.appName}</strong>
                      <i style={{ "--meter-width": `${Math.max(4, (app.averageSeconds / maxAppSeconds) * 100)}%` } as CSSProperties} />
                    </div>
                    <small>{formatDuration(app.averageSeconds)}</small>
                  </div>
                ))}
              </div>
            )}
            <div className="activity-input-mini">
              <span>
                <MousePointer2 size={14} />
                日均活跃输入
                <strong>{formatDuration(history.averageInputActiveSeconds)}</strong>
              </span>
              <span>
                <Keyboard size={14} />
                日均上下文切换
                <strong>{formatCount(history.contextSwitchCount / Math.max(1, history.dayCount))}</strong>
              </span>
            </div>
          </section>
        </div>

        <div className="activity-state-strip">
          {stateTiles.map((item) => {
            const total = history.focusSeconds + history.distractedSeconds + history.awaySeconds;
            return (
              <span className={`state-${item.state}`} key={item.state}>
                <strong>{focusStateLabels[item.state].title}</strong>
                <i style={{ "--meter-width": `${Math.max(4, total > 0 ? (item.seconds / total) * 100 : 0)}%` } as CSSProperties} />
                <em>{formatDuration(item.seconds)}</em>
              </span>
            );
          })}
        </div>
      </section>
    </div>
  );
};
