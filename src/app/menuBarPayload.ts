import type { ActivitySnapshot, AppSettings, DailySummary, StateDecision } from "../core/types";

export interface MenuBarPayload {
  currentDecision: StateDecision;
  summary: DailySummary;
  currentSnapshot: ActivitySnapshot;
  settings: AppSettings;
  statusMessage: string;
  latestPetBubble?: string;
  activeFocus?: {
    id: string;
    taskName: string;
  };
  activeBreakActive: boolean;
  hasAvailablePetPacks: boolean;
}
