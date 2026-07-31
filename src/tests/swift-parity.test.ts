import { describe, expect, it } from "vitest";
import fixture from "../fixtures/swift-semantic-parity.json";
import { defaultPetIntentForNudgeReason } from "../core/nudge";
import {
  intentFromLegacyAction,
  legacyPetActionForIntent,
  preferredSourceActionIDs,
  userMappingIntents,
} from "../core/pet";
import type { NudgeReason, PetAction, PetIntentKind } from "../core/types";

describe("original Swift semantic parity", () => {
  it("keeps retired break intents out of the user-visible mapping", () => {
    expect(userMappingIntents).toEqual([
      "quietCompanion",
      "distractedObserve",
      "nudgeGentle",
      "nudgeStrong",
      "taskCompleted",
      "sleep",
    ]);
  });

  it("keeps rest and break source-action resolution byte-for-byte compatible", () => {
    for (const [intent, sourceActions] of Object.entries(fixture.preferredSourceActionIDs)) {
      expect(preferredSourceActionIDs[intent as PetIntentKind]).toEqual(sourceActions);
    }
  });

  it("round-trips Swift legacy PetAction mappings", () => {
    for (const [intent, action] of Object.entries(fixture.legacyPetActionByIntent)) {
      expect(legacyPetActionForIntent(intent as PetIntentKind)).toBe(action);
    }
    for (const [action, intent] of Object.entries(fixture.intentByLegacyPetAction)) {
      expect(intentFromLegacyAction(action as PetAction)).toBe(intent);
    }
  });

  it("maps retired break nudges to the neutral task-completed animation", () => {
    expect(defaultPetIntentForNudgeReason("longFocusRest")).toBe("taskCompleted");
    expect(defaultPetIntentForNudgeReason("veryLongFocusRest")).toBe("taskCompleted");
    expect(defaultPetIntentForNudgeReason("focusSessionCompleted")).toBe("taskCompleted");
    expect(defaultPetIntentForNudgeReason("breakEnding")).toBe("taskCompleted");
    for (const reason of ["distractedOverThreshold", "distractedStrong", "frequentSwitching", "welcomeBack"] as NudgeReason[]) {
      expect(defaultPetIntentForNudgeReason(reason)).toBe(
        fixture.defaultPetIntentByNudgeReason[reason],
      );
    }
  });
});
