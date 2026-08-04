import type {
  ActivitySignalSource,
  ActivityHistorySnapshot,
  AttentionDayBucket,
  AttentionHistorySnapshot,
  AttentionMonthCalendar,
  AttentionWeekBucket,
  AppUsageSegment,
  FocusState,
  InputActivityBucket,
  InputTimelineAppSegment,
  InputTimelineInputBar,
  InputTimelineSnapshot,
  InputTimelineStateRange,
  StateDecision,
  StateSegment,
  WorkTimelineBreakdown,
} from "./types";
import { addSeconds, byStart, makeID, secondsBetween } from "./utils";

export const emptyBreakdown = (): WorkTimelineBreakdown => ({
  focusSeconds: 0,
  distractedSeconds: 0,
  breakSeconds: 0,
  awaySeconds: 0,
});

export const addBreakdown = (breakdown: WorkTimelineBreakdown, state: FocusState, seconds: number): WorkTimelineBreakdown => {
  const safe = Math.max(0, seconds);
  switch (state) {
    case "focus":
      return { ...breakdown, focusSeconds: breakdown.focusSeconds + safe };
    case "distracted":
      return { ...breakdown, distractedSeconds: breakdown.distractedSeconds + safe };
    case "break":
      return { ...breakdown, breakSeconds: breakdown.breakSeconds + safe };
    case "away":
      return { ...breakdown, awaySeconds: breakdown.awaySeconds + safe };
  }
};

export const stateDurationSeconds = (segment: StateSegment): number => secondsBetween(segment.start, segment.end);

export const appUsageDurationSeconds = (segment: AppUsageSegment): number => secondsBetween(segment.start, segment.end);

export const recordStateSegment = (
  decision: StateDecision,
  snapshot: {
    timestamp: string;
    appName: string;
    bundleID?: string;
    category: StateSegment["category"];
    titleStored: boolean;
    titleDisplay?: string;
    source: ActivitySignalSource[];
  },
  segments: StateSegment[],
  tickSeconds = 10,
  mergeGapSeconds = 15,
): StateSegment[] => {
  const updated = [...segments];
  const last = updated.at(-1);
  if (
    last &&
    last.state === decision.state &&
    last.category === decision.category &&
    last.appName === snapshot.appName &&
    last.bundleID === snapshot.bundleID &&
    secondsBetween(last.end, snapshot.timestamp) <= mergeGapSeconds
  ) {
    updated[updated.length - 1] = { ...last, end: new Date(Math.max(new Date(last.end).getTime(), new Date(snapshot.timestamp).getTime())).toISOString() };
    return updated;
  }

  const proposedStart = addSeconds(snapshot.timestamp, -tickSeconds);
  const previousEnd = last?.end ?? proposedStart;
  const start = new Date(Math.max(new Date(proposedStart).getTime(), new Date(previousEnd).getTime())).toISOString();
  if (new Date(snapshot.timestamp) <= new Date(start)) return updated;
  updated.push({
    id: makeID("state-segment"),
    start,
    end: snapshot.timestamp,
    state: decision.state,
    appName: snapshot.appName,
    bundleID: snapshot.bundleID,
    category: snapshot.category,
    titleStored: snapshot.titleStored,
    titleDisplay: snapshot.titleDisplay,
    source: snapshot.source,
  });
  return updated;
};

export const recordAppUsageSegment = (
  snapshot: { timestamp: string; appName: string; bundleID?: string; category: AppUsageSegment["category"] },
  appUsage: AppUsageSegment[],
  tickSeconds = 10,
  mergeGapSeconds = 15,
): AppUsageSegment[] => {
  const updated = [...appUsage];
  const last = updated.at(-1);
  if (
    last &&
    last.appName === snapshot.appName &&
    last.bundleID === snapshot.bundleID &&
    last.category === snapshot.category &&
    secondsBetween(last.end, snapshot.timestamp) <= mergeGapSeconds
  ) {
    updated[updated.length - 1] = { ...last, end: new Date(Math.max(new Date(last.end).getTime(), new Date(snapshot.timestamp).getTime())).toISOString() };
    return updated;
  }
  const proposedStart = addSeconds(snapshot.timestamp, -tickSeconds);
  const previousEnd = last?.end ?? proposedStart;
  const start = new Date(Math.max(new Date(proposedStart).getTime(), new Date(previousEnd).getTime())).toISOString();
  if (new Date(snapshot.timestamp) <= new Date(start)) return updated;
  updated.push({
    id: makeID("app-usage"),
    start,
    end: snapshot.timestamp,
    appName: snapshot.appName,
    bundleID: snapshot.bundleID,
    category: snapshot.category,
  });
  return updated;
};

