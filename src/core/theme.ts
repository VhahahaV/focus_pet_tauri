import type { AppThemeID } from "./types";

export const appThemeIDs: readonly AppThemeID[] = [
  "neobrutalism",
  "mid-century-modern",
  "constructivism",
] as const;

export const defaultAppTheme: AppThemeID = "neobrutalism";

export const normalizeAppTheme = (value: unknown): AppThemeID => {
  if (value === "terminal-hacker") return "constructivism";
  return appThemeIDs.includes(value as AppThemeID) ? (value as AppThemeID) : defaultAppTheme;
};
