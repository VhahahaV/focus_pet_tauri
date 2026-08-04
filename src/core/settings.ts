import type {
  AppSettings,
  AppearanceSettings,
  CodexDisplaySettings,
  DesktopWidgetSettings,
  JudgmentSettings,
  PetSettings,
  ReminderSettings,
  SystemMonitorModule,
  SystemMonitorSettings,
} from "./types";
import { clamp } from "./utils";
import { defaultAppTheme, normalizeAppTheme } from "./theme";

export type JudgmentSensitivityPreset = "relaxed" | "balanced" | "strict" | "custom";

export const defaultAppearanceSettings = (): AppearanceSettings => ({ theme: defaultAppTheme });

export const normalizeAppearanceSettings = (settings: Partial<AppearanceSettings> = {}): AppearanceSettings => ({
  theme: normalizeAppTheme(settings.theme),
});

export const defaultCodexDisplaySettings = (): CodexDisplaySettings => ({
  showInToday: false,
});

export const normalizeCodexDisplaySettings = (
  settings: Partial<CodexDisplaySettings> = {},
): CodexDisplaySettings => ({
  showInToday: settings.showInToday ?? false,
});

export const defaultReminderSettings = (): ReminderSettings => ({
  enablePetBubbles: true,
  enableSystemNotifications: false,
  hasAppliedSystemNotificationDefault: true,
  hasAppliedGentleReminderTuning: true,
  pauseUntil: undefined,
  pauseMinutes: 30,
  enableDistractedNudges: true,
  enableWelcomeBackNudges: false,
  lightDistractedMinutes: 5,
  strongDistractedMinutes: 12,
  cooldownMinutes: 10,
});

export const normalizeReminderSettings = (settings: Partial<ReminderSettings> = {}): ReminderSettings => {
  const base = { ...defaultReminderSettings(), ...settings };
  const lightDistractedMinutes = clamp(base.lightDistractedMinutes, 1, 60);
  const strongDistractedMinutes = clamp(base.strongDistractedMinutes, lightDistractedMinutes, 120);
  return {
    ...base,
    pauseMinutes: clamp(base.pauseMinutes, 5, 240),
    lightDistractedMinutes,
    strongDistractedMinutes,
    cooldownMinutes: clamp(base.cooldownMinutes, 1, 60),
  };
};

const systemMonitorModules: SystemMonitorModule[] = ["cpu", "cores", "memory", "disk", "gpu", "thermal"];

export const defaultSystemMonitorSettings = (): SystemMonitorSettings => ({
  refreshSeconds: 2,
  modules: ["cpu", "memory", "disk", "gpu"],
});

export const normalizeSystemMonitorSettings = (
  settings: Partial<SystemMonitorSettings> = {},
): SystemMonitorSettings => {
  const requested = settings.modules ?? defaultSystemMonitorSettings().modules;
  const modules = [...new Set(requested)].filter((module): module is SystemMonitorModule =>
    systemMonitorModules.includes(module as SystemMonitorModule),
  );
  return {
    refreshSeconds: [1, 2, 5, 10].reduce((best, current) =>
      Math.abs(current - (settings.refreshSeconds ?? 2)) < Math.abs(best - (settings.refreshSeconds ?? 2)) ? current : best,
    ),
    modules: modules.length > 0 ? modules : defaultSystemMonitorSettings().modules,
  };
};

export const defaultJudgmentSettings = (): JudgmentSettings => ({
  inputIdleDistractedSeconds: 180,
  entertainmentDistractedSeconds: 60,
  focusRecoverySeconds: 10,
  idleAwaySeconds: 600,
});

