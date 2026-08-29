import type {
  AppRuntimeState,
  ActivitySnapshot,
  ActivitySignalSource,
  AppSettings,
  ClassificationCatalogEntry,
  ClassificationRule,
  FocusState,
  LocalStoreSnapshot,
  NativeActivitySample,
  NudgeEvent,
  NudgeReason,
  PetIntentKind,
  PetIntentSource,
} from "../core/types";
import { ActivityClassifier, makeClassificationRule } from "../core/classification";
import { makeActivitySnapshot } from "../core/activity";
import { buildDailySummary } from "../core/summary";
import { decisionSnapshot, evaluateState } from "../core/stateEngine";
import { stateEngineThresholdsFromJudgment, nudgeThresholdsFromReminder, normalizeAppSettings } from "../core/settings";
import {
  activeFocusSession,
  finishFocusSession,
  makeFocusSession,
  remainingFocusSeconds,
} from "../core/sessions";
import { evaluateNudge, reminderAllowsReason } from "../core/nudge";
import { intentKindForState, makePetIntent } from "../core/pet";
import {
  inputWorkloadSummary,
  recordAppUsageSegment,
  recordInputActivity,
  recordStateSegment,
} from "../core/timeline";
import { dayBounds, secondsBetween } from "../core/utils";
import { emptySnapshot, normalizeSnapshot } from "../store/localStore";
import { makeMockActivitySample } from "./mockNative";

export interface RuntimeMemory {
  previousState?: FocusState;
  candidateState: FocusState;
  candidateSince: string;
  stableStateSince: string;
  lastNudgeAt: Partial<Record<NudgeReason, string>>;
  lastTickAt?: string;
  activeCategoryKey?: string;
  activeCategorySince: string;
  activeAppKey?: string;
  activeAppSince: string;
}

export interface RuntimeBundle {
  state: AppRuntimeState;
  memory: RuntimeMemory;
  latestNudge?: NudgeEvent;
}

export const initialMemory = (now = new Date()): RuntimeMemory => ({
  previousState: undefined,
  candidateState: "focus",
  candidateSince: now.toISOString(),
  stableStateSince: now.toISOString(),
  lastNudgeAt: {},
  lastTickAt: undefined,
  activeCategoryKey: undefined,
  activeCategorySince: now.toISOString(),
  activeAppKey: undefined,
  activeAppSince: now.toISOString(),
});

const initialActivitySnapshot = (now: Date): ActivitySnapshot => ({
  timestamp: now.toISOString(),
  appName: "Focus Pet",
  bundleID: "local.focuspet",
  windowTitle: undefined,
  titleHash: undefined,
  titleStored: false,
  titleDisplay: undefined,
  category: "work" as const,
  idleSeconds: 0,
  switchCountLast5Min: 0,
  switchCountLast15Min: 0,
  activeCategoryDuration: 0,
  activeAppDuration: 0,
  isFocusSessionActive: false,
  isSystemSleeping: false,
  isScreenLocked: false,
  source: ["frontmostApplication", "windowTitle", "idleTime", "appSwitching"],
});

export const runtimeFromSnapshot = (
  snapshot: LocalStoreSnapshot,
  catalogEntries: ClassificationCatalogEntry[],
  now = new Date(),
): RuntimeBundle => {
  const normalized = normalizeSnapshot(snapshot);
  const currentSnapshot = initialActivitySnapshot(now);
  const currentDecision = evaluateState(currentSnapshot, undefined, stateEngineThresholdsFromJudgment(normalized.settings.judgment));
  const bounds = dayBounds(now);
  return {
    state: {
      ...normalized,
      currentSnapshot,
      currentDecision,
      summary: buildDailySummary(
        now,
        normalized.stateSegments,
        normalized.appUsage,
        normalized.focusSessions,
        normalized.nudges,
        normalized.breakSessions,
      ),
      todayWorkload: inputWorkloadSummary(normalized.inputActivity, bounds.start, bounds.end),
      currentPetIntent: makePetIntent(intentKindForState(currentDecision.state), "state", { startedAt: now.toISOString() }),
      latestPetBubble: undefined,
      statusMessage: "Focus Pet 已准备好。",
      recognitionDiagnostic: {
        sampledAt: now.toISOString(),
        sampleQuality: undefined,
        appName: currentSnapshot.appName,
        bundleID: currentSnapshot.bundleID,
        windowTitle: currentSnapshot.windowTitle,
        idleSeconds: 0,
        keyboardCount: 0,
        pointerCount: 0,
        switchCount: 0,
        isScreenLocked: false,
        category: currentSnapshot.category,
        catalogEntryCount: catalogEntries.length,
        defaultRuleCount: new ActivityClassifier(normalized.classificationRules, catalogEntries).defaultRules.length,
        userRuleCount: normalized.classificationRules.length,
        inputMonitoringStatus: "检查中",
      },
    },
    memory: initialMemory(now),
    latestNudge: undefined,
  };
};

