import type {
  AppSettings,
  DataRetentionSettings,
  DesktopWidgetSettings,
  JudgmentSettings,
  LoggingSettings,
  PetSettings,
  ReminderSettings,
  WindowTitlePrivacy,
} from "./types";
import { clamp } from "./utils";

export type JudgmentSensitivityPreset = "relaxed" | "balanced" | "strict" | "custom";

export const defaultPrivacy = (): WindowTitlePrivacy => ({
  storeRawTitle: false,
  storeOnlyCategoryResult: false,
  pauseActivityRecording: false,
});

export const normalizePrivacy = (privacy: Partial<WindowTitlePrivacy> = {}): WindowTitlePrivacy => {
  const storeOnlyCategoryResult = privacy.storeOnlyCategoryResult ?? false;
  return {
    storeRawTitle: storeOnlyCategoryResult ? false : (privacy.storeRawTitle ?? false),
    storeOnlyCategoryResult,
    pauseActivityRecording: privacy.pauseActivityRecording ?? false,
  };
};

export const defaultReminderSettings = (): ReminderSettings => ({
  enablePetBubbles: true,
  enableSystemNotifications: false,
  hasAppliedSystemNotificationDefault: true,
  hasAppliedGentleReminderTuning: true,
  pauseUntil: undefined,
  pauseMinutes: 30,
  enableDistractedNudges: true,
  enableFocusRestNudges: true,
  enableWelcomeBackNudges: false,
  lightDistractedMinutes: 5,
  strongDistractedMinutes: 12,
  longFocusMinutes: 45,
  veryLongFocusMinutes: 90,
  cooldownMinutes: 10,
});

export const normalizeReminderSettings = (settings: Partial<ReminderSettings> = {}): ReminderSettings => {
  const base = { ...defaultReminderSettings(), ...settings };
  const lightDistractedMinutes = clamp(base.lightDistractedMinutes, 1, 60);
  const strongDistractedMinutes = clamp(base.strongDistractedMinutes, lightDistractedMinutes, 120);
  const longFocusMinutes = clamp(base.longFocusMinutes, 5, 180);
  const veryLongFocusMinutes = clamp(base.veryLongFocusMinutes, longFocusMinutes, 240);
  return {
    ...base,
    pauseMinutes: clamp(base.pauseMinutes, 5, 240),
    lightDistractedMinutes,
    strongDistractedMinutes,
    longFocusMinutes,
    veryLongFocusMinutes,
    cooldownMinutes: clamp(base.cooldownMinutes, 1, 60),
  };
};

export const defaultRetentionSettings = (): DataRetentionSettings => ({
  stateRetentionDays: 30,
  appUsageRetentionDays: 30,
  inputActivityRetentionDays: 30,
  sessionRetentionDays: 90,
  nudgeRetentionDays: 30,
});

export const normalizeRetentionSettings = (settings: Partial<DataRetentionSettings> = {}): DataRetentionSettings => {
  const base = { ...defaultRetentionSettings(), ...settings };
  return {
    stateRetentionDays: Math.max(1, base.stateRetentionDays),
    appUsageRetentionDays: Math.max(1, base.appUsageRetentionDays),
    inputActivityRetentionDays: Math.max(1, base.inputActivityRetentionDays),
    sessionRetentionDays: Math.max(1, base.sessionRetentionDays),
    nudgeRetentionDays: Math.max(1, base.nudgeRetentionDays),
  };
};

export const defaultLoggingSettings = (): LoggingSettings => ({ isEnabled: true });

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
    privacy: defaultPrivacy(),
    reminder: defaultReminderSettings(),
    retention: defaultRetentionSettings(),
    logging: defaultLoggingSettings(),
    judgment: defaultJudgmentSettings(),
    pet: defaultPetSettings(),
    desktopWidget,
    desktopWidgetVisible: desktopWidget.currentStatusVisible || desktopWidget.recentRhythmVisible,
    focusTargetMinutes: 25,
    breakMinutes: 5,
    autoStartBreak: true,
  };
};

export const normalizeAppSettings = (settings: Partial<AppSettings> = {}): AppSettings => {
  const desktopWidget = normalizeDesktopWidgetSettings(settings.desktopWidget);
  if (settings.desktopWidgetVisible !== undefined && settings.desktopWidget === undefined) {
    desktopWidget.currentStatusVisible = settings.desktopWidgetVisible;
    desktopWidget.recentRhythmVisible = settings.desktopWidgetVisible;
  }
  return {
    ...defaultAppSettings(),
    ...settings,
    privacy: normalizePrivacy(settings.privacy),
    reminder: normalizeReminderSettings(settings.reminder),
    retention: normalizeRetentionSettings(settings.retention),
    logging: { ...defaultLoggingSettings(), ...settings.logging },
    judgment: normalizeJudgmentSettings(settings.judgment),
    pet: normalizePetSettings(settings.pet),
    desktopWidget,
    desktopWidgetVisible: desktopWidget.currentStatusVisible || desktopWidget.recentRhythmVisible,
    focusTargetMinutes: Math.max(1, settings.focusTargetMinutes ?? 25),
    breakMinutes: Math.max(1, settings.breakMinutes ?? 5),
    autoStartBreak: settings.autoStartBreak ?? true,
  };
};

export const nudgeThresholdsFromReminder = (settings: ReminderSettings) => ({
  lightDistractedSeconds: settings.lightDistractedMinutes * 60,
  strongDistractedSeconds: settings.strongDistractedMinutes * 60,
  longFocusSeconds: settings.longFocusMinutes * 60,
  veryLongFocusSeconds: settings.veryLongFocusMinutes * 60,
  welcomeBackAwaySeconds: 30 * 60,
  cooldownSeconds: settings.cooldownMinutes * 60,
});

export const stateEngineThresholdsFromJudgment = (settings: JudgmentSettings) => ({
  uiStabilitySeconds: settings.focusRecoverySeconds,
  idleDistractedSeconds: settings.inputIdleDistractedSeconds,
  idleAwaySeconds: settings.idleAwaySeconds,
  distractedSeconds: settings.entertainmentDistractedSeconds,
});
