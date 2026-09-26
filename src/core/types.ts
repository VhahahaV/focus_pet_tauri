export type FocusState = "focus" | "distracted" | "break" | "away";

export type ActivityCategory = "work" | "entertainment" | "ignore" | "neutral";

export type ActivityClassificationSource = "userRule" | "catalogRule" | "fallbackRule" | "unmatched";

export type ActivitySignalSource =
  | "frontmostApplication"
  | "windowTitle"
  | "idleTime"
  | "appSwitching"
  | "focusSession"
  | "systemSleep"
  | "screenLock";

export type StateReason =
  | "systemSleep"
  | "screenLocked"
  | "longInputIdleAway"
  | "inputIdleDistracted"
  | "activeFocusSession"
  | "workCategory"
  | "explicitEntertainmentRule"
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

export interface ActivitySnapshot {
  timestamp: string;
  appName: string;
  bundleID?: string;
  windowTitle?: string;
  titleHash?: string;
  titleStored: boolean;
  titleDisplay?: string;
  category: ActivityCategory;
  classificationSource?: ActivityClassificationSource;
  idleSeconds: number;
  switchCountLast5Min: number;
  switchCountLast15Min: number;
  activeCategoryDuration: number;
  activeAppDuration: number;
  isFocusSessionActive: boolean;
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
  | "breakRelax"
  | "breakEnd"
  | "distractedLook"
  | "nudgeGentle"
  | "nudgeStrong"
  | "welcomeBack"
  | "dragged"
  | "landing"
  | "run"
  | "screenTransfer"
  | "mouseSummon";

export type PetIntentSource = "state" | "nudge" | "interaction" | "physicalInteraction";

export type PetIntentKind =
  | "quietCompanion"
  | "distractedObserve"
  | "breakCompanion"
  | "nudgeGentle"
  | "nudgeStrong"
  | "taskCompleted"
  | "focusRestHint"
  | "sleep"
  | "breakEnding"
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
  enableWelcomeBackNudges: boolean;
  lightDistractedMinutes: number;
  strongDistractedMinutes: number;
  cooldownMinutes: number;
}

export type SystemMonitorModule = "cpu" | "cores" | "memory" | "disk" | "gpu" | "thermal";

export interface SystemMonitorSettings {
  refreshSeconds: number;
  modules: SystemMonitorModule[];
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

export type AppThemeID = "neobrutalism" | "mid-century-modern" | "hand-drawn";

export interface AppearanceSettings {
  theme: AppThemeID;
}

export interface AppSettings {
  hasCompletedOnboarding: boolean;
  appearance: AppearanceSettings;
  reminder: ReminderSettings;
  judgment: JudgmentSettings;
  pet: PetSettings;
  desktopWidget: DesktopWidgetSettings;
  systemMonitor: SystemMonitorSettings;
  desktopWidgetVisible: boolean;
  focusTargetMinutes: number;
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

export interface NativeRuntimeEnvelope {
  generation: number;
  inputSample?: NativeActivitySample;
  snapshot?: LocalStoreSnapshot;
  delta?: NativeRuntimeDelta;
  currentSnapshot: ActivitySnapshot;
  currentDecision: StateDecision;
  latestNudge?: NudgeEvent;
}

export type NativeRuntimeDelta = Partial<Pick<
  LocalStoreSnapshot,
  "stateSegments" | "appUsage" | "inputActivity" | "focusSessions" | "breakSessions" | "nudges"
>>;

export interface SystemMonitorCoreSample {
  name: string;
  usage: number;
  frequencyMHz: number;
}

export interface SystemMonitorDiskSample {
  name: string;
  mountPoint: string;
  totalBytes: number;
  availableBytes: number;
  usage: number;
}

export interface SystemMonitorThermalSample {
  label: string;
  celsius: number;
}

export interface SystemMonitorFanSample {
  label: string;
  rpm: number;
}

export interface SystemMetricsSample {
  sampledAt: string;
  cpuUsage: number;
  cpuName: string;
  cores: SystemMonitorCoreSample[];
  memoryTotalBytes: number;
  memoryUsedBytes: number;
  memoryUsage: number;
  disks: SystemMonitorDiskSample[];
  gpuName?: string | null;
  gpuUsage?: number | null;
  temperatures: SystemMonitorThermalSample[];
  fans: SystemMonitorFanSample[];
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

export interface InstallationSnapshot {
  bundlePath: string;
  buildIdentifier: string;
  versionDisplay: string;
  isInstalled: boolean;
  isRunningFromMountedVolume: boolean;
}

export interface RecognitionDiagnosticSnapshot {
  sampledAt: string;
  sampleQuality?: string;
  appName: string;
  bundleID?: string;
  windowTitle?: string;
  idleSeconds: number;
  keyboardCount: number;
  pointerCount: number;
  switchCount: number;
  isScreenLocked: boolean;
  category: ActivityCategory;
  catalogEntryCount: number;
  defaultRuleCount: number;
  userRuleCount: number;
  inputMonitoringStatus: string;
}

export interface AppRuntimeState extends LocalStoreSnapshot {
  currentSnapshot: ActivitySnapshot;
  currentDecision: StateDecision;
  summary: DailySummary;
  todayWorkload: InputWorkloadSummary;
  currentPetIntent: PetIntent;
  latestPetBubble?: string;
  statusMessage: string;
  recognitionDiagnostic: RecognitionDiagnosticSnapshot;
}

export const focusStates: FocusState[] = ["focus", "distracted", "break", "away"];

export const userFacingCategories: ActivityCategory[] = ["work", "entertainment", "ignore"];