export const judgmentPresetSettings = (preset: Exclude<JudgmentSensitivityPreset, "custom">): JudgmentSettings => {
  switch (preset) {
    case "relaxed":
      return defaultJudgmentSettings();
    case "balanced":
      return {
        inputIdleDistractedSeconds: 90,
        entertainmentDistractedSeconds: 30,
        focusRecoverySeconds: 5,
        idleAwaySeconds: 300,
      };
    case "strict":
      return {
        inputIdleDistractedSeconds: 60,
        entertainmentDistractedSeconds: 20,
        focusRecoverySeconds: 3,
        idleAwaySeconds: 240,
      };
  }
};

export const matchingJudgmentPreset = (settings: JudgmentSettings): JudgmentSensitivityPreset => {
  const normalized = normalizeJudgmentSettings(settings);
  for (const preset of ["relaxed", "balanced", "strict"] as const) {
    const presetSettings = judgmentPresetSettings(preset);
    if (
      normalized.inputIdleDistractedSeconds === presetSettings.inputIdleDistractedSeconds &&
      normalized.entertainmentDistractedSeconds === presetSettings.entertainmentDistractedSeconds &&
      normalized.focusRecoverySeconds === presetSettings.focusRecoverySeconds &&
      normalized.idleAwaySeconds === presetSettings.idleAwaySeconds
    ) {
      return preset;
    }
  }
  return "custom";
};

export const normalizeJudgmentSettings = (settings: Partial<JudgmentSettings> = {}): JudgmentSettings => {
  const base = { ...defaultJudgmentSettings(), ...settings };
  const inputIdleDistractedSeconds = clamp(base.inputIdleDistractedSeconds, 30, 900);
  return {
    inputIdleDistractedSeconds,
    entertainmentDistractedSeconds: clamp(base.entertainmentDistractedSeconds, 15, 900),
    focusRecoverySeconds: clamp(base.focusRecoverySeconds, 1, 120),
    idleAwaySeconds: clamp(base.idleAwaySeconds, Math.max(inputIdleDistractedSeconds, 180), 3600),
  };
};

export const defaultPetSettings = (): PetSettings => ({
  opacity: 0.94,
  size: 150,
  animationEnabled: true,
  audioEnabled: true,
  hidden: false,
  selectedPackID: "",
  placement: "bottomRight",
  customOriginX: undefined,
  customOriginY: undefined,
  hoverStatusEnabled: true,
  randomActionSwitchEnabled: true,
  randomActionSwitchSeconds: 90,
  idleSourceActionIDByPack: {},
  intentSourceActionIDByPack: {},
  hiddenPackIDs: [],
});

export const normalizeRandomActionSwitchSeconds = (seconds: number): number => clamp(seconds, 15, 600);

export const normalizePetSettings = (settings: Partial<PetSettings> = {}): PetSettings => {
  const base = { ...defaultPetSettings(), ...settings };
  const intentSourceActionIDByPack = { ...base.intentSourceActionIDByPack };
  for (const [packID, sourceActionID] of Object.entries(base.idleSourceActionIDByPack ?? {})) {
    intentSourceActionIDByPack[packID] = {
      ...(intentSourceActionIDByPack[packID] ?? {}),
      quietCompanion: intentSourceActionIDByPack[packID]?.quietCompanion ?? sourceActionID,
    };
  }
  return {
    ...base,
    animationEnabled: true,
    opacity: clamp(base.opacity, 0.35, 1),
    size: clamp(base.size, 64, 220),
    randomActionSwitchSeconds: normalizeRandomActionSwitchSeconds(base.randomActionSwitchSeconds),
    idleSourceActionIDByPack: base.idleSourceActionIDByPack ?? {},
    intentSourceActionIDByPack,
    hiddenPackIDs: [...new Set(base.hiddenPackIDs ?? [])],
  };
};

export const defaultDesktopWidgetSettings = (): DesktopWidgetSettings => ({
  currentStatusVisible: false,
  recentRhythmVisible: false,
  currentStatusOrigin: undefined,
  recentRhythmOrigin: undefined,
  recentRhythmWindowHours: 4,
  movementMode: "free",
});

