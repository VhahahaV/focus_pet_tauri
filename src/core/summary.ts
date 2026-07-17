import type {
  ActivityCategory,
  AppUsageSegment,
  AppUsageSummary,
  CategoryUsageSummary,
  DailySummary,
  FocusSession,
  FocusState,
  NudgeEvent,
  StateSegment,
} from "./types";
import { appUsageDurationSeconds, stateDurationSeconds } from "./timeline";
import { dayBounds, dateKey, overlapSeconds, overlaps } from "./utils";

const hiddenSystemUsage = (appName: string, bundleID?: string): boolean => {
  const normalizedName = appName.trim().toLowerCase();
  const normalizedBundleID = bundleID?.toLowerCase() ?? "";
  return (
    normalizedName === "sleep" ||
    normalizedName === "loginwindow" ||
    normalizedName === "locked screen" ||
    normalizedName === "away" ||
    normalizedBundleID.includes("loginwindow")
  );
};

const normalizedCategory = (category: ActivityCategory): ActivityCategory => (category === "neutral" ? "ignore" : category);

const clippedStateSegments = (segments: StateSegment[], bounds: { start: Date; end: Date }): StateSegment[] =>
  segments.flatMap((segment) => {
    const start = new Date(Math.max(new Date(segment.start).getTime(), bounds.start.getTime()));
    const end = new Date(Math.min(new Date(segment.end).getTime(), bounds.end.getTime()));
    if (end <= start) return [];
    return [{ ...segment, start: start.toISOString(), end: end.toISOString() }];
  });

const makeAppSummary = (segments: StateSegment[], appUsage: AppUsageSegment[]): AppUsageSummary[] => {
  const result = new Map<string, AppUsageSummary>();
  for (const usage of appUsage) {
    const category = normalizedCategory(usage.category);
    if (hiddenSystemUsage(usage.appName, usage.bundleID)) continue;
    const key = `${usage.bundleID ?? usage.appName}-${category}`;
    const current = result.get(key) ?? {
      appName: usage.appName,
      bundleID: usage.bundleID,
      category,
      seconds: 0,
      stateBreakdown: {},
    };
    current.seconds += appUsageDurationSeconds(usage);
    result.set(key, current);
  }
  for (const segment of segments) {
    const category = normalizedCategory(segment.category);
    if (hiddenSystemUsage(segment.appName, segment.bundleID)) continue;
    const key = `${segment.bundleID ?? segment.appName}-${category}`;
    const current = result.get(key) ?? {
      appName: segment.appName,
      bundleID: segment.bundleID,
      category,
      seconds: 0,
      stateBreakdown: {},
    };
    current.stateBreakdown[segment.state] = (current.stateBreakdown[segment.state] ?? 0) + stateDurationSeconds(segment);
    if (current.seconds === 0) current.seconds += stateDurationSeconds(segment);
    result.set(key, current);
  }
  return [...result.values()].sort((lhs, rhs) => (lhs.seconds === rhs.seconds ? lhs.appName.localeCompare(rhs.appName) : rhs.seconds - lhs.seconds));
};

const makeCategorySummary = (
  segments: StateSegment[],
  appUsageInDay: AppUsageSegment[],
  bounds: { start: Date; end: Date },
): CategoryUsageSummary[] => {
  const secondsByCategory: Partial<Record<ActivityCategory, number>> = {};
  const appsByCategory = new Map<ActivityCategory, Set<string>>();
  if (appUsageInDay.length === 0) {
    for (const segment of segments) {
      const category = normalizedCategory(segment.category);
      secondsByCategory[category] = (secondsByCategory[category] ?? 0) + stateDurationSeconds(segment);
      if (!appsByCategory.has(category)) appsByCategory.set(category, new Set());
      appsByCategory.get(category)?.add(segment.bundleID ?? segment.appName);
    }
  } else {
    for (const usage of appUsageInDay) {
      const category = normalizedCategory(usage.category);
      secondsByCategory[category] = (secondsByCategory[category] ?? 0) + overlapSeconds(usage.start, usage.end, bounds);
      if (!appsByCategory.has(category)) appsByCategory.set(category, new Set());
      appsByCategory.get(category)?.add(usage.bundleID ?? usage.appName);
    }
  }
  return (["work", "entertainment", "ignore"] as ActivityCategory[])
    .map((category) => ({
      category,
      seconds: secondsByCategory[category] ?? 0,
      appCount: appsByCategory.get(category)?.size ?? 0,
    }))
    .sort((lhs, rhs) => (lhs.seconds === rhs.seconds ? lhs.category.localeCompare(rhs.category) : rhs.seconds - lhs.seconds));
};

export const buildDailySummary = (
  date: Date,
  segments: StateSegment[],
  appUsage: AppUsageSegment[],
  focusSessions: FocusSession[],
  nudges: NudgeEvent[],
): DailySummary => {
  const bounds = dayBounds(date);
  const clipped = clippedStateSegments(segments, bounds);
  const durations: Record<FocusState, number> = { focus: 0, distracted: 0, away: 0 };
  for (const segment of clipped) {
    durations[segment.state] += stateDurationSeconds(segment);
  }
  const appUsageInDay = appUsage.filter((usage) => overlaps(usage.start, usage.end, bounds));
  return {
    date: dateKey(date),
    focusSeconds: durations.focus,
    distractedSeconds: durations.distracted,
    awaySeconds: durations.away,
    longestFocusSeconds: Math.max(0, ...clipped.filter((segment) => segment.state === "focus").map(stateDurationSeconds)),
    focusSessionCount: focusSessions.filter((session) => overlaps(session.start, session.end ?? bounds.end, bounds)).length,
    distractedCount: clipped.filter((segment) => segment.state === "distracted").length,
    awayCount: clipped.filter((segment) => segment.state === "away").length,
    nudgeCount: nudges.filter((nudge) => new Date(nudge.time) >= bounds.start && new Date(nudge.time) < bounds.end).length,
    switchCount: appUsageInDay.length,
    appUsage: makeAppSummary(clipped, appUsageInDay),
    categoryUsage: makeCategorySummary(clipped, appUsageInDay, bounds),
  };
};

export const summaryTotalSeconds = (summary: DailySummary): number =>
  summary.focusSeconds + summary.distractedSeconds + summary.awaySeconds;