export const emptyRuntime = (catalogEntries: ClassificationCatalogEntry[] = []): RuntimeBundle =>
  runtimeFromSnapshot(emptySnapshot(), catalogEntries);

export const inputMonitoringPermissionTitle = (status: string): string => {
  const normalized = status.trim().toLowerCase();
  if (normalized === "已允许" || normalized === "available" || normalized.includes("available")) return "已允许";
  if (normalized === "检查中") return "检查中";
  return "待开启";
};

const applyStability = (
  decision: ReturnType<typeof evaluateState>,
  memory: RuntimeMemory,
  settings: AppSettings,
  now: Date,
) => {
  const applyImmediately =
    decision.state === "away" ||
    decision.reason.includes("explicitEntertainmentRule") ||
    (memory.previousState === "distracted" && decision.state === "focus") ||
    decision.reason.includes("systemSleep") ||
    decision.reason.includes("screenLocked") ||
    decision.reason.includes("longInputIdleAway");
  let candidateSince = memory.candidateSince;
  let candidateState = memory.candidateState;
  if (candidateState !== decision.state) {
    candidateState = decision.state;
    candidateSince = now.toISOString();
  }
  const hasStabilized =
    applyImmediately || secondsBetween(candidateSince, now) >= settings.judgment.focusRecoverySeconds;
  if (!hasStabilized && decision.state !== memory.previousState) {
    return {
      decision: {
        ...decision,
        state: memory.previousState ?? decision.state,
        reason: [...decision.reason, "previousStateHeld" as const],
        stableDuration: secondsBetween(memory.stableStateSince, now),
      },
      candidateState,
      candidateSince,
      stableStateSince: memory.stableStateSince,
      previousState: memory.previousState,
    };
  }
  const stateChanged = memory.previousState !== decision.state;
  const stableStateSince = stateChanged ? now.toISOString() : memory.stableStateSince;
  return {
    decision: {
      ...decision,
      stableDuration: stateChanged ? 0 : Math.max(decision.stableDuration, secondsBetween(stableStateSince, now)),
    },
    candidateState,
    candidateSince,
    stableStateSince,
    previousState: decision.state,
  };
};

