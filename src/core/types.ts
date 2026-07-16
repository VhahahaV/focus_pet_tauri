export type FocusState = "focus" | "distracted" | "break" | "away";

export type ActivityCategory = "work" | "entertainment" | "ignore" | "neutral";

export type ActivitySignalSource =
  | "frontmostApplication"
  | "windowTitle"
  | "idleTime"
  | "appSwitching"
  | "focusSession"
  | "breakSession"
  | "systemSleep"
  | "screenLock";

export type StateReason =
  | "systemSleep"
  | "screenLocked"
  | "longInputIdleAway"
  | "inputIdleDistracted"
  | "activeBreak"
  | "activeFocusSession"
  | "workCategory"
  | "entertainmentStable"
  | "entertainmentGrace"
  | "frequentSwitching"
  | "ignoredActivity"
  | "previousStateHeld"
  | "neutralDefault"
  | "recentInputRecovery";

export type RuleMatchKind = "appName" | "bundleID" | "windowTitle";

export interface ClassificationRule {
  id: string;
  matchKind: RuleMatchKind;
  pattern: string;
  category: ActivityCategory;
  priority: number;
}

export interface ClassificationCatalogEntry {
  id: string;
  matchKind: RuleMatchKind;
  patterns: string[];
  category: ActivityCategory;
  priority: number;
  aliases?: string[];
  regions?: string[];
  notes?: string;
}

export interface SanitizedWindowTitle {
  rawTitle?: string;
  titleDisplay?: string;
  titleStored: boolean;
  titleHash?: string;
}

export interface WindowTitlePrivacy {
  storeRawTitle: boolean;
  storeOnlyCategoryResult: boolean;
  pauseActivityRecording: boolean;
}

export interface ActivitySnapshot {
  timestamp: string;
  appName: string;
  bundleID?: string;
  windowTitle?: string;
  titleHash?: string;
  titleStored: boolean;
  titleDisplay?: string;
  category: ActivityCategory;
  idleSeconds: number;
  switchCountLast5Min: number;
  switchCountLast15Min: number;
  activeCategoryDuration: number;
  activeAppDuration: number;
  isFocusSessionActive: boolean;
  isBreakActive: boolean;
  isSystemSleeping: boolean;
  isScreenLocked: boolean;
  source: ActivitySignalSource[];
}

export interface StateEngineThresholds {
  uiStabilitySeconds: number;
  idleDistractedSeconds: number;
  idleAwaySeconds: number;
  distractedSeconds: number;
}

export interface StateDecision {
  timestamp: string;
  state: FocusState;
  category: ActivityCategory;
  confidence: number;
  reason: StateReason[];
  stableDuration: number;
}

export interface FocusStateSnapshot {
  id: string;
  timestamp: string;
  state: FocusState;
  category: ActivityCategory;
  stableDuration: number;
  appName: string;
  bundleID?: string;
  reason: StateReason[];
}

export type FocusSessionStatus = "active" | "completed" | "cancelled";

export interface FocusSession {
  id: string;
  taskName: string;
  start: string;
  targetDurationSeconds: number;
  end?: string;
  effectiveFocusSeconds: number;
  distractedSeconds: number;
  awaySeconds: number;
  switchCount: number;
  interruptionCount: number;
  mainAppName?: string;
  completed: boolean;
  status: FocusSessionStatus;
  autoStartBreak: boolean;
  breakDurationSeconds: number;
}

export type BreakSource = "manual" | "afterFocusSession" | "longFocusSuggestion";

export interface BreakSession {
  id: string;
  start: string;
  targetDurationSeconds: number;
  end?: string;
  source: BreakSource;
  completed: boolean;
}

export type PetAction =
  | "idle"
  | "blink"
  | "breath"
  | "sleep"
  | "wake"
  | "focusStart"
  | "focusStable"
  | "stretch"
  | "distractedLook"
  | "nudgeGentle"
  | "nudgeStrong"
  | "breakRelax"
  | "breakEnd"
  | "welcomeBack"
  | "dragged"
  | "landing"
  | "run"
  | "screenTransfer"
  | "mouseSummon";

export type PetIntentSource = "state" | "nudge" | "interaction" | "physicalInteraction";

export type PetIntentKind =
  | "quietCompanion"
  | "focusRestHint"
  | "distractedObserve"
  | "nudgeGentle"
  | "nudgeStrong"
  | "breakCompanion"
  | "breakEnding"
  | "sleep"
  | "welcomeBack"
  | "moveLeft"
  | "moveRight"
  | "moveUp"
  | "moveDown"
  | "dragged"
  | "landing"
  | "mouseSummon"
  | "dashboardGuide";

export interface PetIntent {
  id: string;
  kind: PetIntentKind;
  source: PetIntentSource;
  priority: number;
  startedAt: string;
  expiresAt?: string;
  message?: string;
  interruptible: boolean;
}

