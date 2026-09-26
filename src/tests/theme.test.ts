import { describe, expect, it } from "vitest";
import { defaultAppearanceSettings, normalizeAppearanceSettings } from "../core/settings";
import { appThemeIDs, defaultAppTheme, normalizeAppTheme } from "../core/theme";
import { appThemes } from "../themes";

describe("appearance theme registry", () => {
  it("keeps registry metadata and persisted IDs in sync", () => {
    expect(appThemes.map((theme) => theme.id)).toEqual(appThemeIDs);
    expect(new Set(appThemeIDs).size).toBe(appThemeIDs.length);
  });

  it("migrates missing or unknown theme values to the product default", () => {
    expect(defaultAppearanceSettings()).toEqual({ theme: defaultAppTheme });
    expect(normalizeAppearanceSettings()).toEqual({ theme: defaultAppTheme });
    expect(normalizeAppTheme("unknown-theme")).toBe(defaultAppTheme);
    expect(normalizeAppTheme("terminal-hacker")).toBe("hand-drawn");
    expect(normalizeAppTheme("constructivism")).toBe("hand-drawn");
    expect(normalizeAppTheme("hand-drawn")).toBe("hand-drawn");
  });
});