export const advanceRuntime = (
  bundle: RuntimeBundle,
  sample: NativeActivitySample | undefined,
  catalogEntries: ClassificationCatalogEntry[],
): RuntimeBundle => {
  const now = new Date(sample?.timestamp ?? Date.now());
  // The history arrays can contain many months of records. Deep-cloning the
  // entire runtime on every sample made the UI progressively slower as data
  // accumulated. Timeline writers below already return immutable arrays, so
  // only copy the collections that this function mutates in place.
  const runtime: AppRuntimeState = {
    ...bundle.state,
    focusSessions: [...bundle.state.focusSessions],
    nudges: [...bundle.state.nudges],
  };
  const memory: RuntimeMemory = {
    ...bundle.memory,
    lastNudgeAt: { ...bundle.memory.lastNudgeAt },
  };
  const nativeSample = sample ?? makeMockActivitySample(now);
  let latestNudge: NudgeEvent | undefined;
  const rawTickSeconds = Math.max(1, memory.lastTickAt ? secondsBetween(memory.lastTickAt, now) : 10);
  const liveTickCapSeconds = 60;
  const minimumBackfillSeconds = 5;
  const sleepLikeGap = rawTickSeconds - liveTickCapSeconds >= minimumBackfillSeconds && (
    nativeSample.isSystemSleeping ||
    nativeSample.isScreenLocked ||
    nativeSample.idleSeconds >= rawTickSeconds - liveTickCapSeconds
  );
  const longGapThresholdSeconds = Math.max(30 * 60, runtime.settings.judgment.idleAwaySeconds);
  const longAwayGap = rawTickSeconds >= longGapThresholdSeconds;
  const backfillsAwayGap = Boolean(memory.lastTickAt && (sleepLikeGap || longAwayGap));
  const currentTickSeconds = backfillsAwayGap ? Math.min(liveTickCapSeconds, rawTickSeconds) : rawTickSeconds;
  const backfilledAwaySeconds = backfillsAwayGap ? Math.max(0, rawTickSeconds - currentTickSeconds) : 0;
  const inferredSystemSleepGap = backfilledAwaySeconds > 0 && sleepLikeGap && !nativeSample.isScreenLocked;
  const activeFocus = activeFocusSession(runtime.focusSessions);
  const classifier = new ActivityClassifier(runtime.classificationRules, catalogEntries);
  const classification = classifier.classifyDetailed(nativeSample.appName, nativeSample.bundleID, nativeSample.windowTitle);
  const category = classification.category;
  const categoryKey = `${category}`;
  const appKey = `${nativeSample.bundleID ?? ""}|${nativeSample.appName}`;
  if (backfilledAwaySeconds > 0 && !nativeSample.isSystemSleeping && !nativeSample.isScreenLocked) {
    memory.activeCategoryKey = undefined;
    memory.activeAppKey = undefined;
  }
  if (memory.activeCategoryKey !== categoryKey) {
    memory.activeCategoryKey = categoryKey;
    memory.activeCategorySince = now.toISOString();
  }
  if (memory.activeAppKey !== appKey) {
    memory.activeAppKey = appKey;
    memory.activeAppSince = now.toISOString();
  }
  const context = {
    category,
    classificationSource: classification.source,
    activeCategoryDuration: secondsBetween(memory.activeCategorySince, now),
    activeAppDuration: secondsBetween(memory.activeAppSince, now),
    isFocusSessionActive: Boolean(activeFocus),
    switchCountLast5Min: Math.max(nativeSample.switchCount, runtime.inputActivity.slice(-5).reduce((total, bucket) => total + bucket.switchCount, 0)),
    switchCountLast15Min: Math.max(nativeSample.switchCount, runtime.inputActivity.slice(-15).reduce((total, bucket) => total + bucket.switchCount, 0)),
  };
  const activitySnapshot = makeActivitySnapshot(nativeSample, context);
  const rawDecision = evaluateState(
    activitySnapshot,
    memory.previousState,
    stateEngineThresholdsFromJudgment(runtime.settings.judgment),
  );
  const previousState = memory.previousState;
  const previousStableStateSince = memory.stableStateSince;
  const stabilized =
    backfilledAwaySeconds > 0 && rawDecision.state !== "away"
      ? {
          decision: { ...rawDecision, stableDuration: 0 },
          candidateState: rawDecision.state,
          candidateSince: now.toISOString(),
          stableStateSince: now.toISOString(),
          previousState: rawDecision.state,
        }
      : applyStability(rawDecision, memory, runtime.settings, now);
  memory.candidateState = stabilized.candidateState;
  memory.candidateSince = stabilized.candidateSince;
  memory.stableStateSince = stabilized.stableStateSince;
  memory.previousState = stabilized.previousState;
  memory.lastTickAt = now.toISOString();

  runtime.currentSnapshot = activitySnapshot;
  runtime.currentDecision = stabilized.decision;

  {
    if (backfilledAwaySeconds > 0) {
      const awayEnd = new Date(now.getTime() - currentTickSeconds * 1000).toISOString();
      const awaySource: ActivitySignalSource[] = nativeSample.isSystemSleeping || inferredSystemSleepGap
        ? ["systemSleep"]
        : nativeSample.isScreenLocked
          ? ["screenLock"]
          : ["idleTime"];
      const awaySnapshot = {
        timestamp: awayEnd,
        appName: nativeSample.isSystemSleeping || inferredSystemSleepGap ? "Sleep" : nativeSample.isScreenLocked ? "Locked Screen" : "Away",
        bundleID: undefined,
        category: "ignore" as const,
        titleStored: false,
        titleDisplay: undefined,
        source: awaySource,
      };
      runtime.stateSegments = recordStateSegment(
        {
          timestamp: awayEnd,
          state: "away",
          category: "ignore",
          confidence: 0.9,
          reason: nativeSample.isSystemSleeping || inferredSystemSleepGap
            ? ["systemSleep"]
            : nativeSample.isScreenLocked
              ? ["screenLocked"]
              : ["longInputIdleAway"],
          stableDuration: backfilledAwaySeconds,
        },
        awaySnapshot,
        runtime.stateSegments,
        backfilledAwaySeconds,
      );
    }
    runtime.stateSegments = recordStateSegment(stabilized.decision, activitySnapshot, runtime.stateSegments, currentTickSeconds);
    if (stabilized.decision.state !== "away") {
      runtime.appUsage = recordAppUsageSegment(activitySnapshot, runtime.appUsage, currentTickSeconds);
    }
    runtime.inputActivity = recordInputActivity(
      now,
      nativeSample.keyboardCount,
      nativeSample.pointerCount,
      nativeSample.switchCount,
      runtime.inputActivity,
    );
  }

  if (activeFocus) {
    const index = runtime.focusSessions.findIndex((session) => session.id === activeFocus.id);
    const updated = { ...activeFocus };
    const classifiedForAttention = activitySnapshot.category === "work" || activitySnapshot.category === "entertainment";
    updated.awaySeconds += backfilledAwaySeconds;
    if (classifiedForAttention && stabilized.decision.state === "focus") updated.effectiveFocusSeconds += currentTickSeconds;
    if (classifiedForAttention && stabilized.decision.state === "distracted") updated.distractedSeconds += currentTickSeconds;
    if (stabilized.decision.state === "away") updated.awaySeconds += currentTickSeconds;
    updated.switchCount += nativeSample.switchCount;
    if (classifiedForAttention && stabilized.decision.state === "distracted" && previousState !== "distracted") updated.interruptionCount += 1;
    if (!updated.mainAppName && activitySnapshot.category === "work") updated.mainAppName = activitySnapshot.appName;
    if (remainingFocusSeconds(updated, now) <= 0) {
      const completed = finishFocusSession(updated, "completed", now, updated.mainAppName);
      runtime.focusSessions[index] = completed;
    } else {
      runtime.focusSessions[index] = updated;
    }
  }

  const nudgeState = decisionSnapshot(stabilized.decision, activitySnapshot);
  const previousStateForNudge = backfilledAwaySeconds > 0 ? "away" : previousState;
  const previousStateDurationForNudge =
    backfilledAwaySeconds > 0
      ? backfilledAwaySeconds
      : previousState
        ? previousState !== stabilized.decision.state
          ? secondsBetween(previousStableStateSince, now)
          : secondsBetween(memory.stableStateSince, now)
        : undefined;
  const nudge = evaluateNudge(
    nudgeState,
    previousStateForNudge,
    previousStateDurationForNudge,
    now,
    memory.lastNudgeAt,
    nudgeThresholdsFromReminder(runtime.settings.reminder),
  );
  if (
    nudge &&
    reminderAllowsReason(nudge.reason, runtime.settings.reminder) &&
    (!runtime.settings.reminder.pauseUntil || new Date(runtime.settings.reminder.pauseUntil) <= now)
  ) {
    runtime.nudges.push(nudge);
    latestNudge = nudge;
    memory.lastNudgeAt[nudge.reason] = nudge.time;
    runtime.latestPetBubble = nudge.message;
    runtime.currentPetIntent = makePetIntent(nudge.petIntent, "nudge", {
      startedAt: nudge.time,
      expiresAt: new Date(now.getTime() + 22_000).toISOString(),
      message: nudge.message,
    });
  } else if (runtime.currentPetIntent.expiresAt && new Date(runtime.currentPetIntent.expiresAt) < now) {
    runtime.currentPetIntent = makePetIntent(intentKindForState(stabilized.decision.state), "state", { startedAt: now.toISOString() });
    runtime.latestPetBubble = undefined;
  } else if (runtime.currentPetIntent.source === "state") {
    runtime.currentPetIntent = makePetIntent(intentKindForState(stabilized.decision.state), "state", { startedAt: runtime.currentPetIntent.startedAt });
  }

  const bounds = dayBounds(now);
  runtime.summary = buildDailySummary(
    now,
    runtime.stateSegments,
    runtime.appUsage,
    runtime.focusSessions,
    runtime.nudges,
    runtime.breakSessions,
  );
  runtime.todayWorkload = inputWorkloadSummary(runtime.inputActivity, bounds.start, bounds.end);
  runtime.recognitionDiagnostic = {
    sampledAt: now.toISOString(),
    sampleQuality: nativeSample.sampleQuality,
    appName: activitySnapshot.appName,
    bundleID: activitySnapshot.bundleID,
    windowTitle: activitySnapshot.windowTitle ?? activitySnapshot.titleDisplay,
    idleSeconds: nativeSample.idleSeconds,
    keyboardCount: nativeSample.keyboardCount,
    pointerCount: nativeSample.pointerCount,
    switchCount: nativeSample.switchCount,
    isScreenLocked: nativeSample.isScreenLocked,
    category: activitySnapshot.category,
    catalogEntryCount: catalogEntries.length,
    defaultRuleCount: classifier.defaultRules.length,
    userRuleCount: runtime.classificationRules.length,
    inputMonitoringStatus: inputMonitoringPermissionTitle(nativeSample.inputMonitoringStatus),
  };
  return { state: runtime, memory, latestNudge };
};