export type NudgeReason =
  | "distractedOverThreshold"
  | "distractedStrong"
  | "longFocusRest"
  | "veryLongFocusRest"
  | "focusSessionCompleted"
  | "breakEnding"
  | "welcomeBack"
  | "frequentSwitching";

export interface NudgeEvent {
  id: string;
  time: string;
  reason: NudgeReason;
  state: FocusState;
  appName: string;
  category: ActivityCategory;
  petIntent: PetIntentKind;
  channel: string;
  cooldownSeconds: number;
  message: string;
}

export interface NudgePolicyThresholds {
  lightDistractedSeconds: number;
  strongDistractedSeconds: number;
  longFocusSeconds: number;
  veryLongFocusSeconds: number;
  welcomeBackAwaySeconds: number;
  cooldownSeconds: number;
}

export type PetPlacementMode = "bottomRight" | "bottomLeft" | "topRight" | "topLeft" | "dock" | "custom";

export interface ReminderSettings {
  enablePetBubbles: boolean;
  enableSystemNotifications: boolean;
  hasAppliedSystemNotificationDefault: boolean;
  hasAppliedGentleReminderTuning: boolean;
  pauseUntil?: string;
  pauseMinutes: number;
  enableDistractedNudges: boolean;
  enableFocusRestNudges: boolean;
  enableWelcomeBackNudges: boolean;
  lightDistractedMinutes: number;
  strongDistractedMinutes: number;
  longFocusMinutes: number;
  veryLongFocusMinutes: number;
  cooldownMinutes: number;
}

export interface DataRetentionSettings {
  stateRetentionDays: number;
  appUsageRetentionDays: number;
  inputActivityRetentionDays: number;
  sessionRetentionDays: number;
  nudgeRetentionDays: number;
}

export interface LoggingSettings {
  isEnabled: boolean;
}

export interface JudgmentSettings {
  inputIdleDistractedSeconds: number;
  entertainmentDistractedSeconds: number;
  focusRecoverySeconds: number;
  idleAwaySeconds: number;
}

export interface PetSettings {
  opacity: number;
  size: number;
  animationEnabled: boolean;
  audioEnabled: boolean;
  hidden: boolean;
  selectedPackID: string;
  placement: PetPlacementMode;
  customOriginX?: number;
  customOriginY?: number;
  hoverStatusEnabled: boolean;
  randomActionSwitchEnabled: boolean;
  randomActionSwitchSeconds: number;
  idleSourceActionIDByPack: Record<string, string>;
  intentSourceActionIDByPack: Record<string, Record<string, string>>;
  hiddenPackIDs: string[];
}

export interface DesktopWidgetPosition {
  x: number;
  y: number;
}

export type DesktopWidgetMovementMode = "fixed" | "free";

export interface DesktopWidgetSettings {
  currentStatusVisible: boolean;
  recentRhythmVisible: boolean;
  currentStatusOrigin?: DesktopWidgetPosition;
  recentRhythmOrigin?: DesktopWidgetPosition;
  recentRhythmWindowHours: number;
  movementMode: DesktopWidgetMovementMode;
}

export interface AppSettings {
  hasCompletedOnboarding: boolean;
  privacy: WindowTitlePrivacy;
  reminder: ReminderSettings;
  retention: DataRetentionSettings;
  logging: LoggingSettings;
  judgment: JudgmentSettings;
  pet: PetSettings;
  desktopWidget: DesktopWidgetSettings;
  desktopWidgetVisible: boolean;
  focusTargetMinutes: number;
  breakMinutes: number;
  autoStartBreak: boolean;
}

export interface StateSegment {
  id: string;
  start: string;
  end: string;
  state: FocusState;
  appName: string;
  bundleID?: string;
  category: ActivityCategory;
  titleStored: boolean;
  titleDisplay?: string;
  source: ActivitySignalSource[];
}

export interface AppUsageSegment {
  id: string;
  start: string;
  end: string;
  appName: string;
  bundleID?: string;
  category: ActivityCategory;
}

export interface InputActivityBucket {
  start: string;
  end: string;
  keyboardCount: number;
  pointerCount: number;
  switchCount: number;
}

export interface InputWorkloadSummary {
  start: string;
  end: string;
  estimatedTypedCharacters: number;
  pointerActionCount: number;
  contextSwitchCount: number;
  activeSeconds: number;
}

export interface WorkTimelineBreakdown {
  focusSeconds: number;
  distractedSeconds: number;
  breakSeconds: number;
  awaySeconds: number;
}

export interface DailySummary {
  date: string;
  focusSeconds: number;
  distractedSeconds: number;
  breakSeconds: number;
  awaySeconds: number;
  longestFocusSeconds: number;
  focusSessionCount: number;
  distractedCount: number;
  awayCount: number;
  nudgeCount: number;
  switchCount: number;
  appUsage: AppUsageSummary[];
  categoryUsage: CategoryUsageSummary[];
}

export interface AppUsageSummary {
  appName: string;
  bundleID?: string;
  category: ActivityCategory;
  seconds: number;
  stateBreakdown: Partial<Record<FocusState, number>>;
}

