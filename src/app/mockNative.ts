import type { NativeActivitySample, PermissionSnapshot } from "../core/types";

const workApps = [
  { appName: "Codex", bundleID: "com.openai.codex", windowTitle: "Focus Pet migration · Codex" },
  { appName: "Cursor", bundleID: "com.todesktop.230313mzl4w4u92", windowTitle: "focus_pet_tauri/src" },
  { appName: "Terminal", bundleID: "com.apple.Terminal", windowTitle: "npm run dev" },
  { appName: "Figma", bundleID: "com.figma.Desktop", windowTitle: "Focus Pet dashboard polish" },
];

const distractionApps = [
  { appName: "Safari", bundleID: "com.apple.Safari", windowTitle: "YouTube - 推荐" },
  { appName: "Steam", bundleID: "com.valvesoftware.steam", windowTitle: "Library" },
  { appName: "Arc", bundleID: "company.thebrowser.Browser", windowTitle: "Bilibili - 首页" },
];

export const makeMockActivitySample = (now = new Date()): NativeActivitySample => {
  const minute = Math.floor(now.getTime() / 60_000);
  const cycle = minute % 15;
  const source = cycle < 10 ? workApps[minute % workApps.length] : distractionApps[minute % distractionApps.length];
  const idleSeconds = cycle === 14 ? 220 : cycle === 13 ? 80 : (now.getSeconds() % 12) * 2;
  return {
    timestamp: now.toISOString(),
    ...source,
    idleSeconds,
    inputMonitoringStatus: "browser-preview",
    keyboardCount: cycle < 10 ? 12 + (now.getSeconds() % 10) : 1,
    pointerCount: 3 + (now.getSeconds() % 5),
    switchCount: cycle === 10 || cycle === 11 ? 2 : cycle % 4 === 0 ? 1 : 0,
    isSystemSleeping: false,
    isScreenLocked: false,
  };
};

export const mockPermissionSnapshot = (): PermissionSnapshot => ({
  refreshedAt: new Date().toISOString(),
  inputMonitoring: "browser-preview",
  notifications: typeof Notification === "undefined" ? "browser-preview" : Notification.permission,
});
