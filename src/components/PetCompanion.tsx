import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useMemo, useState } from "react";
import {
  Coffee,
  Gauge,
  Keyboard,
  LayoutDashboard,
  MousePointer2,
  Settings,
  Shuffle,
  Target,
} from "lucide-react";
import { emptyRuntime } from "../app/runtime";
import { makePetCompanionViewState, type PetCompanionViewState } from "../app/petCompanionPayload";
import { petIntentLabels } from "../core/labels";
import type { PetPlacementMode } from "../core/types";
import { formatCompactDuration, formatCount } from "../core/formatters";
import {
  demoPetPackRecords,
  sourceActionAssetsForID,
  type PetPackRecord,
} from "../resources/petPack";
import { useFocusPet } from "../app/AppContext";
import type { NativeMenuAction } from "../app/nativeMenu";
import { cyclePlayableSourceAction, resolveDisplaySourceAction, type RandomSourceActionState } from "../app/petCompanionLogic";

interface PetCompanionRendererProps {
  state: PetCompanionViewState;
  petPacks: PetPackRecord[];
  windowMode?: boolean;
  onAction?: (action: PetCompanionAction) => void;
}

const fallbackPreviewURL = `${import.meta.env.BASE_URL}assets/pet-luo-xiaohei.png`;

type PetCompanionAction = "open-dashboard" | "open-pet" | "toggle-break";

const placementClass = (placement: PetPlacementMode): string => `placement-${placement}`;

const animationFrameDelay = (fps: number): number => Math.max(90, 1000 / Math.max(1, fps));

const petActionToNativeMenuAction = (action: PetCompanionAction): NativeMenuAction => {
  switch (action) {
    case "open-dashboard":
      return "open-today";
    case "open-pet":
      return "open-pet";
    case "toggle-break":
      return "toggle-break";
  }
};

