import type {
  AppRuntimeState,
  DailySummary,
  InputWorkloadSummary,
  PetIntent,
  PetSettings,
} from "../core/types";

export interface PetCompanionViewState {
  petSettings: PetSettings;
  currentPetIntent: PetIntent;
  summary: Pick<DailySummary, "focusSeconds" | "distractedSeconds">;
  todayWorkload: Pick<InputWorkloadSummary, "estimatedTypedCharacters" | "pointerActionCount">;
  latestPetBubble?: string;
  breakActive: boolean;
}

export const makePetCompanionViewState = (
  state: AppRuntimeState,
  breakActive: boolean,
): PetCompanionViewState => ({
  petSettings: state.settings.pet,
  currentPetIntent: state.currentPetIntent,
  summary: {
    focusSeconds: state.summary.focusSeconds,
    distractedSeconds: state.summary.distractedSeconds,
  },
  todayWorkload: {
    estimatedTypedCharacters: state.todayWorkload.estimatedTypedCharacters,
    pointerActionCount: state.todayWorkload.pointerActionCount,
  },
  latestPetBubble: state.latestPetBubble,
  breakActive,
});
