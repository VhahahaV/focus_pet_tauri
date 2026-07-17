import type { AppRuntimeState } from "../core/types";
import { runtimeActions } from "./runtime";
import type { DashboardTab } from "./types";

export type NativeMenuAction =
  | "open-today"
  | "open-pet"
  | "open-settings"
  | "toggle-widgets"
  | "toggle-pet"
  | "pause-reminders"
  | "resume-reminders"
  | "finish-focus";

export const nativeMenuTab = (action: NativeMenuAction): DashboardTab | undefined => {
  switch (action) {
    case "open-today":
      return "today";
    case "open-pet":
      return "pet";
    case "open-settings":
      return "settings";
    default:
      return undefined;
  }
};

export const applyNativeMenuAction = (
  state: AppRuntimeState,
  action: NativeMenuAction,
): AppRuntimeState | undefined => {
  switch (action) {
    case "toggle-widgets":
      return runtimeActions.updateSettings(state, (settings) => {
        const hasVisibleWidget =
          settings.desktopWidget.currentStatusVisible || settings.desktopWidget.recentRhythmVisible;
        return {
          ...settings,
          desktopWidget: {
            ...settings.desktopWidget,
            currentStatusVisible: !hasVisibleWidget,
            recentRhythmVisible: !hasVisibleWidget,
          },
        };
      });
    case "toggle-pet":
      return runtimeActions.togglePetHidden(state);
    case "pause-reminders":
      return runtimeActions.pauseReminders(state, state.settings.reminder.pauseMinutes);
    case "resume-reminders":
      return runtimeActions.resumeReminders(state);
    case "finish-focus":
      return runtimeActions.finishFocusSession(state, true);
    default:
      return undefined;
  }
};