export const runtimeSnapshot = (state: AppRuntimeState): LocalStoreSnapshot => ({
  settings: normalizeAppSettings(state.settings),
  classificationRules: state.classificationRules,
  stateSegments: state.stateSegments,
  appUsage: state.appUsage,
  inputActivity: state.inputActivity,
  focusSessions: state.focusSessions,
  breakSessions: state.breakSessions,
  nudges: state.nudges,
});

export const runtimeActions = {
  startFocusSession(state: AppRuntimeState, taskName: string, minutes: number): AppRuntimeState {
    if (activeFocusSession(state.focusSessions)) return state;
    return {
      ...state,
      focusSessions: [
        ...state.focusSessions,
        makeFocusSession(taskName, minutes, new Date()),
      ],
      statusMessage: "专注会话已开始。",
    };
  },
  finishFocusSession(state: AppRuntimeState, completed = true): AppRuntimeState {
    const active = activeFocusSession(state.focusSessions);
    if (!active) return state;
    const focusSessions = state.focusSessions.map((session) =>
      session.id === active.id ? finishFocusSession(session, completed ? "completed" : "cancelled") : session
    );
    return {
      ...state,
      focusSessions,
      statusMessage: completed ? "专注会话已完成。" : "专注会话已取消。",
    };
  },
  pauseReminders(state: AppRuntimeState, minutes?: number): AppRuntimeState {
    const pauseMinutes = minutes ?? state.settings.reminder.pauseMinutes;
    return {
      ...state,
      settings: {
        ...state.settings,
        reminder: {
          ...state.settings.reminder,
          pauseUntil: new Date(Date.now() + pauseMinutes * 60_000).toISOString(),
          pauseMinutes,
        },
      },
      statusMessage: `提醒已暂停 ${pauseMinutes} 分钟。`,
    };
  },
  resumeReminders(state: AppRuntimeState): AppRuntimeState {
    return {
      ...state,
      settings: { ...state.settings, reminder: { ...state.settings.reminder, pauseUntil: undefined } },
      statusMessage: "提醒已恢复。",
    };
  },
  updateSettings(state: AppRuntimeState, updater: (settings: AppSettings) => AppSettings): AppRuntimeState {
    return { ...state, settings: normalizeAppSettings(updater(state.settings)), statusMessage: "设置已保存。" };
  },
  addRule(
    state: AppRuntimeState,
    pattern: string,
    matchKind: ClassificationRule["matchKind"],
    category: ClassificationRule["category"],
  ): AppRuntimeState {
    if (pattern.trim().length === 0) return state;
    const existingIndex = state.classificationRules.findIndex(
      (rule) => rule.pattern.trim().toLowerCase() === pattern.trim().toLowerCase() && rule.matchKind === matchKind,
    );
    const nextRules = [...state.classificationRules];
    if (existingIndex >= 0) {
      nextRules[existingIndex] = { ...nextRules[existingIndex], category };
    } else {
      nextRules.unshift(makeClassificationRule(pattern, matchKind, category));
    }
    return { ...state, classificationRules: nextRules, statusMessage: "分类规则已更新。" };
  },
  deleteRule(state: AppRuntimeState, id: string): AppRuntimeState {
    return {
      ...state,
      classificationRules: state.classificationRules.filter((rule) => rule.id !== id),
      statusMessage: "分类规则已删除。",
    };
  },
  resetRecognitionRules(state: AppRuntimeState): AppRuntimeState {
    return {
      ...state,
      classificationRules: [],
      recognitionDiagnostic: {
        ...state.recognitionDiagnostic,
        userRuleCount: 0,
      },
      statusMessage: "用户识别例外已清空。",
    };
  },
  togglePetHidden(state: AppRuntimeState): AppRuntimeState {
    return runtimeActions.updateSettings(state, (settings) => ({
      ...settings,
      pet: { ...settings.pet, hidden: !settings.pet.hidden },
    }));
  },
  setSelectedPetPack(state: AppRuntimeState, packID: string): AppRuntimeState {
    return runtimeActions.updateSettings(state, (settings) => ({
      ...settings,
      pet: { ...settings.pet, selectedPackID: packID },
    }));
  },
  hidePetPack(state: AppRuntimeState, packID: string): AppRuntimeState {
    if (packID.trim().length === 0) return state;
    return runtimeActions.updateSettings(state, (settings) => {
      const hiddenPackIDs = [...new Set([...settings.pet.hiddenPackIDs, packID])];
      const { [packID]: _idle, ...idleSourceActionIDByPack } = settings.pet.idleSourceActionIDByPack;
      const { [packID]: _intent, ...intentSourceActionIDByPack } = settings.pet.intentSourceActionIDByPack;
      return {
        ...settings,
        pet: {
          ...settings.pet,
          hiddenPackIDs,
          idleSourceActionIDByPack,
          intentSourceActionIDByPack,
        },
      };
    });
  },
  unhidePetPacks(state: AppRuntimeState, packIDs: string[]): AppRuntimeState {
    const restoring = new Set(packIDs.filter((id) => id.trim().length > 0));
    if (restoring.size === 0) return state;
    return runtimeActions.updateSettings(state, (settings) => ({
      ...settings,
      pet: {
        ...settings.pet,
        hiddenPackIDs: settings.pet.hiddenPackIDs.filter((id) => !restoring.has(id)),
      },
    }));
  },
  clearDataState(state: AppRuntimeState): AppRuntimeState {
    return {
      ...state,
      stateSegments: [],
      appUsage: [],
      inputActivity: [],
      focusSessions: [],
      nudges: [],
      statusMessage: "本地统计数据已清空。",
    };
  },
  transientPetIntent(
    state: AppRuntimeState,
    kind: PetIntentKind = "mouseSummon",
    message = "我在这里。",
    source: PetIntentSource = "interaction",
    visibleMs = 8000,
  ): AppRuntimeState {
    const now = new Date();
    return {
      ...state,
      currentPetIntent: makePetIntent(kind, source, {
        startedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + visibleMs).toISOString(),
        message,
        interruptible: source !== "physicalInteraction",
      }),
      latestPetBubble: message,
    };
  },
};