export const normalizeRecentRhythmWindowHours = (hours: number): number => {
  const supported = [4, 8, 12];
  return supported.reduce((best, current) =>
    Math.abs(current - hours) < Math.abs(best - hours) ? current : best,
  );
};

export const normalizeDesktopWidgetSettings = (
  settings: Partial<DesktopWidgetSettings> = {},
): DesktopWidgetSettings => {
  const base = { ...defaultDesktopWidgetSettings(), ...settings };
  return {
    ...base,
    recentRhythmWindowHours: normalizeRecentRhythmWindowHours(base.recentRhythmWindowHours),
    movementMode: base.movementMode === "fixed" ? "fixed" : "free",
  };
};

export const defaultAppSettings = (): AppSettings => {
  const desktopWidget = defaultDesktopWidgetSettings();
  return {
    hasCompletedOnboarding: false,
    appearance: defaultAppearanceSettings(),
    codex: defaultCodexDisplaySettings(),
    reminder: defaultReminderSettings(),
    judgment: defaultJudgmentSettings(),
    pet: defaultPetSettings(),
    desktopWidget,
    systemMonitor: defaultSystemMonitorSettings(),
    desktopWidgetVisible: desktopWidget.currentStatusVisible || desktopWidget.recentRhythmVisible,
    focusTargetMinutes: 25,
  };
};

export const normalizeAppSettings = (settings: Partial<AppSettings> = {}): AppSettings => {
  // Older snapshots persisted a configurable retention object. Ignore it on
  // read so history is now kept indefinitely and the legacy field disappears
  // from the next saved snapshot.
  const settingsWithoutLegacyRetention = { ...settings } as Partial<AppSettings> & { retention?: unknown };
  delete settingsWithoutLegacyRetention.retention;
  const desktopWidget = normalizeDesktopWidgetSettings(settingsWithoutLegacyRetention.desktopWidget);
  const legacyDesktopWidgetVisible = settingsWithoutLegacyRetention.desktopWidgetVisible;
  if (legacyDesktopWidgetVisible !== undefined && settingsWithoutLegacyRetention.desktopWidget === undefined) {
    desktopWidget.currentStatusVisible = legacyDesktopWidgetVisible;
    desktopWidget.recentRhythmVisible = legacyDesktopWidgetVisible;
  }
  return {
    ...defaultAppSettings(),
    ...settingsWithoutLegacyRetention,
    appearance: normalizeAppearanceSettings(settingsWithoutLegacyRetention.appearance),
    codex: normalizeCodexDisplaySettings(settingsWithoutLegacyRetention.codex),
    reminder: normalizeReminderSettings(settingsWithoutLegacyRetention.reminder),
    judgment: normalizeJudgmentSettings(settingsWithoutLegacyRetention.judgment),
    pet: normalizePetSettings(settingsWithoutLegacyRetention.pet),
    desktopWidget,
    systemMonitor: normalizeSystemMonitorSettings(settingsWithoutLegacyRetention.systemMonitor),
    desktopWidgetVisible: desktopWidget.currentStatusVisible || desktopWidget.recentRhythmVisible,
    focusTargetMinutes: Math.max(1, settingsWithoutLegacyRetention.focusTargetMinutes ?? 25),
  };
};

export const nudgeThresholdsFromReminder = (settings: ReminderSettings) => ({
  lightDistractedSeconds: settings.lightDistractedMinutes * 60,
  strongDistractedSeconds: settings.strongDistractedMinutes * 60,
  welcomeBackAwaySeconds: 30 * 60,
  cooldownSeconds: settings.cooldownMinutes * 60,
});

export const stateEngineThresholdsFromJudgment = (settings: JudgmentSettings) => ({
  uiStabilitySeconds: settings.focusRecoverySeconds,
  idleDistractedSeconds: settings.inputIdleDistractedSeconds,
  idleAwaySeconds: settings.idleAwaySeconds,
  distractedSeconds: settings.entertainmentDistractedSeconds,
});
