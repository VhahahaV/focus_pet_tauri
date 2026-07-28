import type {
  AppRuntimeState,
  AppThemeID,
  DailySummary,
  InputWorkloadSummary,
  PetIntent,
  PetSettings,
} from "../core/types";

export interface PetCompanionViewState {
  theme: AppThemeID;
  petSettings: PetSettings;
  currentPetIntent: PetIntent;
  summary: Pick<DailySummary, "focusSeconds" | "distractedSeconds">;
  todayWorkload: Pick<InputWorkloadSummary, "estimatedTypedCharacters" | "pointerActionCount">;
  latestPetBubble?: string;
  codexBubble?: string;
}

export const makePetCompanionViewState = (state: AppRuntimeState, codexBubble?: string): PetCompanionViewState => ({
  theme: state.settings.appearance.theme,
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
  codexBubble,
});
