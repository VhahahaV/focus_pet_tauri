import type { FocusState, NudgeEvent, PetAction, PetIntent, PetIntentKind, PetIntentSource } from "./types";
import { makeID } from "./utils";

export const intentPriority = (source: PetIntentSource): number => {
  switch (source) {
    case "physicalInteraction":
      return 500;
    case "nudge":
      return 400;
    case "interaction":
      return 300;
    case "state":
      return 100;
  }
};

export const preferredSourceActionIDs: Record<PetIntentKind, string[]> = {
  quietCompanion: ["default", "idle", "work", "focus", "normal", "onfloor", "stand", "breath"],
  distractedObserve: ["distractedLook", "disturbed", "distracted", "nudgeGentle", "default", "idle"],
  breakCompanion: ["breakRelax", "break", "relax", "onfloor", "sleep", "default", "idle"],
  nudgeGentle: ["nudgeGentle", "distractedLook", "patpat", "patpat1", "disturbed", "default"],
  nudgeStrong: ["nudgeStrong", "disturbed", "shake", "nudgeGentle", "distractedLook", "default"],
  taskCompleted: ["welcomeBack", "stretch", "mouseSummon", "cursorPounce", "default", "idle"],
  focusRestHint: ["stretch", "grooming", "blink", "idle", "default"],
  sleep: ["sleep", "sleeping", "nap", "onfloor", "default"],
  breakEnding: ["breakEnd", "mouseSummon", "cursorPounce", "welcomeBack", "wake", "default"],
  welcomeBack: ["welcomeBack", "wake", "mouseSummon", "default", "idle"],
  moveLeft: ["left_walk", "leftwalk", "left", "run", "right_walk", "right"],
  moveRight: ["right_walk", "rightwalk", "right", "run", "left_walk", "left"],
  moveUp: ["up", "climb", "screenTransfer", "run", "right_walk", "left_walk"],
  moveDown: ["down", "fall", "climb", "screenTransfer", "run", "onfloor"],
  dragged: ["drag", "dragged", "idle", "default"],
  landing: ["landing", "fall", "onfloor", "default", "idle"],
  mouseSummon: ["mouseSummon", "cursorPounce", "welcomeBack", "run", "default"],
  dashboardGuide: ["welcomeBack", "stretch", "default", "idle"],
};

export const userMappingIntents: PetIntentKind[] = [
  "quietCompanion",
  "distractedObserve",
  "nudgeGentle",
  "nudgeStrong",
  "taskCompleted",
  "sleep",
];

export const advancedMappingIntents: PetIntentKind[] = [
  "welcomeBack",
  "mouseSummon",
  "dragged",
  "landing",
  "moveLeft",
  "moveRight",
  "moveUp",
  "moveDown",
];

export const intentKindForState = (state: FocusState): PetIntentKind => {
  switch (state) {
    case "focus":
      return "quietCompanion";
    case "distracted":
      return "distractedObserve";
    case "break":
      return "breakCompanion";
    case "away":
      return "sleep";
  }
};

export const legacyPetActionForIntent = (intent: PetIntentKind): PetAction => {
  switch (intent) {
    case "quietCompanion":
      return "idle";
    case "distractedObserve":
      return "distractedLook";
    case "breakCompanion":
      return "breakRelax";
    case "nudgeGentle":
      return "nudgeGentle";
    case "nudgeStrong":
      return "nudgeStrong";
    case "taskCompleted":
      return "welcomeBack";
    case "focusRestHint":
      return "stretch";
    case "sleep":
      return "sleep";
    case "breakEnding":
      return "breakEnd";
    case "welcomeBack":
      return "welcomeBack";
    case "dragged":
      return "dragged";
    case "landing":
      return "landing";
    case "mouseSummon":
      return "mouseSummon";
    case "dashboardGuide":
      return "welcomeBack";
    case "moveLeft":
    case "moveRight":
    case "moveUp":
    case "moveDown":
      return "run";
  }
};

export const intentFromLegacyAction = (action: PetAction): PetIntentKind => {
  switch (action) {
    case "idle":
    case "blink":
    case "breath":
    case "focusStart":
    case "focusStable":
    case "wake":
      return "quietCompanion";
    case "sleep":
      return "sleep";
    case "breakRelax":
      return "breakCompanion";
    case "breakEnd":
      return "breakEnding";
    case "stretch":
      return "focusRestHint";
    case "distractedLook":
      return "distractedObserve";
    case "nudgeGentle":
      return "nudgeGentle";
    case "nudgeStrong":
      return "nudgeStrong";
    case "welcomeBack":
      return "welcomeBack";
    case "dragged":
      return "dragged";
    case "landing":
      return "landing";
    case "run":
    case "screenTransfer":
      return "moveRight";
    case "mouseSummon":
      return "mouseSummon";
  }
};

export const makePetIntent = (
  kind: PetIntentKind,
  source: PetIntentSource,
  options: Partial<Pick<PetIntent, "priority" | "startedAt" | "expiresAt" | "message" | "interruptible">> = {},
): PetIntent => ({
  id: makeID("intent"),
  kind,
  source,
  priority: options.priority ?? intentPriority(source),
  startedAt: options.startedAt ?? new Date().toISOString(),
  expiresAt: options.expiresAt,
  message: options.message,
  interruptible: options.interruptible ?? true,
});

export const petActionForState = (
  state: FocusState,
  latestNudge?: NudgeEvent,
  now = new Date(),
  nudgeActionVisibleSeconds = 22,
): PetAction => {
  if (latestNudge && (now.getTime() - new Date(latestNudge.time).getTime()) / 1000 <= nudgeActionVisibleSeconds) {
    return legacyPetActionForIntent(latestNudge.petIntent);
  }
  return legacyPetActionForIntent(intentKindForState(state));
};