export const bucketStart = (date: string | Date, bucketSeconds = 60): Date => {
  const value = typeof date === "string" ? new Date(date) : date;
  const interval = Math.max(5, bucketSeconds);
  return new Date(Math.floor(value.getTime() / 1000 / interval) * interval * 1000);
};

export const recordInputActivity = (
  now: string | Date,
  keyboardCount: number,
  pointerCount: number,
  switchCount: number,
  buckets: InputActivityBucket[],
  bucketSeconds = 60,
): InputActivityBucket[] => {
  if (keyboardCount <= 0 && pointerCount <= 0 && switchCount <= 0) return buckets;
  const start = bucketStart(now, bucketSeconds);
  const end = new Date(start.getTime() + Math.max(5, bucketSeconds) * 1000);
  const startISO = start.toISOString();
  const endISO = end.toISOString();
  const updated = [...buckets];
  const index = updated.findIndex((bucket) => bucket.start === startISO && bucket.end === endISO);
  if (index >= 0) {
    const current = updated[index];
    updated[index] = {
      ...current,
      keyboardCount: current.keyboardCount + Math.max(0, keyboardCount),
      pointerCount: current.pointerCount + Math.max(0, pointerCount),
      switchCount: current.switchCount + Math.max(0, switchCount),
    };
    return updated;
  }
  updated.push({
    start: startISO,
    end: endISO,
    keyboardCount: Math.max(0, keyboardCount),
    pointerCount: Math.max(0, pointerCount),
    switchCount: Math.max(0, switchCount),
  });
  return byStart(updated);
};

const aggregateSeconds = (windowSeconds: number): number => Math.ceil(Math.max(60, windowSeconds / 104) / 60) * 60;

const aggregateInputBuckets = (
  inputActivity: InputActivityBucket[],
  start: Date,
  end: Date,
  aggregateBySeconds: number,
): InputActivityBucket[] => {
  const grouped = new Map<string, InputActivityBucket>();
  for (const bucket of byStart(inputActivity)) {
    if (new Date(bucket.start) >= end || new Date(bucket.end) <= start) continue;
    const key = bucketStart(bucket.start, aggregateBySeconds).toISOString();
    const bucketEnd = addSeconds(key, aggregateBySeconds);
    const current = grouped.get(key) ?? { start: key, end: bucketEnd, keyboardCount: 0, pointerCount: 0, switchCount: 0 };
    grouped.set(key, {
      ...current,
      keyboardCount: current.keyboardCount + bucket.keyboardCount,
      pointerCount: current.pointerCount + bucket.pointerCount,
      switchCount: current.switchCount + bucket.switchCount,
    });
  }
  return [...grouped.values()].sort((lhs, rhs) => new Date(lhs.start).getTime() - new Date(rhs.start).getTime());
};

const isHiddenAppSegment = (segment: AppUsageSegment): boolean => {
  const appName = segment.appName.trim().toLowerCase();
  const bundleID = segment.bundleID?.toLowerCase() ?? "";
  return appName === "sleep" || appName === "loginwindow" || appName === "locked screen" || bundleID.includes("loginwindow");
};

