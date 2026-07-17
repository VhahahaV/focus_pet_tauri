import { listen } from "@tauri-apps/api/event";
import { currentMonitor, cursorPosition, getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
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
import { useDocumentTheme } from "../themes";

interface PetCompanionRendererProps {
  state: PetCompanionViewState;
  petPacks: PetPackRecord[];
  windowMode?: boolean;
  onAction?: (action: PetCompanionAction) => void;
}

interface PetDragSession {
  pointerID: number;
  startScreenX: number;
  startScreenY: number;
  origin?: { x: number; y: number };
  scaleFactor: number;
  bounds?: { minX: number; maxX: number; minY: number; maxY: number };
  latestPointer?: { x: number; y: number };
  pendingPosition?: { x: number; y: number };
  frameID?: number;
  moved: boolean;
}

const fallbackPreviewURL = `${import.meta.env.BASE_URL}assets/pet-luo-xiaohei.png`;

type PetCompanionAction = "open-dashboard" | "open-pet";

const placementClass = (placement: PetPlacementMode): string => `placement-${placement}`;

const animationFrameDelay = (fps: number): number => 1000 / Math.max(1, fps);

const petInteractionSize = (petSize: number): number => Math.max(64, Math.min(petSize * 0.72, 116));

const petActionToNativeMenuAction = (action: PetCompanionAction): NativeMenuAction => {
  switch (action) {
    case "open-dashboard":
      return "open-today";
    case "open-pet":
      return "open-pet";
  }
};

export const PetCompanionRenderer = ({ state, petPacks, windowMode = false, onAction }: PetCompanionRendererProps) => {
  const settings = state.petSettings;
  const usesNativeHitTesting = windowMode && "__TAURI_INTERNALS__" in window;
  const [isHovering, setIsHovering] = useState(false);
  const companionRef = useRef<HTMLElement>(null);
  const hitTargetRef = useRef<HTMLButtonElement>(null);
  const hoverPanelRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const hoveringRef = useRef(false);
  const draggingRef = useRef(false);
  const dragSessionRef = useRef<PetDragSession | undefined>(undefined);
  const suppressClickRef = useRef(false);
  const clickTimerRef = useRef<number | undefined>(undefined);
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
  const sourceFps = sourceAction?.fps ?? 8;
  const effectiveFps = isHovering
    ? Math.min(sourceFps, 8)
    : state.currentPetIntent.source === "state"
      ? Math.min(sourceFps, 2)
      : Math.min(sourceFps, 6);
  const frameDelay = animationFrameDelay(effectiveFps);
  const animationKey = `${selectedPack?.id ?? "fallback"}:${sourceAction?.id ?? "preview"}:${state.currentPetIntent.id}`;
  const [frameIndex, setFrameIndex] = useState(0);
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

  const updateHovering = useCallback((value: boolean) => {
    if (hoveringRef.current === value) return;
    hoveringRef.current = value;
    setIsHovering(value);
  }, []);

  const movePetWindow = useCallback((pointerID: number, screenX: number, screenY: number) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerID !== pointerID) return;
    session.latestPointer = { x: screenX, y: screenY };
    if (!session.origin) return;
    const dx = (screenX - session.startScreenX) * session.scaleFactor;
    const dy = (screenY - session.startScreenY) * session.scaleFactor;
    if (!session.moved && Math.hypot(dx, dy) < 1.5 * session.scaleFactor) return;
    if (!session.moved) {
      session.moved = true;
      draggingRef.current = true;
      suppressClickRef.current = true;
      updateHovering(false);
      void getCurrentWindow().emitTo("main", "focus-pet-companion-moved", {
        x: session.origin.x,
        y: session.origin.y,
        phase: "dragging",
      });
    }
    const unclampedX = session.origin.x + dx;
    const unclampedY = session.origin.y + dy;
    session.pendingPosition = {
      x: session.bounds ? Math.max(session.bounds.minX, Math.min(session.bounds.maxX, unclampedX)) : unclampedX,
      y: session.bounds ? Math.max(session.bounds.minY, Math.min(session.bounds.maxY, unclampedY)) : unclampedY,
    };
    if (session.frameID !== undefined) return;
    session.frameID = window.requestAnimationFrame(() => {
      session.frameID = undefined;
      const position = session.pendingPosition;
      session.pendingPosition = undefined;
      if (position) void getCurrentWindow().setPosition(new PhysicalPosition(position.x, position.y)).catch(() => undefined);
    });
  }, [updateHovering]);

  const finishPetDrag = useCallback(async (pointerID: number) => {
    const session = dragSessionRef.current;
    if (!session || session.pointerID !== pointerID) return;
    dragSessionRef.current = undefined;
    if (session.frameID !== undefined) window.cancelAnimationFrame(session.frameID);
    const currentWindow = getCurrentWindow();
    if (session.pendingPosition) {
      await currentWindow.setPosition(new PhysicalPosition(session.pendingPosition.x, session.pendingPosition.y)).catch(() => undefined);
    }
    if (session.moved) {
      const position = await currentWindow.outerPosition().catch(() => session.pendingPosition ?? session.origin);
      if (position) {
        await currentWindow.emitTo("main", "focus-pet-companion-moved", {
          x: position.x,
          y: position.y,
          phase: "landing",
        }).catch(() => undefined);
      }
    }
    draggingRef.current = false;
    window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  }, []);

  useEffect(() => {
    if (!windowMode || !("__TAURI_INTERNALS__" in window)) return undefined;
    const currentWindow = getCurrentWindow();
    let disposed = false;
    let pending = false;
    let ignored: boolean | undefined;
    let windowPosition: { x: number; y: number } | undefined;
    let scaleFactor = 1;
    let unlistenMoved: (() => void) | undefined;
    let lastDirectCaptureAt = 0;

    const contains = (rect: DOMRect, x: number, y: number): boolean =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    const applyCapture = async (capture: boolean) => {
      if (ignored === !capture) return;
      ignored = !capture;
      await currentWindow.setIgnoreCursorEvents(!capture).catch(() => undefined);
    };
    const refresh = async () => {
      if (disposed || pending) return;
      pending = true;
      try {
        windowPosition ??= await currentWindow.outerPosition();
        const cursor = await cursorPosition();
        const x = (cursor.x - windowPosition.x) / scaleFactor;
        const y = (cursor.y - windowPosition.y) / scaleFactor;
        const hitRect = hitTargetRef.current?.getBoundingClientRect();
        const panelRect = hoverPanelRef.current?.getBoundingClientRect();
        const bubbleRect = bubbleRef.current?.getBoundingClientRect();
        const overPet = Boolean(hitRect && contains(hitRect, x, y));
        const overPanel = Boolean(hoveringRef.current && panelRect && contains(panelRect, x, y));
        const overBubble = Boolean(bubbleRect && contains(bubbleRect, x, y));
        const overBridge = Boolean(
          hoveringRef.current && hitRect && panelRect &&
          x >= Math.min(hitRect.left, panelRect.left) - 8 &&
          x <= Math.max(hitRect.right, panelRect.right) + 8 &&
          y >= Math.min(panelRect.bottom, hitRect.top) - 8 &&
          y <= Math.max(panelRect.bottom, hitRect.top) + 8,
        );
        const focusWithin = Boolean(companionRef.current?.contains(document.activeElement));
        const directCapture = overPet || overPanel || overBubble || overBridge || focusWithin;
        const now = performance.now();
        if (directCapture) lastDirectCaptureAt = now;
        const hoverGrace = hoveringRef.current && now - lastDirectCaptureAt < 700;
        const capture = draggingRef.current || directCapture || hoverGrace;
        if (directCapture) updateHovering(true);
        else if (!hoverGrace && !draggingRef.current) updateHovering(false);
        await applyCapture(capture);
      } finally {
        pending = false;
      }
    };

    void Promise.all([currentWindow.outerPosition(), currentWindow.scaleFactor()]).then(([position, factor]) => {
      windowPosition = position;
      scaleFactor = factor;
      void refresh();
    });
    void currentWindow.onMoved((event) => {
      windowPosition = event.payload;
    }).then((dispose) => {
      unlistenMoved = dispose;
    });
    const interval = window.setInterval(() => void refresh(), 16);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      unlistenMoved?.();
      void currentWindow.setIgnoreCursorEvents(false).catch(() => undefined);
    };
  }, [updateHovering, windowMode]);

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
      ref={companionRef}
      className={`pet-companion ${windowMode ? "window-pet" : placementClass(settings.placement)} ${isHovering ? "is-hovering" : ""}`}
      style={{ "--pet-size": `${settings.size}px`, "--pet-hit-size": `${petInteractionSize(settings.size)}px`, "--pet-opacity": settings.opacity } as React.CSSProperties}
      aria-label="桌宠"
      onBlurCapture={(event) => {
        if (!windowMode && !event.currentTarget.contains(event.relatedTarget as Node | null)) updateHovering(false);
      }}
      onFocusCapture={() => updateHovering(true)}
      onPointerEnter={usesNativeHitTesting ? undefined : () => updateHovering(true)}
      onPointerLeave={usesNativeHitTesting ? undefined : () => updateHovering(false)}
    >
      {visibleBubble ? <span ref={bubbleRef} className="floating-pet-bubble">{visibleBubble}</span> : null}
      <button
        ref={hitTargetRef}
        className="pet-avatar-button"
        type="button"
        title={`${petIntentLabels[state.currentPetIntent.kind]} · 拖动桌宠`}
        onClick={(event) => {
          if (!windowMode) return;
          if (suppressClickRef.current) {
            event.preventDefault();
            return;
          }
          if (event.detail > 1) {
            if (clickTimerRef.current !== undefined) window.clearTimeout(clickTimerRef.current);
            onAction?.("open-dashboard");
            return;
          }
          clickTimerRef.current = window.setTimeout(() => {
            setManualBubble(`${petIntentLabels[state.currentPetIntent.kind]} · 专注 ${formatCompactDuration(state.summary.focusSeconds)}`);
          }, 220);
        }}
        onPointerDown={(event) => {
          if (!windowMode || !("__TAURI_INTERNALS__" in window) || event.button !== 0) return;
          const currentWindow = getCurrentWindow();
          dragSessionRef.current = {
            pointerID: event.pointerId,
            startScreenX: event.screenX,
            startScreenY: event.screenY,
            scaleFactor: 1,
            moved: false,
          };
          updateHovering(true);
          void currentWindow.setIgnoreCursorEvents(false).catch(() => undefined);
          void Promise.all([
            currentWindow.outerPosition(),
            currentWindow.outerSize(),
            currentWindow.scaleFactor(),
            currentMonitor(),
          ]).then(([origin, size, factor, monitor]) => {
            const session = dragSessionRef.current;
            if (!session || session.pointerID !== event.pointerId) return;
            session.origin = origin;
            session.scaleFactor = factor;
            if (monitor) {
              const work = monitor.workArea;
              session.bounds = {
                minX: work.position.x,
                maxX: Math.max(work.position.x, work.position.x + work.size.width - size.width),
                minY: work.position.y,
                maxY: Math.max(work.position.y, work.position.y + work.size.height - size.height),
              };
            }
            if (session.latestPointer) movePetWindow(session.pointerID, session.latestPointer.x, session.latestPointer.y);
          }).catch(() => undefined);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event: ReactPointerEvent<HTMLButtonElement>) => {
          movePetWindow(event.pointerId, event.screenX, event.screenY);
        }}
        onPointerUp={(event) => {
          void finishPetDrag(event.pointerId);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          void finishPetDrag(event.pointerId);
        }}
      >
        <img src={currentFrame} alt="" draggable={false} />
      </button>
      {settings.hoverStatusEnabled ? (
        <div
          ref={hoverPanelRef}
          className="pet-hover-panel"
          role="group"
          aria-label="桌宠快捷操作"
          aria-hidden={!isHovering}
          onPointerEnter={() => updateHovering(true)}
        >
          <div className="pet-hover-heading">
            <span aria-hidden />
            <div>
              <small>当前状态</small>
              <strong>{petIntentLabels[state.currentPetIntent.kind]}</strong>
            </div>
          </div>
          <div className="pet-hover-metrics">
            {hoverItems.map(({ title, value, Icon }) => (
              <span key={title} title={`${title} ${value}`} aria-label={`${title} ${value}`}>
                <Icon size={17} strokeWidth={2.2} aria-hidden />
                <span>
                  <small>{title}</small>
                  <em>{value}</em>
                </span>
              </span>
            ))}
          </div>
          <div className="pet-hover-actions">
            <button type="button" title="打开面板" aria-label="打开桌宠面板" onClick={() => onAction?.("open-dashboard")}><LayoutDashboard size={16} /><span>面板</span></button>
            <button type="button" title="切换动作" aria-label="桌宠切换动作" onClick={cycleAction}><Shuffle size={17} /><span>动作</span></button>
            <button type="button" title="桌宠设置" aria-label="打开桌宠设置" onClick={() => onAction?.("open-pet")}><Settings size={16} /><span>设置</span></button>
          </div>
        </div>
      ) : null}
    </aside>
  );
};

export const PetCompanion = () => {
  const { bundle, petPacks, setSelectedTab } = useFocusPet();
  const handleAction = (action: PetCompanionAction) => {
    switch (action) {
      case "open-dashboard":
        setSelectedTab("today");
        break;
      case "open-pet":
        setSelectedTab("pet");
        break;
    }
  };
  return (
    <PetCompanionRenderer
      state={makePetCompanionViewState(bundle.state)}
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
  );
};

export const PetCompanionWindow = () => {
  const [state, setState] = useState<PetCompanionViewState>(() => fallbackState());
  useDocumentTheme(state.theme);
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

  return <PetCompanionRenderer state={state} petPacks={petPacks} windowMode onAction={(action) => void emitAction(action)} />;
};
