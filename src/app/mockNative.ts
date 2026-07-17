import type { NativeActivitySample, PermissionSnapshot, SystemMetricsSample } from "../core/types";

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

export const makeMockSystemMetrics = (now = new Date()): SystemMetricsSample => {
  const wave = (Math.sin(now.getTime() / 5_000) + 1) / 2;
  const coreUsage = [18, 27, 34, 12, 44, 22, 9, 31, 16, 24].map((base, index) =>
    Math.min(100, base + wave * (index % 3) * 8),
  );
  return {
    sampledAt: now.toISOString(),
    cpuUsage: coreUsage.reduce((total, value) => total + value, 0) / coreUsage.length,
    cpuName: "Browser preview",
    cores: coreUsage.map((usage, index) => ({ name: `Core ${index + 1}`, usage, frequencyMHz: 0 })),
    memoryTotalBytes: 16 * 1024 ** 3,
    memoryUsedBytes: 9.4 * 1024 ** 3,
    memoryUsage: 58.75,
    disks: [{ name: "Preview Disk", mountPoint: "/", totalBytes: 512 * 1024 ** 3, availableBytes: 213 * 1024 ** 3, usage: 58.4 }],
    gpuName: "Browser preview",
    gpuUsage: 23 + wave * 18,
    temperatures: [],
    fans: [],
  };
};
