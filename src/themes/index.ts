import { useLayoutEffect } from "react";
import type { AppThemeID } from "../core/types";
import { normalizeAppTheme } from "../core/theme";
import neobrutalismArtURL from "../assets/themes/neobrutalism.svg?no-inline";
import midCenturyModernArtURL from "../assets/themes/mid-century-modern.svg?no-inline";
import handDrawnArtURL from "../assets/themes/hand-drawn.svg?no-inline";

export { appThemeIDs, defaultAppTheme, normalizeAppTheme } from "../core/theme";

export interface AppThemeDefinition {
  id: AppThemeID;
  name: string;
  englishName: string;
  description: string;
  artURL: string;
  swatches: readonly [string, string, string, string];
}

export const appThemes: readonly AppThemeDefinition[] = [
  {
    id: "neobrutalism",
    name: "新粗野主义",
    englishName: "Neobrutalism",
    description: "饱和色块、粗黑描边与硬偏移阴影",
    artURL: neobrutalismArtURL,
    swatches: ["var(--theme-preview-1)", "var(--theme-preview-2)", "var(--theme-preview-3)", "var(--theme-preview-4)"],
  },
  {
    id: "mid-century-modern",
    name: "中世纪现代",
    englishName: "Mid-Century Modern",
    description: "奶咖底色、胡桃木文字与温暖有机色彩",
    artURL: midCenturyModernArtURL,
    swatches: ["var(--theme-preview-1)", "var(--theme-preview-2)", "var(--theme-preview-3)", "var(--theme-preview-4)"],
  },
  {
    id: "hand-drawn",
    name: "手绘涂鸦",
    englishName: "Hand-drawn / Doodle",
    description: "暖纸底色、手绘墨线与明快的马克笔色块",
    artURL: handDrawnArtURL,
    swatches: ["var(--theme-preview-1)", "var(--theme-preview-2)", "var(--theme-preview-3)", "var(--theme-preview-4)"],
  },
] as const;

export const themeStorageKey = "focus-pet-appearance-theme";

export const applyDocumentTheme = (theme: AppThemeID): void => {
  const normalized = normalizeAppTheme(theme);
  const definition = appThemes.find((candidate) => candidate.id === normalized) ?? appThemes[0];
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = "light";
  document.documentElement.style.setProperty("--theme-art-image", `url("${definition.artURL}")`);
  try {
    localStorage.setItem(themeStorageKey, normalized);
  } catch {
    // Storage may be unavailable in test and restricted webview contexts.
  }
};

export const applyStoredDocumentTheme = (): void => {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(themeStorageKey);
  } catch {
    // Use the product default when storage is unavailable.
  }
  applyDocumentTheme(normalizeAppTheme(stored));
};

export const useDocumentTheme = (theme: AppThemeID): void => {
  useLayoutEffect(() => {
    applyDocumentTheme(theme);
  }, [theme]);
};
