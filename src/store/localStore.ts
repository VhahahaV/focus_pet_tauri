import type { LocalStoreSnapshot } from "../core/types";
import { defaultAppSettings, normalizeAppSettings } from "../core/settings";
import { nativeLoadSnapshot, nativeSaveSnapshot } from "./native";

const browserStorageKey = "focus-pet-tauri-snapshot";
export const normalizeInputActivityBucket = <T extends { start: string; end: string; pointerCount: number }>(bucket: T): T => {
  const pointerCount = Number.isFinite(bucket.pointerCount) ? Math.max(0, Math.round(bucket.pointerCount)) : 0;
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