const mergeAdjacentStateRanges = (ranges: InputTimelineStateRange[], maxGap: number): InputTimelineStateRange[] => {
  const merged: InputTimelineStateRange[] = [];
  for (const range of [...ranges].sort((lhs, rhs) => lhs.startProgress - rhs.startProgress)) {
    if (range.endProgress <= range.startProgress) continue;
    const last = merged.at(-1);
    if (last && last.state === range.state && range.startProgress - last.endProgress <= maxGap) {
      last.endProgress = Math.max(last.endProgress, range.endProgress);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};

export const makeInputTimelineSnapshot = (
  windowSeconds: number,
  stateSegments: StateSegment[],
  appUsage: AppUsageSegment[],
  inputActivity: InputActivityBucket[],
  now = new Date(),
  includeAwayState = true,
  includeAppSegments = true,
): InputTimelineSnapshot => {
  const safeWindowSeconds = Math.max(60, windowSeconds);
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - safeWindowSeconds * 1000);
  const span = Math.max(1, (windowEnd.getTime() - windowStart.getTime()) / 1000);
  const stateDurations: Partial<Record<FocusState, number>> = {};
  const rawStateRanges: InputTimelineStateRange[] = [];
  for (const segment of byStart(stateSegments)) {
    const segmentStart = new Date(segment.start);
    const segmentEnd = new Date(segment.end);
    if (segmentStart >= windowEnd || segmentEnd <= windowStart) continue;
    if (!includeAwayState && segment.state === "away") continue;
    const clippedStart = new Date(Math.max(segmentStart.getTime(), windowStart.getTime()));
    const clippedEnd = new Date(Math.min(segmentEnd.getTime(), windowEnd.getTime()));
    if (clippedEnd <= clippedStart) continue;
    stateDurations[segment.state] = (stateDurations[segment.state] ?? 0) + secondsBetween(clippedStart, clippedEnd);
    rawStateRanges.push({
      startProgress: (clippedStart.getTime() - windowStart.getTime()) / 1000 / span,
      endProgress: (clippedEnd.getTime() - windowStart.getTime()) / 1000 / span,
      state: segment.state,
    });
  }
  const aggregate = aggregateInputBuckets(inputActivity, windowStart, windowEnd, aggregateSeconds(safeWindowSeconds));
  const keyboardCount = aggregate.reduce((total, bucket) => total + bucket.keyboardCount, 0);
  const pointerCount = aggregate.reduce((total, bucket) => total + bucket.pointerCount, 0);
  const switchCount = aggregate.reduce((total, bucket) => total + bucket.switchCount, 0);
  const inputBars: InputTimelineInputBar[] = aggregate
    .filter((bucket) => bucket.keyboardCount > 0 || bucket.pointerCount > 0)
    .map((bucket) => {
      const clippedStart = new Date(Math.max(new Date(bucket.start).getTime(), windowStart.getTime()));
      const clippedEnd = new Date(Math.min(new Date(bucket.end).getTime(), windowEnd.getTime()));
      return {
        startProgress: (clippedStart.getTime() - windowStart.getTime()) / 1000 / span,
        endProgress: (clippedEnd.getTime() - windowStart.getTime()) / 1000 / span,
        keyboardCount: bucket.keyboardCount,
        pointerCount: bucket.pointerCount,
        switchCount: bucket.switchCount,
      };
    });
  const switchMarkers = aggregate
    .filter((bucket) => bucket.switchCount > 0)
    .map((bucket) => {
      const start = new Date(Math.max(new Date(bucket.start).getTime(), windowStart.getTime()));
      const end = new Date(Math.min(new Date(bucket.end).getTime(), windowEnd.getTime()));
      return {
        progress: Math.max(0, Math.min(1, ((start.getTime() + (end.getTime() - start.getTime()) / 2) - windowStart.getTime()) / 1000 / span)),
        count: bucket.switchCount,
      };
    });
  const appSegments: InputTimelineAppSegment[] = includeAppSegments
    ? byStart(appUsage)
        .filter((segment) => !isHiddenAppSegment(segment))
        .filter((segment) => new Date(segment.start) < windowEnd && new Date(segment.end) > windowStart)
        .map((segment) => ({
          start: new Date(Math.max(new Date(segment.start).getTime(), windowStart.getTime())).toISOString(),
          end: new Date(Math.min(new Date(segment.end).getTime(), windowEnd.getTime())).toISOString(),
          appName: segment.appName,
          bundleID: segment.bundleID,
          category: segment.category,
        }))
    : [];
  return {
    start: windowStart.toISOString(),
    end: windowEnd.toISOString(),
    stateRanges: mergeAdjacentStateRanges(rawStateRanges, Math.min(0.001, Math.max(0.00002, 1 / safeWindowSeconds))),
    inputBars,
    appSegments,
    switchMarkers,
    stateDurations,
    keyboardCount,
    pointerCount,
    switchCount,
    maxInputCount: Math.max(1, ...inputBars.map((bar) => bar.keyboardCount + bar.pointerCount)),
    maxKeyboardCount: Math.max(1, ...inputBars.map((bar) => bar.keyboardCount)),
    maxPointerCount: Math.max(1, ...inputBars.map((bar) => bar.pointerCount)),
  };
};

export const inputWorkloadSummary = (
  inputActivity: InputActivityBucket[],
  start: Date,
  end: Date,
) => {
  let estimatedTypedCharacters = 0;
  let pointerActionCount = 0;
  let contextSwitchCount = 0;
  let activeSeconds = 0;
  for (const bucket of inputActivity) {
    const bucketStartDate = new Date(bucket.start);
    const bucketEndDate = new Date(bucket.end);
    if (bucketEndDate <= start || bucketStartDate >= end) continue;
    estimatedTypedCharacters += bucket.keyboardCount;
    pointerActionCount += bucket.pointerCount;
    contextSwitchCount += bucket.switchCount;
    if (bucket.keyboardCount + bucket.pointerCount + bucket.switchCount > 0) {
      activeSeconds += secondsBetween(
        new Date(Math.max(bucketStartDate.getTime(), start.getTime())),
        new Date(Math.min(bucketEndDate.getTime(), end.getTime())),
      );
    }
  }
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    estimatedTypedCharacters,
    pointerActionCount,
    contextSwitchCount,
    activeSeconds,
  };
};

const historyDayKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const includedHistoryDayKeys = (start: Date, end: Date, skipsWeekends: boolean): Set<string> => {
  const included = new Set<string>();
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  while (cursor < end) {
    const day = cursor.getDay();
    if (!skipsWeekends || (day !== 0 && day !== 6)) {
      included.add(historyDayKey(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return included;
};

const includedOverlapSeconds = (
  start: string | Date,
  end: string | Date,
  bounds: { start: Date; end: Date },
  includedDayKeys: Set<string>,
): number => {
  const segmentStart = typeof start === "string" ? new Date(start) : start;
  const segmentEnd = typeof end === "string" ? new Date(end) : end;
  let cursor = new Date(Math.max(segmentStart.getTime(), bounds.start.getTime()));
  const clippedEnd = new Date(Math.min(segmentEnd.getTime(), bounds.end.getTime()));
  let seconds = 0;
  while (cursor < clippedEnd) {
    const nextDay = new Date(cursor);
    nextDay.setHours(24, 0, 0, 0);
    const next = new Date(Math.min(nextDay.getTime(), clippedEnd.getTime()));
    if (includedDayKeys.has(historyDayKey(cursor))) {
      seconds += secondsBetween(cursor, next);
    }
    cursor = next;
  }
  return seconds;
};

const emptyAttentionDayBucket = (date: Date): AttentionDayBucket => ({
  date: date.toISOString(),
  ...emptyBreakdown(),
});

const attentionDayKey = (date: Date): string => {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.toISOString();
};

const firstDayOfMonth = (date: Date): Date => {
  const value = new Date(date);
  value.setDate(1);
  value.setHours(0, 0, 0, 0);
  return value;
};

const monthTitle = (date: Date): string => `${date.getMonth() + 1}月`;

export const makeAttentionHistorySnapshot = (
  stateSegments: StateSegment[],
  now = new Date(),
): AttentionHistorySnapshot => {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const currentWeekStart = new Date(today);
  const mondayOffset = (currentWeekStart.getDay() + 6) % 7;
  currentWeekStart.setDate(currentWeekStart.getDate() - mondayOffset);
  const currentMonthStart = firstDayOfMonth(today);
  const earliestWeek = new Date(currentWeekStart);
  earliestWeek.setDate(earliestWeek.getDate() - 11 * 7);
  const earliestRecordedAt = stateSegments.reduce<number | undefined>((earliestValue, segment) => {
    const start = new Date(segment.start).getTime();
    const finish = new Date(segment.end).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish <= start || start > now.getTime()) {
      return earliestValue;
    }
    return earliestValue === undefined ? start : Math.min(earliestValue, start);
  }, undefined);
  // Month view begins with the first month that actually contains a retained
  // usage record. With no history yet, keep only the current month as an empty
  // onboarding state instead of fabricating five earlier blank calendars.
  const earliestMonth = earliestRecordedAt === undefined
    ? currentMonthStart
    : firstDayOfMonth(new Date(earliestRecordedAt));
  const earliest = new Date(Math.min(earliestWeek.getTime(), earliestMonth.getTime()));
  const end = new Date(today);
  end.setDate(end.getDate() + 1);
  const buckets = new Map<string, AttentionDayBucket>();

  for (const segment of byStart(stateSegments)) {
    if (new Date(segment.end) <= earliest || new Date(segment.start) >= end) continue;
    let cursor = new Date(Math.max(new Date(segment.start).getTime(), earliest.getTime()));
    const segmentEnd = new Date(Math.min(new Date(segment.end).getTime(), end.getTime()));
    while (cursor < segmentEnd) {
      const nextDay = new Date(cursor);
      nextDay.setHours(24, 0, 0, 0);
      const next = new Date(Math.min(nextDay.getTime(), segmentEnd.getTime()));
      const key = attentionDayKey(cursor);
      const bucket = buckets.get(key) ?? emptyAttentionDayBucket(new Date(key));
      const seconds = secondsBetween(cursor, next);
      const updated = addBreakdown(bucket, segment.state, seconds);
      buckets.set(key, { ...bucket, ...updated });
      cursor = next;
    }
  }

  const dayBucket = (date: Date): AttentionDayBucket => buckets.get(attentionDayKey(date)) ?? emptyAttentionDayBucket(date);
  const weeks: AttentionWeekBucket[] = Array.from({ length: 12 }, (_, index) => {
    const start = new Date(earliestWeek);
    start.setDate(start.getDate() + index * 7);
    const days = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date(start);
      date.setDate(date.getDate() + offset);
      return dayBucket(date);
    });
    return { start: start.toISOString(), days };
  });
  const monthCount = Math.max(
    1,
    (currentMonthStart.getFullYear() - earliestMonth.getFullYear()) * 12
      + currentMonthStart.getMonth()
      - earliestMonth.getMonth()
      + 1,
  );
  const months: AttentionMonthCalendar[] = Array.from({ length: monthCount }, (_, index) => {
    const start = new Date(earliestMonth);
    start.setMonth(start.getMonth() + index);
    const nextMonth = new Date(start);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const leadingBlankCount = (start.getDay() + 6) % 7;
    const days: Array<AttentionDayBucket | null> = Array.from({ length: leadingBlankCount }, () => null);
    let focusSeconds = 0;
    let distractedSeconds = 0;
    let breakSeconds = 0;
    let awaySeconds = 0;
    const cursor = new Date(start);
    while (cursor < nextMonth) {
      const bucket = dayBucket(cursor);
      days.push(bucket);
      focusSeconds += bucket.focusSeconds;
      distractedSeconds += bucket.distractedSeconds;
      breakSeconds += bucket.breakSeconds;
      awaySeconds += bucket.awaySeconds;
      cursor.setDate(cursor.getDate() + 1);
    }
    while (days.length % 7 !== 0) days.push(null);
    return {
      start: start.toISOString(),
      title: monthTitle(start),
      days,
      focusSeconds,
      distractedSeconds,
      breakSeconds,
      awaySeconds,
    };
  });
  const totals = [...buckets.values()].reduce<WorkTimelineBreakdown>((breakdown, bucket) => ({
    focusSeconds: breakdown.focusSeconds + bucket.focusSeconds,
    distractedSeconds: breakdown.distractedSeconds + bucket.distractedSeconds,
    breakSeconds: breakdown.breakSeconds + bucket.breakSeconds,
    awaySeconds: breakdown.awaySeconds + bucket.awaySeconds,
  }), emptyBreakdown());

  return {
    start: earliest.toISOString(),
    end: end.toISOString(),
    weeks,
    months,
    focusSeconds: totals.focusSeconds,
    distractedSeconds: totals.distractedSeconds,
    breakSeconds: totals.breakSeconds,
    awaySeconds: totals.awaySeconds,
  };
};

export const makeActivityHistorySnapshot = (
  rangeDays: number,
  stateSegments: StateSegment[],
  appUsage: AppUsageSegment[],
  inputActivity: InputActivityBucket[],
  now = new Date(),
  skipsWeekends = false,
): ActivityHistorySnapshot => {
  const safeRangeDays = Math.max(1, Math.round(rangeDays));
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - safeRangeDays + 1);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const end = new Date(Math.max(start.getTime(), Math.min(now.getTime(), tomorrow.getTime())));
  const bounds = { start, end };
  const includedDayKeys = includedHistoryDayKeys(start, end, skipsWeekends);
  const dayCount = Math.max(1, includedDayKeys.size);
  const breakdown = emptyBreakdown();

  for (const segment of stateSegments) {
    const seconds = includedOverlapSeconds(segment.start, segment.end, bounds, includedDayKeys);
    if (seconds <= 0) continue;
    const next = addBreakdown(breakdown, segment.state, seconds);
    breakdown.focusSeconds = next.focusSeconds;
    breakdown.distractedSeconds = next.distractedSeconds;
    breakdown.breakSeconds = next.breakSeconds;
    breakdown.awaySeconds = next.awaySeconds;
  }

  const appSummaries = new Map<string, ActivityHistorySnapshot["topApps"][number]>();
  let appActiveSeconds = 0;
  for (const segment of appUsage) {
    if (isHiddenAppSegment(segment)) continue;
    const seconds = includedOverlapSeconds(segment.start, segment.end, bounds, includedDayKeys);
    if (seconds <= 0) continue;
    appActiveSeconds += seconds;
    const key = `${segment.bundleID ?? ""}::${segment.appName}::${segment.category}`;
    const current = appSummaries.get(key) ?? {
      appName: segment.appName,
      bundleID: segment.bundleID,
      category: segment.category,
      seconds: 0,
      averageSeconds: 0,
    };
    current.seconds += seconds;
    current.averageSeconds = Math.round(current.seconds / dayCount);
    appSummaries.set(key, current);
  }

  let estimatedTypedCharacters = 0;
  let pointerActionCount = 0;
  let contextSwitchCount = 0;
  let inputActiveSeconds = 0;
  for (const bucket of inputActivity) {
    const bucketSeconds = secondsBetween(bucket.start, bucket.end);
    const seconds = includedOverlapSeconds(bucket.start, bucket.end, bounds, includedDayKeys);
    if (seconds <= 0 || bucketSeconds <= 0) continue;
    const ratio = Math.min(1, seconds / bucketSeconds);
    estimatedTypedCharacters += bucket.keyboardCount * ratio;
    pointerActionCount += bucket.pointerCount * ratio;
    contextSwitchCount += bucket.switchCount * ratio;
    if (bucket.keyboardCount + bucket.pointerCount + bucket.switchCount > 0) {
      inputActiveSeconds += seconds;
    }
  }

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    rangeDays: safeRangeDays,
    skipsWeekends,
    dayCount,
    focusSeconds: breakdown.focusSeconds,
    distractedSeconds: breakdown.distractedSeconds,
    breakSeconds: breakdown.breakSeconds,
    awaySeconds: breakdown.awaySeconds,
    averageFocusSeconds: Math.round(breakdown.focusSeconds / dayCount),
    averageDistractedSeconds: Math.round(breakdown.distractedSeconds / dayCount),
    averageBreakSeconds: Math.round(breakdown.breakSeconds / dayCount),
    averageAwaySeconds: Math.round(breakdown.awaySeconds / dayCount),
    appActiveSeconds,
    averageAppActiveSeconds: Math.round(appActiveSeconds / dayCount),
    estimatedTypedCharacters: Math.round(estimatedTypedCharacters),
    pointerActionCount: Math.round(pointerActionCount),
    contextSwitchCount: Math.round(contextSwitchCount),
    inputActiveSeconds,
    averageInputActiveSeconds: Math.round(inputActiveSeconds / dayCount),
    topApps: [...appSummaries.values()].sort((lhs, rhs) => rhs.seconds - lhs.seconds).slice(0, 6),
  };
};
