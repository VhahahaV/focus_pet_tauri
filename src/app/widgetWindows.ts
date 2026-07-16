import type { AppRuntimeState, DesktopWidgetPosition } from "../core/types";
import { runtimeActions } from "./runtime";

export type DesktopWidgetMoveLabel = "currentStatus" | "recentRhythm";

export interface WidgetWindowSyncState {
  currentStatusVisible: boolean;
  recentRhythmVisible: boolean;
  movementMode: AppRuntimeState["settings"]["desktopWidget"]["movementMode"];
  currentStatusOrigin?: DesktopWidgetPosition;
  recentRhythmOrigin?: DesktopWidgetPosition;
  petCompanionVisible: boolean;
  petSize: number;
  petPlacement: AppRuntimeState["settings"]["pet"]["placement"];
  petOrigin?: DesktopWidgetPosition;
}

export const widgetOrigin = (origin?: DesktopWidgetPosition): DesktopWidgetPosition | undefined =>
  origin?.x !== undefined && origin?.y !== undefined ? { x: origin.x, y: origin.y } : undefined;

const positionsApproximatelyEqual = (
  left: DesktopWidgetPosition | undefined,
  right: DesktopWidgetPosition,
): boolean => Boolean(left && Math.abs(left.x - right.x) < 1 && Math.abs(left.y - right.y) < 1);

export const applyDesktopWidgetMoved = (
  state: AppRuntimeState,
  label: DesktopWidgetMoveLabel,
  origin: DesktopWidgetPosition,
): AppRuntimeState => {
  const currentOrigin =
    label === "currentStatus"
      ? state.settings.desktopWidget.currentStatusOrigin
      : state.settings.desktopWidget.recentRhythmOrigin;
  if (positionsApproximatelyEqual(currentOrigin, origin)) return state;
  return runtimeActions.updateSettings(state, (settings) => {
    if (label === "currentStatus") {
      return {
        ...settings,
        desktopWidget: {
          ...settings.desktopWidget,
          currentStatusOrigin: origin,
        },
      };
    }
    return {
      ...settings,
      desktopWidget: {
        ...settings.desktopWidget,
        recentRhythmOrigin: origin,
      },
    };
  });
};

export const widgetWindowSyncState = (state: AppRuntimeState): WidgetWindowSyncState => {
  const pet = state.settings.pet;
  return {
    currentStatusVisible: state.settings.desktopWidget.currentStatusVisible,
    recentRhythmVisible: state.settings.desktopWidget.recentRhythmVisible,
    movementMode: state.settings.desktopWidget.movementMode,
    currentStatusOrigin: widgetOrigin(state.settings.desktopWidget.currentStatusOrigin),
    recentRhythmOrigin: widgetOrigin(state.settings.desktopWidget.recentRhythmOrigin),
    petCompanionVisible: !pet.hidden,
    petSize: pet.size,
    petPlacement: pet.placement,
    petOrigin:
      pet.placement === "custom" && pet.customOriginX !== undefined && pet.customOriginY !== undefined
        ? { x: pet.customOriginX, y: pet.customOriginY }
        : undefined,
  };
};
