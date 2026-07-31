import type {
  ActivityCategory,
  ActivitySignalSource,
  ActivitySnapshot,
  NativeActivitySample,
  SanitizedWindowTitle,
} from "./types";
import { hashText, redactWindowTitle, safeTrim } from "./utils";

export const sanitizeWindowTitle = (
  title: string | undefined,
): SanitizedWindowTitle => {
  const trimmed = safeTrim(title);
  if (!trimmed) return { rawTitle: undefined, titleDisplay: undefined, titleStored: false, titleHash: undefined };
  return {
    rawTitle: undefined,
    titleDisplay: redactWindowTitle(trimmed),
    titleStored: false,
    titleHash: hashText(trimmed),
  };
};

export interface SnapshotContext {
  category: ActivityCategory;
  activeCategoryDuration: number;
  activeAppDuration: number;
  isFocusSessionActive: boolean;
  switchCountLast5Min: number;
  switchCountLast15Min: number;
}

export const makeActivitySnapshot = (sample: NativeActivitySample, context: SnapshotContext): ActivitySnapshot => {
  const sanitized = sanitizeWindowTitle(sample.windowTitle);
  const source: ActivitySignalSource[] = ["frontmostApplication", "windowTitle", "idleTime", "appSwitching"];
  if (context.isFocusSessionActive) source.push("focusSession");
  if (sample.isSystemSleeping) source.push("systemSleep");
  if (sample.isScreenLocked) source.push("screenLock");
  return {
    timestamp: sample.timestamp,
    appName: safeTrim(sample.appName) ?? "Unknown",
    bundleID: safeTrim(sample.bundleID),
    windowTitle: sanitized.rawTitle,
    titleHash: sanitized.titleHash,
    titleStored: sanitized.titleStored,
    titleDisplay: sanitized.titleDisplay,
    category: context.category,
    idleSeconds: Math.max(0, sample.idleSeconds),
    switchCountLast5Min: Math.max(0, context.switchCountLast5Min),
    switchCountLast15Min: Math.max(0, context.switchCountLast15Min),
    activeCategoryDuration: Math.max(0, context.activeCategoryDuration),
    activeAppDuration: Math.max(0, context.activeAppDuration),
    isFocusSessionActive: context.isFocusSessionActive,
    isSystemSleeping: sample.isSystemSleeping,
    isScreenLocked: sample.isScreenLocked,
    source,
  };
};
