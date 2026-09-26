import type { AppThemeID } from "./types";

export const appThemeIDs: readonly AppThemeID[] = [
  "neobrutalism",
  "mid-century-modern",
  "hand-drawn",
] as const;

export const defaultAppTheme: AppThemeID = "neobrutalism";

export const normalizeAppTheme = (value: unknown): AppThemeID => {
  // Retired themes migrate to their replacement without resetting user preferences.
  if (value === "terminal-hacker" || value === "constructivism") return "hand-drawn";
  return appThemeIDs.includes(value as AppThemeID) ? (value as AppThemeID) : defaultAppTheme;
};
