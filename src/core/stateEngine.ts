import type { ActivitySnapshot, FocusState, FocusStateSnapshot, StateDecision, StateEngineThresholds } from "./types";
import { makeID } from "./utils";

export const defaultStateEngineThresholds = (): StateEngineThresholds => ({
  uiStabilitySeconds: 10,
  idleDistractedSeconds: 180,
  idleAwaySeconds: 600,
  distractedSeconds: 60,
});

const decision = (
  snapshot: ActivitySnapshot,
  state: FocusState,
  confidence: number,
  reason: StateDecision["reason"],
  stableDuration: number,
): StateDecision => ({
  timestamp: snapshot.timestamp,
  state,
  category: snapshot.category,
  confidence,
  reason,
  stableDuration: Math.max(0, stableDuration),
});

export const evaluateState = (
  snapshot: ActivitySnapshot,
  previousStableState?: FocusState,
  thresholds: StateEngineThresholds = defaultStateEngineThresholds(),
): StateDecision => {
  const idleAwaySeconds = Math.max(thresholds.idleDistractedSeconds, thresholds.idleAwaySeconds);
  const activeCarryState: FocusState = previousStableState === "distracted" ? "distracted" : "focus";

  if (snapshot.isSystemSleeping) {
    return decision(snapshot, "away", 0.98, ["systemSleep"], Math.max(snapshot.idleSeconds, snapshot.activeCategoryDuration));
  }

  if (snapshot.isScreenLocked) {
    return decision(snapshot, "away", 0.96, ["screenLocked"], Math.max(snapshot.idleSeconds, snapshot.activeCategoryDuration));
  }

  if (snapshot.idleSeconds >= idleAwaySeconds) {
    return decision(snapshot, "away", 0.88, ["longInputIdleAway"], snapshot.idleSeconds);
  }

  if (snapshot.idleSeconds >= thresholds.idleDistractedSeconds) {
    return decision(snapshot, "distracted", 0.82, ["inputIdleDistracted"], snapshot.idleSeconds);
  }

  switch (snapshot.category) {
    case "work":
      return decision(snapshot, "focus", 0.84, ["workCategory"], snapshot.activeCategoryDuration);
    case "entertainment":
      if (snapshot.classificationSource === "userRule") {
        return decision(snapshot, "distracted", 0.96, ["explicitEntertainmentRule"], snapshot.activeCategoryDuration);
      }
      if (snapshot.activeCategoryDuration >= thresholds.distractedSeconds) {
        return decision(snapshot, "distracted", 0.84, ["entertainmentStable"], snapshot.activeCategoryDuration);
      }
      return decision(snapshot, activeCarryState, 0.58, ["entertainmentGrace", "previousStateHeld"], snapshot.activeCategoryDuration);
    case "ignore":
      return decision(snapshot, activeCarryState, 0.45, ["ignoredActivity", "previousStateHeld"], snapshot.activeCategoryDuration);
    case "neutral":
      if (previousStableState === "distracted" && snapshot.idleSeconds <= thresholds.uiStabilitySeconds) {
        return decision(snapshot, "focus", 0.64, ["recentInputRecovery"], snapshot.activeCategoryDuration);
      }
      return decision(
        snapshot,
        activeCarryState,
        0.55,
        previousStableState === undefined ? ["neutralDefault"] : ["previousStateHeld"],
        snapshot.activeCategoryDuration,
      );
  }
};

export const decisionSnapshot = (decision: StateDecision, source: ActivitySnapshot): FocusStateSnapshot => ({
  id: makeID("state-snapshot"),
  timestamp: decision.timestamp,
  state: decision.state,
  category: decision.category,
  stableDuration: decision.stableDuration,
  appName: source.appName,
  bundleID: source.bundleID,
  reason: decision.reason,
});
