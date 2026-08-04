import type { LocalStoreSnapshot } from "../core/types";
import { defaultAppSettings, normalizeAppSettings } from "../core/settings";
import { nativeLoadSnapshot, nativeSaveSnapshot } from "./native";

const browserStorageKey = "focus-pet-tauri-snapshot";
export const maximumPointerActionsPerMinute = 600;

export const normalizeInputActivityBucket = <T extends { start: string; end: string; pointerCount: number }>(bucket: T): T => {
  const start = new Date(bucket.start).getTime();
  const end = new Date(bucket.end).getTime();
  const durationMinutes = Number.isFinite(start) && Number.isFinite(end) && end > start
    ? Math.max(1, Math.ceil((end - start) / 60_000))
    : 1;
  const maximum = maximumPointerActionsPerMinute * durationMinutes;
  const rawPointerCount = Math.max(0, Math.round(bucket.pointerCount) || 0);
  // A bucket at or above the ceiling came from the old WM_MOUSEMOVE hook,
  // not a plausible count of deliberate mouse actions. Discard it instead of
  // preserving a misleading capped number in the user's timeline.
  const pointerCount = rawPointerCount >= maximum ? 0 : rawPointerCount;
  return pointerCount === bucket.pointerCount ? bucket : { ...bucket, pointerCount };
};

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
  // Older Windows builds counted every WM_MOUSEMOVE, creating unusable
  // five-figure "mouse action" values. Normalize those historical buckets as
  // the snapshot is loaded; current builds count only presses and wheel gestures.
  inputActivity: (snapshot.inputActivity ?? []).map(normalizeInputActivityBucket),
  focusSessions: snapshot.focusSessions ?? [],
  breakSessions: snapshot.breakSessions ?? [],
  nudges: snapshot.nudges ?? [],
});

export const loadSnapshot = async (): Promise<LocalStoreSnapshot> => {
  const native = await nativeLoadSnapshot().catch(() => undefined);
  if (native) return normalizeSnapshot(native);
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(browserStorageKey);
  } catch {
    return emptySnapshot();
  }
  if (!stored) return emptySnapshot();
  try {
    return normalizeSnapshot(JSON.parse(stored) as LocalStoreSnapshot);
  } catch {
    return emptySnapshot();
  }
};

export const saveSnapshot = async (snapshot: LocalStoreSnapshot): Promise<boolean> => {
  const normalized = normalizeSnapshot(snapshot);
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