export const PetCompanionRenderer = ({ state, petPacks, windowMode = false, onAction }: PetCompanionRendererProps) => {
  const settings = state.petSettings;
  const [isHovering, setIsHovering] = useState(false);
  const [randomState, setRandomState] = useState<RandomSourceActionState>({});
  const [manualBubble, setManualBubble] = useState<string | undefined>();
  const selectedPack = petPacks.find((record) => record.id === settings.selectedPackID) ?? petPacks[0];
  const resolvedSourceAction = resolveDisplaySourceAction(
    state.currentPetIntent,
    selectedPack,
    settings,
    randomState,
  );
  const sourceAction = resolvedSourceAction.action;
  const assets = sourceActionAssetsForID(selectedPack, sourceAction?.id);
  const frames = assets?.frameURLs.length ? assets.frameURLs : [selectedPack?.previewURL ?? fallbackPreviewURL];
  const frameDelay = animationFrameDelay(sourceAction?.fps ?? 8);
  const animationKey = `${selectedPack?.id ?? "fallback"}:${sourceAction?.id ?? "preview"}:${state.currentPetIntent.id}`;
  const [frameIndex, setFrameIndex] = useState(0);
  const breakActive = state.breakActive;
  const visibleBubble = manualBubble ?? (windowMode ? undefined : state.latestPetBubble);
  const hoverItems = useMemo(
    () => [
      { title: "专注", value: formatCompactDuration(state.summary.focusSeconds), Icon: Target },
      { title: "走神", value: formatCompactDuration(state.summary.distractedSeconds), Icon: Gauge },
      { title: "键盘", value: formatCount(state.todayWorkload.estimatedTypedCharacters), Icon: Keyboard },
      { title: "鼠标", value: formatCount(state.todayWorkload.pointerActionCount), Icon: MousePointer2 },
    ],
    [
      state.summary.distractedSeconds,
      state.summary.focusSeconds,
      state.todayWorkload.estimatedTypedCharacters,
      state.todayWorkload.pointerActionCount,
    ],
  );

  useEffect(() => {
    setFrameIndex(0);
  }, [animationKey]);

  useEffect(() => {
    if (!manualBubble) return undefined;
    const timer = window.setTimeout(() => setManualBubble(undefined), 2400);
    return () => window.clearTimeout(timer);
  }, [manualBubble]);

  useEffect(() => {
    const nextState = resolvedSourceAction.randomState;
    if (
      randomState.packID === nextState.packID &&
      randomState.sourceActionID === nextState.sourceActionID &&
      randomState.switchedAt === nextState.switchedAt
    ) {
      return;
    }
    setRandomState(nextState);
  }, [
    randomState.packID,
    randomState.sourceActionID,
    randomState.switchedAt,
    resolvedSourceAction.randomState,
  ]);

  useEffect(() => {
    if (!settings.randomActionSwitchEnabled || !selectedPack || state.currentPetIntent.source === "physicalInteraction") return undefined;
    const delay = Math.max(15, settings.randomActionSwitchSeconds) * 1000;
    const timer = window.setInterval(() => {
      setRandomState((state) => ({ ...state, switchedAt: state.switchedAt === undefined ? undefined : 0 }));
    }, delay);
    return () => window.clearInterval(timer);
  }, [
    state.currentPetIntent.source,
    selectedPack,
    settings.randomActionSwitchEnabled,
    settings.randomActionSwitchSeconds,
  ]);

  useEffect(() => {
    if (!settings.animationEnabled || frames.length <= 1) return undefined;
    const timer = window.setInterval(() => {
      setFrameIndex((index) => {
        const next = index + 1;
        if (next < frames.length) return next;
        return sourceAction?.loop === false ? index : 0;
      });
    }, frameDelay);
    return () => window.clearInterval(timer);
  }, [frameDelay, frames.length, settings.animationEnabled, sourceAction?.loop]);

  useEffect(() => {
    if (!settings.audioEnabled || !assets?.audioURL) return;
    const audio = new Audio(assets.audioURL);
    audio.volume = Math.min(1, Math.max(0, sourceAction?.audio?.volume ?? 0.55));
    void audio.play().catch(() => undefined);
  }, [animationKey, assets?.audioURL, settings.audioEnabled, sourceAction?.audio?.volume]);

  if (settings.hidden && !windowMode) return null;
  const currentFrame = frames[Math.min(frameIndex, frames.length - 1)] ?? fallbackPreviewURL;
  const cycleAction = () => {
    const next = cyclePlayableSourceAction(selectedPack, sourceAction?.id);
    if (!next.action) return;
    setRandomState(next.randomState);
    setFrameIndex(0);
    setManualBubble(`已换 ${next.action.title}`);
  };
  return (
    <aside
      className={`pet-companion ${windowMode ? "window-pet" : placementClass(settings.placement)} ${isHovering ? "is-hovering" : ""}`}
      style={{ "--pet-size": `${settings.size}px`, "--pet-opacity": settings.opacity } as React.CSSProperties}
      aria-label="桌宠"
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsHovering(false);
      }}
      onFocusCapture={() => setIsHovering(true)}
      onPointerEnter={() => setIsHovering(true)}
      onPointerLeave={() => setIsHovering(false)}
    >
      {visibleBubble ? <span className="floating-pet-bubble">{visibleBubble}</span> : null}
      <button
        className="pet-avatar-button"
        type="button"
        title={`${petIntentLabels[state.currentPetIntent.kind]} · 拖动桌宠`}
        onPointerDown={() => {
          if (windowMode && "__TAURI_INTERNALS__" in window) {
            setIsHovering(false);
            void getCurrentWindow().startDragging().catch(() => undefined);
          }
        }}
      >
        <img src={currentFrame} alt="" draggable={false} />
      </button>
      {settings.hoverStatusEnabled ? (
        <div className="pet-hover-panel" role="group" aria-label="桌宠快捷操作" aria-hidden={!isHovering}>
          <div className="pet-hover-heading">
            <span aria-hidden />
            <strong>{petIntentLabels[state.currentPetIntent.kind]}</strong>
          </div>
          <div className="pet-hover-metrics">
            {hoverItems.map(({ title, value, Icon }) => (
              <span key={title} title={`${title} ${value}`} aria-label={`${title} ${value}`}>
                <Icon size={12} strokeWidth={2.3} aria-hidden />
                <em>{value}</em>
              </span>
            ))}
          </div>
          <div className="pet-hover-actions">
            <button type="button" title="打开面板" aria-label="打开桌宠面板" onClick={() => onAction?.("open-dashboard")}><LayoutDashboard size={14} /></button>
            <button type="button" title={breakActive ? "结束休息" : "开始休息"} aria-label={breakActive ? "桌宠结束休息" : "桌宠开始休息"} onClick={() => onAction?.("toggle-break")}><Coffee size={14} /></button>
            <button type="button" title="切换动作" aria-label="桌宠切换动作" onClick={cycleAction}><Shuffle size={16} /></button>
            <button type="button" title="桌宠设置" aria-label="打开桌宠设置" onClick={() => onAction?.("open-pet")}><Settings size={14} /></button>
          </div>
        </div>
      ) : null}
    </aside>
  );
};