export interface CategoryUsageSummary {
  category: ActivityCategory;
  seconds: number;
  appCount: number;
}

export interface InputTimelineStateRange {
  startProgress: number;
  endProgress: number;
  state: FocusState;
}

export interface InputTimelineInputBar {
  startProgress: number;
  endProgress: number;
  keyboardCount: number;
  pointerCount: number;
  switchCount: number;
}

export interface InputTimelineAppSegment {
  start: string;
  end: string;
  appName: string;
  bundleID?: string;
  category: ActivityCategory;
}

export interface InputTimelineSwitchMarker {
  progress: number;
  count: number;
}

export interface InputTimelineSnapshot {
  start: string;
  end: string;
  stateRanges: InputTimelineStateRange[];
  inputBars: InputTimelineInputBar[];
  appSegments: InputTimelineAppSegment[];
  switchMarkers: InputTimelineSwitchMarker[];
  stateDurations: Partial<Record<FocusState, number>>;
  keyboardCount: number;
  pointerCount: number;
  switchCount: number;
  maxInputCount: number;
  maxKeyboardCount: number;
  maxPointerCount: number;
}

export interface ActivityHistoryAppSummary {
  appName: string;
  bundleID?: string;
  category: ActivityCategory;
  seconds: number;
  averageSeconds: number;
}

export interface ActivityHistorySnapshot {
  start: string;
  end: string;
  rangeDays: number;
  skipsWeekends: boolean;
  dayCount: number;
  focusSeconds: number;
  distractedSeconds: number;
  breakSeconds: number;
  awaySeconds: number;
  averageFocusSeconds: number;
  averageDistractedSeconds: number;
  averageBreakSeconds: number;
  averageAwaySeconds: number;
  appActiveSeconds: number;
  averageAppActiveSeconds: number;
  estimatedTypedCharacters: number;
  pointerActionCount: number;
  contextSwitchCount: number;
  inputActiveSeconds: number;
  averageInputActiveSeconds: number;
  topApps: ActivityHistoryAppSummary[];
}

export interface AttentionDayBucket {
  date: string;
  focusSeconds: number;
  distractedSeconds: number;
  breakSeconds: number;
  awaySeconds: number;
}

export interface AttentionWeekBucket {
  start: string;
  days: AttentionDayBucket[];
}

export interface AttentionMonthCalendar {
  start: string;
  title: string;
  days: Array<AttentionDayBucket | null>;
  focusSeconds: number;
  distractedSeconds: number;
  breakSeconds: number;
  awaySeconds: number;
}

export interface AttentionHistorySnapshot {
  start: string;
  end: string;
  weeks: AttentionWeekBucket[];
  months: AttentionMonthCalendar[];
  focusSeconds: number;
  distractedSeconds: number;
  breakSeconds: number;
  awaySeconds: number;
}

export interface LocalStoreSnapshot {
  settings: AppSettings;
  classificationRules: ClassificationRule[];
  stateSegments: StateSegment[];
  appUsage: AppUsageSegment[];
  inputActivity: InputActivityBucket[];
  focusSessions: FocusSession[];
  breakSessions: BreakSession[];
  nudges: NudgeEvent[];
}

export interface NativeActivitySample {
  timestamp: string;
  platform?: string;
  sampleQuality?: string;
  appName: string;
  bundleID?: string;
  windowTitle?: string;
  idleSeconds: number;
  inputMonitoringStatus: string;
  keyboardCount: number;
  pointerCount: number;
  switchCount: number;
  isSystemSleeping: boolean;
  isScreenLocked: boolean;
}

export interface PermissionSnapshot {
  refreshedAt: string;
  inputMonitoring: string;
  notifications: string;
}

export interface InstallationSnapshot {
  bundlePath: string;
  buildIdentifier: string;
  versionDisplay: string;
  isInstalled: boolean;
  isRunningFromMountedVolume: boolean;
}

export interface RecognitionDiagnosticSnapshot {
  sampledAt: string;
  appName: string;
  bundleID?: string;
  windowTitle?: string;
  category: ActivityCategory;
  catalogEntryCount: number;
  defaultRuleCount: number;
  userRuleCount: number;
  inputMonitoringStatus: string;
  recordingPaused: boolean;
}

export interface AppRuntimeState extends LocalStoreSnapshot {
  currentSnapshot: ActivitySnapshot;
  currentDecision: StateDecision;
  summary: DailySummary;
  todayWorkload: InputWorkloadSummary;
  currentPetIntent: PetIntent;
  latestPetBubble?: string;
  statusMessage: string;
  permissionSnapshot: PermissionSnapshot;
  recognitionDiagnostic: RecognitionDiagnosticSnapshot;
  dataSizeBytes: number;
}

export const focusStates: FocusState[] = ["focus", "distracted", "break", "away"];

export const userFacingCategories: ActivityCategory[] = ["work", "entertainment", "ignore"];
