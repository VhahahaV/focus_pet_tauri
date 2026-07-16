import type {
  FocusState,
  FocusStateSnapshot,
  NudgeEvent,
  NudgePolicyThresholds,
  NudgeReason,
  PetIntentKind,
} from "./types";
import { makeID } from "./utils";

export const defaultNudgePolicyThresholds = (): NudgePolicyThresholds => ({
  lightDistractedSeconds: 5 * 60,
  strongDistractedSeconds: 12 * 60,
  longFocusSeconds: 45 * 60,
  veryLongFocusSeconds: 90 * 60,
  welcomeBackAwaySeconds: 30 * 60,
  cooldownSeconds: 10 * 60,
});

export const defaultPetIntentForNudgeReason = (reason: NudgeReason): PetIntentKind => {
  switch (reason) {
    case "distractedOverThreshold":
      return "nudgeGentle";
    case "distractedStrong":
    case "frequentSwitching":
      return "nudgeStrong";
    case "longFocusRest":
    case "veryLongFocusRest":
    case "focusSessionCompleted":
      return "focusRestHint";
    case "breakEnding":
      return "breakEnding";
    case "welcomeBack":
      return "welcomeBack";
  }
};

const cooldownReasons = (reason: NudgeReason): NudgeReason[] => {
  switch (reason) {
    case "distractedOverThreshold":
    case "distractedStrong":
    case "frequentSwitching":
      return ["distractedOverThreshold", "distractedStrong", "frequentSwitching"];
    case "longFocusRest":
    case "veryLongFocusRest":
      return ["longFocusRest", "veryLongFocusRest"];
    case "focusSessionCompleted":
      return ["focusSessionCompleted"];
    case "breakEnding":
      return ["breakEnding"];
    case "welcomeBack":
      return ["welcomeBack"];
  }
};

const cooldownSeconds = (reason: NudgeReason, thresholds: NudgePolicyThresholds): number => {
  switch (reason) {
    case "longFocusRest":
    case "veryLongFocusRest":
      return Math.max(thresholds.cooldownSeconds, 30 * 60);
    case "welcomeBack":
      return Math.max(thresholds.cooldownSeconds, 2 * 60 * 60);
    default:
      return thresholds.cooldownSeconds;
  }
};

const event = (
  reason: NudgeReason,
  state: FocusStateSnapshot,
  now: Date,
  intent: PetIntentKind,
  message: string,
  lastTriggeredAt: Partial<Record<NudgeReason, string>>,
  thresholds: NudgePolicyThresholds,
): NudgeEvent | undefined => {
  const cooldown = cooldownSeconds(reason, thresholds);
  for (const cooldownReason of cooldownReasons(reason)) {
    const last = lastTriggeredAt[cooldownReason];
    if (last && (now.getTime() - new Date(last).getTime()) / 1000 < cooldown) {
      return undefined;
    }
  }
  return {
    id: makeID("nudge"),
    time: now.toISOString(),
    reason,
    state: state.state,
    appName: state.appName,
    category: state.category,
    petIntent: intent,
    channel: "desktop",
    cooldownSeconds: cooldown,
    message,
  };
};

export const evaluateNudge = (
  state: FocusStateSnapshot,
  previousState: FocusState | undefined,
  previousStateDuration: number | undefined,
  now: Date,
  lastTriggeredAt: Partial<Record<NudgeReason, string>>,
  thresholds: NudgePolicyThresholds = defaultNudgePolicyThresholds(),
): NudgeEvent | undefined => {
  if (
    previousState === "away" &&
    state.state === "focus" &&
    (previousStateDuration ?? 0) >= thresholds.welcomeBackAwaySeconds
  ) {
    return event("welcomeBack", state, now, "welcomeBack", "继续当前任务", lastTriggeredAt, thresholds);
  }

  switch (state.state) {
    case "focus":
      if (state.stableDuration >= thresholds.veryLongFocusSeconds) {
        return event("veryLongFocusRest", state, now, "focusRestHint", "离屏活动 5 分钟", lastTriggeredAt, thresholds);
      }
      if (state.stableDuration >= thresholds.longFocusSeconds) {
        return event("longFocusRest", state, now, "focusRestHint", "休息 5 分钟", lastTriggeredAt, thresholds);
      }
      return undefined;
    case "distracted":
      if (state.stableDuration >= thresholds.strongDistractedSeconds) {
        return event("distractedStrong", state, now, "nudgeStrong", "立即回到任务", lastTriggeredAt, thresholds);
      }
      if (state.stableDuration >= thresholds.lightDistractedSeconds) {
        return event("distractedOverThreshold", state, now, "nudgeGentle", "回到任务 2 分钟", lastTriggeredAt, thresholds);
      }
      return undefined;
    case "break":
    case "away":
      return undefined;
  }
};

export const reminderAllowsReason = (
  reason: NudgeReason,
  flags: {
    enableDistractedNudges: boolean;
    enableFocusRestNudges: boolean;
    enableWelcomeBackNudges: boolean;
  },
): boolean => {
  switch (reason) {
    case "distractedOverThreshold":
    case "distractedStrong":
    case "frequentSwitching":
      return flags.enableDistractedNudges;
    case "longFocusRest":
    case "veryLongFocusRest":
    case "focusSessionCompleted":
    case "breakEnding":
      return flags.enableFocusRestNudges;
    case "welcomeBack":
      return flags.enableWelcomeBackNudges;
  }
};