export const PetCompanion = () => {
  const { bundle, petPacks, actions, activeBreak, setSelectedTab } = useFocusPet();
  const handleAction = (action: PetCompanionAction) => {
    switch (action) {
      case "open-dashboard":
        setSelectedTab("today");
        break;
      case "open-pet":
        setSelectedTab("pet");
        break;
      case "toggle-break":
        actions.toggleBreak();
        break;
    }
  };
  return (
    <PetCompanionRenderer
      state={makePetCompanionViewState(bundle.state, Boolean(activeBreak))}
      petPacks={petPacks}
      onAction={handleAction}
    />
  );
};

const fallbackState = (): PetCompanionViewState => {
  const petPacks = demoPetPackRecords();
  const bundle = emptyRuntime();
  const selectedPackID = petPacks[0]?.id ?? "";
  return makePetCompanionViewState(
    {
      ...bundle.state,
      settings: {
        ...bundle.state.settings,
        pet: {
          ...bundle.state.settings.pet,
          selectedPackID,
          hidden: false,
          audioEnabled: false,
        },
      },
    },
    false,
  );
};

export const PetCompanionWindow = () => {
  const [state, setState] = useState<PetCompanionViewState>(() => fallbackState());
  const [petPacks, setPetPacks] = useState<PetPackRecord[]>(() => demoPetPackRecords());
  const emitAction = async (action: PetCompanionAction) => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    await getCurrentWindow().emitTo("main", "focus-pet-native-menu", {
      action: petActionToNativeMenuAction(action),
    });
  };

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    let unlistenState: (() => void) | undefined;
    let unlistenPacks: (() => void) | undefined;
    void listen<PetCompanionViewState>("focus-pet-companion-state", (event) => setState(event.payload)).then((dispose) => {
      unlistenState = dispose;
    });
    void listen<PetPackRecord[]>("focus-pet-companion-packs", (event) => setPetPacks(event.payload)).then((dispose) => {
      unlistenPacks = dispose;
    });
    return () => {
      unlistenState?.();
      unlistenPacks?.();
    };
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return undefined;
    let unlisten: (() => void) | undefined;
    let landingTimer: number | undefined;
    let latestPosition: { x: number; y: number } | undefined;
    const currentWindow = getCurrentWindow();
    void currentWindow.onMoved((event) => {
      latestPosition = { x: event.payload.x, y: event.payload.y };
      if (landingTimer !== undefined) window.clearTimeout(landingTimer);
      landingTimer = window.setTimeout(() => {
        if (!latestPosition) return;
        void currentWindow.emitTo("main", "focus-pet-companion-moved", {
          ...latestPosition,
          phase: "landing",
        });
      }, 220);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      if (landingTimer !== undefined) window.clearTimeout(landingTimer);
      unlisten?.();
    };
  }, []);

  return <PetCompanionRenderer state={state} petPacks={petPacks} windowMode onAction={(action) => void emitAction(action)} />;
};
