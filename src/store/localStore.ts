import type { LocalStoreSnapshot } from "../core/types";
import { defaultAppSettings, normalizeAppSettings } from "../core/settings";
import { nativeDeleteAllData, nativeExportSnapshot, nativeLoadSnapshot, nativeSaveSnapshot } from "./native";

const browserStorageKey = "focus-pet-tauri-snapshot";

export const emptySnapshot = (): LocalStoreSnapshot => ({
  settings: defaultAppSettings(),
  classificationRules: [],
  stateSegments: [],
  appUsage: [],
  inputActivity: [],
  focusSessions: [],
  breakSessions: [],
  nudges: [],
});

export const normalizeSnapshot = (snapshot: Partial<LocalStoreSnapshot> = {}): LocalStoreSnapshot => ({
  settings: normalizeAppSettings(snapshot.settings),
  classificationRules: snapshot.classificationRules ?? [],
  stateSegments: snapshot.stateSegments ?? [],
  appUsage: snapshot.appUsage ?? [],
  inputActivity: snapshot.inputActivity ?? [],
  focusSessions: snapshot.focusSessions ?? [],
  breakSessions: snapshot.breakSessions ?? [],
  nudges: snapshot.nudges ?? [],
});

export interface RetentionResult {
  removedStateSegments: number;
  removedAppUsageSegments: number;
  removedInputActivityBuckets: number;
  removedFocusSessions: number;
  removedBreakSessions: number;
  removedNudges: number;
  totalRemoved: number;
}

const cutoffTime = (now: Date, days: number): number => now.getTime() - Math.max(1, days) * 86_400_000;

export const pruneSnapshotForRetention = (
  snapshot: LocalStoreSnapshot,
  now = new Date(),
): { snapshot: LocalStoreSnapshot; result: RetentionResult } => {
  const normalized = normalizeSnapshot(snapshot);
  const retention = normalized.settings.retention;
  const stateCutoff = cutoffTime(now, retention.stateRetentionDays);
  const appUsageCutoff = cutoffTime(now, retention.appUsageRetentionDays);
  const inputCutoff = cutoffTime(now, retention.inputActivityRetentionDays);
  const sessionCutoff = cutoffTime(now, retention.sessionRetentionDays);
  const nudgeCutoff = cutoffTime(now, retention.nudgeRetentionDays);

  const stateSegments = normalized.stateSegments.filter((segment) => new Date(segment.end).getTime() >= stateCutoff);
  const appUsage = normalized.appUsage.filter((segment) => new Date(segment.end).getTime() >= appUsageCutoff);
  const inputActivity = normalized.inputActivity.filter((bucket) => new Date(bucket.end).getTime() >= inputCutoff);
  const focusSessions = normalized.focusSessions.filter((session) => new Date(session.end ?? session.start).getTime() >= sessionCutoff);
  const breakSessions = normalized.breakSessions.filter((session) => new Date(session.end ?? session.start).getTime() >= sessionCutoff);
  const nudges = normalized.nudges.filter((nudge) => new Date(nudge.time).getTime() >= nudgeCutoff);
  const result = {
    removedStateSegments: normalized.stateSegments.length - stateSegments.length,
    removedAppUsageSegments: normalized.appUsage.length - appUsage.length,
    removedInputActivityBuckets: normalized.inputActivity.length - inputActivity.length,
    removedFocusSessions: normalized.focusSessions.length - focusSessions.length,
    removedBreakSessions: normalized.breakSessions.length - breakSessions.length,
    removedNudges: normalized.nudges.length - nudges.length,
    totalRemoved: 0,
  };
  result.totalRemoved =
    result.removedStateSegments +
    result.removedAppUsageSegments +
    result.removedInputActivityBuckets +
    result.removedFocusSessions +
    result.removedBreakSessions +
    result.removedNudges;

  return {
    snapshot: {
      ...normalized,
      stateSegments,
      appUsage,
      inputActivity,
      focusSessions,
      breakSessions,
      nudges,
    },
    result,
  };
};

export const loadSnapshot = async (): Promise<LocalStoreSnapshot> => {
  const native = await nativeLoadSnapshot().catch(() => undefined);
  if (native) return pruneSnapshotForRetention(normalizeSnapshot(native)).snapshot;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(browserStorageKey);
  } catch {
    return emptySnapshot();
  }
  if (!stored) return emptySnapshot();
  try {
    return pruneSnapshotForRetention(normalizeSnapshot(JSON.parse(stored) as LocalStoreSnapshot)).snapshot;
  } catch {
    return emptySnapshot();
  }
};

export const saveSnapshot = async (snapshot: LocalStoreSnapshot): Promise<boolean> => {
  const normalized = pruneSnapshotForRetention(normalizeSnapshot(snapshot)).snapshot;
  const nativeSaved = await nativeSaveSnapshot(normalized).catch(() => false);
  if (!nativeSaved) {
    try {
      localStorage.setItem(browserStorageKey, JSON.stringify(normalized));
    } catch {
      return true;
    }
  }
  return true;
};

export const exportSnapshot = async (snapshot: LocalStoreSnapshot, redacted: boolean): Promise<string> => {
  const retained = pruneSnapshotForRetention(snapshot).snapshot;
  const nativeURL = await nativeExportSnapshot(retained, redacted).catch(() => undefined);
  if (nativeURL) return nativeURL;
  const blob = new Blob([JSON.stringify(redacted ? redactedSnapshot(retained) : retained, null, 2)], {
    type: "application/json",
  });
  return URL.createObjectURL(blob);
};

export const deleteAllData = async (): Promise<void> => {
  await nativeDeleteAllData().catch(() => false);
  try {
    localStorage.removeItem(browserStorageKey);
  } catch {
    // Storage can be unavailable in file/about test contexts.
  }
};

const redactedAppName = (category: string): string => {
  switch (category) {
    case "work":
      return "工作工具";
    case "entertainment":
      return "容易分心";
    case "ignore":
      return "不参与判断";
    default:
      return "旧数据";
  }
};

export const redactedSnapshot = (snapshot: LocalStoreSnapshot): LocalStoreSnapshot => {
  const copy = normalizeSnapshot(snapshot);
  copy.settings.privacy = {
    ...copy.settings.privacy,
    storeRawTitle: false,
    storeOnlyCategoryResult: true,
  };
  copy.classificationRules = [];
  copy.stateSegments = copy.stateSegments.map((segment) => ({
    ...segment,
    appName: redactedAppName(segment.category),
    bundleID: undefined,
    titleStored: false,
    titleDisplay: undefined,
  }));
  copy.appUsage = copy.appUsage.map((usage) => ({
    ...usage,
    appName: redactedAppName(usage.category),
    bundleID: undefined,
  }));
  copy.focusSessions = copy.focusSessions.map((session) => ({
    ...session,
    taskName: "专注任务",
    mainAppName: undefined,
  }));
  copy.nudges = copy.nudges.map((nudge) => ({
    ...nudge,
    appName: redactedAppName(nudge.category),
  }));
  return copy;
};
