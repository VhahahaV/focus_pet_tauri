import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import type {
  AppSettings,
  AppRuntimeState,
  ClassificationCatalogEntry,
  ClassificationRule,
  InstallationSnapshot,
  LocalStoreSnapshot,
  NativeActivitySample,
} from "../core/types";
import { sanitizeWindowTitle } from "../core/activity";
import { ActivityClassifier, loadCatalogEntries } from "../core/classification";
import { activeFocusSession } from "../core/sessions";
import { buildDailySummary } from "../core/summary";
import { inputWorkloadSummary, makeInputTimelineSnapshot } from "../core/timeline";
import { dayBounds } from "../core/utils";
import { makePetIntent } from "../core/pet";
import type { PetPackRecord } from "../resources/petPack";
import { deleteAllData, emptySnapshot, exportSnapshot, loadSnapshot, pruneSnapshotForRetention, saveSnapshot } from "../store/localStore";
import {
  nativeActivitySample,
  nativeAppendLogEntry,
  nativeDrainAgentEvents,
  nativeDataSize,
  nativeDataStoragePath,
  nativeDeletePetPack,
  nativeDeliverNotification,
  nativeCurrentLogFile,
  nativeImportPetPack,
  nativeImportPetPackFromPath,
  nativeInstallationSnapshot,
  nativeListPetPacks,
  nativeOpenLogFolder,
  nativeOpenDataFolder,
  nativeOpenSystemSettings,
  nativePetPackAssets,
  nativePermissionSnapshot,
  nativeSyncWidgetWindows,
  isTauriRuntime,
} from "../store/native";
import { makeMockActivitySample, mockPermissionSnapshot } from "./mockNative";
import {
  advanceRuntime,
  emptyRuntime,
  inputMonitoringPermissionTitle,
  permissionSnapshotForDisplay,
  runtimeActions,
  runtimeFromSnapshot,
  runtimeSnapshot,
  type RuntimeBundle,
} from "./runtime";
import { applyNativeMenuAction, nativeMenuTab, type NativeMenuAction } from "./nativeMenu";
import type { MenuBarPayload } from "./menuBarPayload";
import { makePetCompanionViewState } from "./petCompanionPayload";
import type { DashboardTab } from "./types";
import { applyDesktopWidgetMoved, widgetOrigin, type DesktopWidgetMoveLabel } from "./widgetWindows";

export interface FocusPetAppController {
  bundle: RuntimeBundle;
  ready: boolean;
  catalogEntries: ClassificationCatalogEntry[];
  petPacks: PetPackRecord[];
  selectedTab: DashboardTab;
  setSelectedTab: (tab: DashboardTab) => void;
  activeFocus: ReturnType<typeof activeFocusSession>;
  installationNotice?: InstallationSnapshot;
  actions: {
    tick: () => Promise<void>;
    startFocusSession: (taskName: string, minutes: number) => void;
    finishFocusSession: (completed?: boolean) => void;
    pauseReminders: (minutes?: number) => void;
    resumeReminders: () => void;
    updateSettings: (updater: (settings: AppSettings) => AppSettings) => void;
    addRule: (pattern: string, matchKind: ClassificationRule["matchKind"], category: ClassificationRule["category"]) => void;
    deleteRule: (id: string) => void;
    resetRecognitionRules: () => void;
    refreshRecognitionDiagnostics: () => Promise<void>;
    togglePetHidden: () => void;
    selectPetPack: (packID: string) => void;
    exportData: (redacted?: boolean) => Promise<string>;
    deleteAllData: () => Promise<void>;
    dismissInstallationNotice: () => void;
    openSystemSettings: (destination: string) => Promise<void>;
    requestSystemPermission: (destination: string) => Promise<void>;
    refreshPermissions: () => Promise<void>;
    sendTestNotification: () => Promise<void>;
    openLogFolder: () => Promise<void>;
    openDataFolder: () => Promise<void>;
    copyDataPath: () => Promise<void>;
    openCurrentLogFile: () => Promise<void>;
    copyLogPath: () => Promise<void>;
    writeDiagnosticsLogSnapshot: () => Promise<void>;
    refreshPetPacks: () => Promise<void>;
    importPetPack: () => Promise<void>;
    importPetPackFromPath: (path: string) => Promise<void>;
    deletePetPack: (packID: string) => Promise<void>;
    showPetStatusBubble: () => void;
    testAgentCompletion: () => void;
  };
}

const sampleActivity = async (): Promise<NativeActivitySample> => {
  const native = await nativeActivitySample().catch(() => undefined);
  return native ?? makeMockActivitySample();
};

const recomputeDerived = (state: AppRuntimeState): AppRuntimeState => {
  const now = new Date();
  const bounds = dayBounds(now);
  const retained = pruneSnapshotForRetention(runtimeSnapshot(state), now).snapshot;
  const retainedState = {
    ...state,
    settings: retained.settings,
    classificationRules: retained.classificationRules,
    stateSegments: retained.stateSegments,
    appUsage: retained.appUsage,
    inputActivity: retained.inputActivity,
    focusSessions: retained.focusSessions,
    nudges: retained.nudges,
  };
  return {
    ...retainedState,
    settings: {
      ...retainedState.settings,
      desktopWidgetVisible:
        retainedState.settings.desktopWidget.currentStatusVisible || retainedState.settings.desktopWidget.recentRhythmVisible,
    },
    summary: buildDailySummary(
      now,
      retainedState.stateSegments,
      retainedState.appUsage,
      retainedState.focusSessions,
      retainedState.nudges,
    ),
    todayWorkload: inputWorkloadSummary(retainedState.inputActivity, bounds.start, bounds.end),
  };
};

const mergePetPacks = (base: PetPackRecord[], imported: PetPackRecord[]): PetPackRecord[] => {
  const byID = new Map<string, PetPackRecord>();
  for (const record of [...base, ...imported]) {
    if (!record.id) continue;
    byID.set(record.id, record);
  }
  return [...byID.values()];
};

const visiblePetPacks = (records: PetPackRecord[], hiddenPackIDs: string[]): PetPackRecord[] => {
  const hidden = new Set(hiddenPackIDs);
  return records.filter((record) => !hidden.has(record.id));
};

const petPackNeedsSourceAssets = (record: PetPackRecord): boolean =>
  record.pack.sourceActions.length > 0 && (record.sourceActionAssets?.length ?? 0) === 0;

const ensureSelectedPetPack = (state: AppRuntimeState, records: PetPackRecord[]): AppRuntimeState => {
  if (records.length === 0) {
    // A native pack scan can still be in flight (notably for large Windows packs).
    // Preserve an existing selection and visibility until the scan result is known.
    if (state.settings.pet.selectedPackID) return state;
    return runtimeActions.updateSettings(state, (settings) => ({
      ...settings,
      pet: { ...settings.pet, selectedPackID: "", hidden: true },
    }));
  }
  if (records.some((record) => record.id === state.settings.pet.selectedPackID)) return state;
  return runtimeActions.setSelectedPetPack(state, records[0].id);
};

const importedPackMessage = (records: PetPackRecord[]): string => {
  if (records.length === 1) return `已导入资源包：${records[0].name}`;
  return `已导入 ${records.length} 个资源包：${records.map((record) => record.name).join("、")}`;
};

const importErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("pet pack validation failed")) return `资源包校验失败：${message.replace("pet pack validation failed: ", "")}`;
  if (message.includes("pet pack manifest not found") || message.includes("does not contain pet.json")) return "资源包里没有可导入的 pet.json。";
  if (message.includes("zip")) return `资源包压缩包导入失败：${message}`;
  return `资源包导入失败：${message}`;
};

const startupTimeout = async <T,>(
  promise: Promise<T>,
  milliseconds: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> => {
  let timeoutID: number | undefined;
  return Promise.race([
    promise.finally(() => window.clearTimeout(timeoutID)),
    new Promise<T>((resolve) => {
      timeoutID = window.setTimeout(() => {
        onTimeout();
        resolve(fallback);
      }, milliseconds);
    }),
  ]);
};

type PersistPriority = "interactive" | "sample";
const samplePersistIntervalMilliseconds = 15_000;
const retentionPruneIntervalMilliseconds = 10 * 60_000;

export const useFocusPetApp = (): FocusPetAppController => {
  const [bundle, setBundle] = useState<RuntimeBundle>(() => emptyRuntime());
  const [catalogEntries, setCatalogEntries] = useState<ClassificationCatalogEntry[]>([]);
  const [petPacks, setPetPacks] = useState<PetPackRecord[]>([]);
  const [selectedTab, setSelectedTab] = useState<DashboardTab>("today");
  const [installationNotice, setInstallationNotice] = useState<InstallationSnapshot | undefined>();
  const [ready, setReady] = useState(false);
  const catalogRef = useRef<ClassificationCatalogEntry[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSnapshot = useRef<LocalStoreSnapshot | undefined>(undefined);
  const saveInFlight = useRef<Promise<void> | undefined>(undefined);
  const lastPersistedAt = useRef(0);
  const lastRetentionPruneAt = useRef(Date.now());
  const tickInFlight = useRef<Promise<void> | undefined>(undefined);
  const lastNotificationID = useRef<string | undefined>(undefined);
  const hydratingPetPackIDs = useRef<Set<string>>(new Set());
  const hydratedPetPackIDs = useRef<Set<string>>(new Set());

  const flushPersist = useCallback(async (): Promise<void> => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    if (saveInFlight.current) await saveInFlight.current;

    while (pendingSnapshot.current) {
      const snapshot = pendingSnapshot.current;
      pendingSnapshot.current = undefined;
      const request = saveSnapshot(snapshot).then(() => undefined);
      saveInFlight.current = request;
      try {
        await request;
      } finally {
        if (saveInFlight.current === request) saveInFlight.current = undefined;
        lastPersistedAt.current = Date.now();
      }
    }
  }, []);

  const persist = useCallback((snapshot: LocalStoreSnapshot, priority: PersistPriority = "interactive") => {
    pendingSnapshot.current = snapshot;
    window.clearTimeout(saveTimer.current);
    const elapsed = Date.now() - lastPersistedAt.current;
    const delay = priority === "sample"
      ? Math.max(700, samplePersistIntervalMilliseconds - elapsed)
      : 350;
    saveTimer.current = window.setTimeout(() => {
      void flushPersist();
    }, delay);
  }, [flushPersist]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") void flushPersist();
    };
    const flushOnPageHide = () => void flushPersist();
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("pagehide", flushOnPageHide);
      void flushPersist();
    };
  }, [flushPersist]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const warnings: string[] = [];
      const rememberWarning = (message: string) => {
        warnings.push(message);
      };
      try {
        const [loadedSnapshot, entries, importedPacks] = await Promise.all([
          startupTimeout(loadSnapshot(), 4000, undefined, () => {
            rememberWarning("本地状态读取超时，已先使用空白状态启动。");
          }).catch((error) => {
            rememberWarning(`本地状态读取失败，已使用空白状态启动：${error instanceof Error ? error.message : String(error)}`);
            return undefined;
          }),
          startupTimeout(loadCatalogEntries(), 1800, [] as ClassificationCatalogEntry[], () => {
            rememberWarning("识别目录读取超时，已先使用兜底规则启动。");
          }).catch((error) => {
            rememberWarning(`识别目录读取失败，已使用兜底规则启动：${error instanceof Error ? error.message : String(error)}`);
            return [] as ClassificationCatalogEntry[];
          }),
          startupTimeout(nativeListPetPacks(), 8000, [] as PetPackRecord[], () => {
            rememberWarning("本地桌宠资源读取超时，已先隐藏桌宠启动。");
          }).catch((error) => {
            rememberWarning(`本地桌宠资源读取失败，已隐藏桌宠：${error instanceof Error ? error.message : String(error)}`);
            return [] as PetPackRecord[];
          }),
        ]);
        if (cancelled) return;
        catalogRef.current = entries;
        setCatalogEntries(entries);
        const initial = runtimeFromSnapshot(loadedSnapshot ?? emptySnapshot(), entries);
        const availablePetPacks = visiblePetPacks(importedPacks, initial.state.settings.pet.hiddenPackIDs);
        setPetPacks(availablePetPacks);
        const [permissionSnapshot, dataSizeBytes, installationSnapshot] = await Promise.all([
          startupTimeout(nativePermissionSnapshot(), 900, undefined, () => undefined).catch(() => undefined),
          startupTimeout(nativeDataSize(), 900, 0, () => undefined).catch(() => 0),
          startupTimeout(nativeInstallationSnapshot(), 900, undefined, () => undefined).catch(() => undefined),
        ]);
        if (!cancelled && installationSnapshot && shouldShowInstallationNotice(installationSnapshot)) {
          setInstallationNotice(installationSnapshot);
        }
        const state = ensureSelectedPetPack(
          {
            ...initial.state,
            permissionSnapshot: permissionSnapshotForDisplay(permissionSnapshot ?? mockPermissionSnapshot()),
            dataSizeBytes,
            statusMessage: warnings[0] ?? initial.state.statusMessage,
          },
          availablePetPacks,
        );
        if (cancelled) return;
        setBundle({
          ...initial,
          state,
        });
      } catch (error) {
        if (cancelled) return;
        const fallback = emptyRuntime();
        setCatalogEntries([]);
        setPetPacks([]);
        setInstallationNotice(undefined);
        setBundle({
          ...fallback,
          state: {
            ...fallback.state,
            statusMessage: `启动初始化失败，已使用空白状态：${error instanceof Error ? error.message : String(error)}`,
          },
        });
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const mutate = useCallback(
    (updater: (state: AppRuntimeState) => AppRuntimeState) => {
      setBundle((current) => {
        const nextState = recomputeDerived(updater(current.state));
        const next = { ...current, state: nextState };
        persist(runtimeSnapshot(nextState));
        return next;
      });
    },
    [persist],
  );

  const tick = useCallback((): Promise<void> => {
    if (tickInFlight.current) return tickInFlight.current;
    const request = (async () => {
      const sample = await sampleActivity();
      setBundle((current) => {
        const next = advanceRuntime(current, sample, catalogRef.current);
        const shouldPrune = Date.now() - lastRetentionPruneAt.current >= retentionPruneIntervalMilliseconds;
        const nextState = shouldPrune ? recomputeDerived(next.state) : next.state;
        if (shouldPrune) lastRetentionPruneAt.current = Date.now();
        persist(runtimeSnapshot(nextState), "sample");
        return { ...next, state: nextState };
      });
    })();
    tickInFlight.current = request;
    void request.finally(() => {
      if (tickInFlight.current === request) tickInFlight.current = undefined;
    });
    return request;
  }, [persist]);

  const refreshRecognitionDiagnostics = useCallback(async () => {
    const sample = await sampleActivity();
    mutate((state) => {
      const classifier = new ActivityClassifier(state.classificationRules, catalogRef.current);
      const category = classifier.classify(sample.appName, sample.bundleID, sample.windowTitle);
      const sanitizedTitle = sanitizeWindowTitle(sample.windowTitle, state.settings.privacy);
      return {
        ...state,
        recognitionDiagnostic: {
          sampledAt: sample.timestamp,
          appName: sample.appName,
          bundleID: sample.bundleID,
          windowTitle: sanitizedTitle.rawTitle ?? sanitizedTitle.titleDisplay,
          category,
          catalogEntryCount: catalogRef.current.length,
          defaultRuleCount: classifier.defaultRules.length,
          userRuleCount: state.classificationRules.length,
          inputMonitoringStatus: inputMonitoringPermissionTitle(sample.inputMonitoringStatus),
          recordingPaused: state.settings.privacy.pauseActivityRecording,
        },
        statusMessage: "识别诊断已刷新。",
      };
    });
  }, [mutate]);

  const refreshPermissionStatus = useCallback(
    async (statusMessage = "权限状态已刷新。") => {
      const [permissionSnapshot, dataSizeBytes] = await Promise.all([
        nativePermissionSnapshot().catch(() => undefined),
        nativeDataSize().catch(() => 0),
      ]);
      mutate((state) => ({
        ...state,
        permissionSnapshot: permissionSnapshotForDisplay(permissionSnapshot ?? mockPermissionSnapshot()),
        dataSizeBytes,
        statusMessage,
      }));
    },
    [mutate],
  );

  const refreshPetPacks = useCallback(async () => {
    try {
      const importedPacks = await nativeListPetPacks();
      hydratedPetPackIDs.current.clear();
      const availablePetPacks = visiblePetPacks(importedPacks, bundle.state.settings.pet.hiddenPackIDs);
      setPetPacks(availablePetPacks);
      mutate((state) => {
        const availableForCurrentState = visiblePetPacks(importedPacks, state.settings.pet.hiddenPackIDs);
        return {
          ...ensureSelectedPetPack(state, availableForCurrentState),
          statusMessage: availableForCurrentState.length > 0 ? "桌宠资源包已刷新。" : "暂无桌宠资源包。",
        };
      });
    } catch (error) {
      setPetPacks([]);
      mutate((state) => ({
        ...ensureSelectedPetPack(state, []),
        statusMessage: `本地桌宠资源读取失败，已隐藏桌宠：${error instanceof Error ? error.message : String(error)}`,
      }));
    }
  }, [bundle.state.settings.pet.hiddenPackIDs, mutate]);

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return undefined;
    const hydratingIDs = hydratingPetPackIDs.current;
    const hydratedIDs = hydratedPetPackIDs.current;
    const selectedPackID = bundle.state.settings.pet.selectedPackID || petPacks[0]?.id;
    if (!selectedPackID || hydratingIDs.has(selectedPackID) || hydratedIDs.has(selectedPackID)) {
      return undefined;
    }
    const selectedPack = petPacks.find((record) => record.id === selectedPackID);
    if (!selectedPack || !petPackNeedsSourceAssets(selectedPack)) return undefined;

    let cancelled = false;
    hydratingIDs.add(selectedPackID);
    void nativePetPackAssets(selectedPackID)
      .then((assets) => {
        if (cancelled) return;
        hydratedIDs.add(selectedPackID);
        setPetPacks((records) =>
          records.map((record) => (record.id === selectedPackID ? { ...record, sourceActionAssets: assets } : record)),
        );
      })
      .catch((error) => {
        if (cancelled) return;
        mutate((state) => ({
          ...state,
          statusMessage: `桌宠帧资源读取失败：${error instanceof Error ? error.message : String(error)}`,
        }));
      })
      .finally(() => {
        hydratingIDs.delete(selectedPackID);
      });

    return () => {
      cancelled = true;
      hydratingIDs.delete(selectedPackID);
    };
  }, [bundle.state.settings.pet.selectedPackID, mutate, petPacks, ready]);

  const handleNativeMenuAction = useCallback(
    (action: NativeMenuAction) => {
      const tab = nativeMenuTab(action);
      if (tab) setSelectedTab(tab);
      mutate((state) => applyNativeMenuAction(state, action) ?? state);
    },
    [mutate],
  );

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return undefined;
    let unlisten: (() => void) | undefined;
    void listen<{ action: NativeMenuAction }>("focus-pet-native-menu", (event) => {
      handleNativeMenuAction(event.payload.action);
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [handleNativeMenuAction, ready]);

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return undefined;
    let disposed = false;
    let polling = false;
    const pollAgentEvents = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        const events = await nativeDrainAgentEvents();
        for (const event of events) {
          if (disposed) return;
          mutate((state) => runtimeActions.transientPetIntent(
            state,
            "taskCompleted",
            event.message,
            "agent",
            12_000,
          ));
          void nativeDeliverNotification(event.title, event.message).catch(() => false);
        }
      } catch {
        // Agent integrations are optional; polling failures must not disturb activity tracking.
      } finally {
        polling = false;
      }
    };
    void pollAgentEvents();
    const interval = window.setInterval(() => void pollAgentEvents(), 1500);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [mutate, ready]);

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return undefined;
    let unlisten: (() => void) | undefined;
    void listen<{ label: DesktopWidgetMoveLabel; x: number; y: number }>("focus-pet-widget-moved", (event) => {
      mutate((state) => {
        return applyDesktopWidgetMoved(state, event.payload.label, { x: event.payload.x, y: event.payload.y });
      });
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [mutate, ready]);

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return undefined;
    let unlisten: (() => void) | undefined;
    void listen<{ x: number; y: number; phase?: "dragging" | "landing" }>("focus-pet-companion-moved", (event) => {
      mutate((state) => {
        if (event.payload.phase === "dragging") {
          return {
            ...state,
            currentPetIntent: makePetIntent("dragged", "physicalInteraction", {
              startedAt: new Date().toISOString(),
              interruptible: false,
            }),
          };
        }
        return runtimeActions.transientPetIntent(
          runtimeActions.updateSettings(state, (settings) => ({
            ...settings,
            pet: {
              ...settings.pet,
              placement: "custom",
              customOriginX: event.payload.x,
              customOriginY: event.payload.y,
            },
          })),
          "landing",
          "放在这里。",
          "physicalInteraction",
          1500,
        );
      });
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => unlisten?.();
  }, [mutate, ready]);

  const desktopWidgetSettings = bundle.state.settings.desktopWidget;
  const petSettings = bundle.state.settings.pet;
  const petCompanionStateRef = useRef(makePetCompanionViewState(bundle.state));
  const petPacksRef = useRef(petPacks);
  const petHiddenRef = useRef(petSettings.hidden);
  const widgetWindowSyncArgsRef = useRef<Parameters<typeof nativeSyncWidgetWindows>>([
    desktopWidgetSettings.currentStatusVisible,
    desktopWidgetSettings.recentRhythmVisible,
    widgetOrigin(desktopWidgetSettings.currentStatusOrigin),
    widgetOrigin(desktopWidgetSettings.recentRhythmOrigin),
    !petSettings.hidden,
    petSettings.size,
    petSettings.placement,
    undefined,
  ]);
  petCompanionStateRef.current = makePetCompanionViewState(bundle.state);
  petPacksRef.current = petPacks;
  petHiddenRef.current = petSettings.hidden;
  widgetWindowSyncArgsRef.current = [
    desktopWidgetSettings.currentStatusVisible,
    desktopWidgetSettings.recentRhythmVisible,
    widgetOrigin(desktopWidgetSettings.currentStatusOrigin),
    widgetOrigin(desktopWidgetSettings.recentRhythmOrigin),
    !petSettings.hidden,
    petSettings.size,
    petSettings.placement,
    petSettings.placement === "custom" && petSettings.customOriginX !== undefined && petSettings.customOriginY !== undefined
      ? { x: petSettings.customOriginX, y: petSettings.customOriginY }
      : undefined,
  ];

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("focus-pet-companion-ready", () => {
      if (petHiddenRef.current) return;
      void emitTo("widget-pet-companion", "focus-pet-companion-state", petCompanionStateRef.current);
      void emitTo("widget-pet-companion", "focus-pet-companion-packs", petPacksRef.current);
      // WebView2 can apply a cascade position while the transparent companion
      // is loading. Re-sync once the companion confirms that its DOM is ready.
      void nativeSyncWidgetWindows(...widgetWindowSyncArgsRef.current);
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const timeoutID = window.setTimeout(() => {
      void nativeSyncWidgetWindows(
        desktopWidgetSettings.currentStatusVisible,
        desktopWidgetSettings.recentRhythmVisible,
        widgetOrigin(desktopWidgetSettings.currentStatusOrigin),
        widgetOrigin(desktopWidgetSettings.recentRhythmOrigin),
        !petSettings.hidden,
        petSettings.size,
        petSettings.placement,
        petSettings.placement === "custom" && petSettings.customOriginX !== undefined && petSettings.customOriginY !== undefined
          ? {
              x: petSettings.customOriginX,
              y: petSettings.customOriginY,
            }
          : undefined,
      ).catch((error) => {
        mutate((state) => ({
          ...state,
          statusMessage: `桌宠窗口同步失败：${error instanceof Error ? error.message : String(error)}`,
        }));
      });
    }, 220);
    return () => window.clearTimeout(timeoutID);
  }, [
    ready,
    desktopWidgetSettings.currentStatusVisible,
    desktopWidgetSettings.recentRhythmVisible,
    desktopWidgetSettings.currentStatusOrigin,
    desktopWidgetSettings.recentRhythmOrigin,
    petSettings.hidden,
    petSettings.placement,
    petSettings.customOriginX,
    petSettings.customOriginY,
    petSettings.size,
    mutate,
  ]);

  useEffect(() => {
    if (!ready) return undefined;
    void tick();
    const interval = window.setInterval(() => {
      void tick();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [ready, tick]);

  const activeFocus = activeFocusSession(bundle.state.focusSessions);

  const widgetTimelines = useMemo(() => {
    const needsCurrent = desktopWidgetSettings.currentStatusVisible;
    const needsRecent = desktopWidgetSettings.recentRhythmVisible;
    if (!needsCurrent && !needsRecent) return undefined;
    const now = new Date();
    const recentRhythms = needsRecent
      ? {
          4: makeInputTimelineSnapshot(4 * 60 * 60, bundle.state.stateSegments, bundle.state.appUsage, bundle.state.inputActivity, now, true, false),
          8: makeInputTimelineSnapshot(8 * 60 * 60, bundle.state.stateSegments, bundle.state.appUsage, bundle.state.inputActivity, now, true, false),
          12: makeInputTimelineSnapshot(12 * 60 * 60, bundle.state.stateSegments, bundle.state.appUsage, bundle.state.inputActivity, now, true, false),
        }
      : undefined;
    const selectedHours = [4, 8, 12].includes(desktopWidgetSettings.recentRhythmWindowHours)
      ? desktopWidgetSettings.recentRhythmWindowHours as 4 | 8 | 12
      : 4;
    const inputTimeline = needsCurrent
      ? recentRhythms?.[12] ?? makeInputTimelineSnapshot(12 * 60 * 60, bundle.state.stateSegments, bundle.state.appUsage, bundle.state.inputActivity, now, true, false)
      : recentRhythms?.[selectedHours];
    return inputTimeline ? { inputTimeline, recentRhythms } : undefined;
  }, [
    bundle.state.appUsage,
    bundle.state.inputActivity,
    bundle.state.stateSegments,
    desktopWidgetSettings.currentStatusVisible,
    desktopWidgetSettings.recentRhythmVisible,
    desktopWidgetSettings.recentRhythmWindowHours,
  ]);

  useEffect(() => {
    const nudge = bundle.latestNudge;
    if (!ready || !nudge || !bundle.state.settings.reminder.enableSystemNotifications) return;
    if (lastNotificationID.current === nudge.id) return;
    lastNotificationID.current = nudge.id;
    void nativeDeliverNotification("Focus Pet", nudge.message).catch(() => false);
  }, [bundle.latestNudge, bundle.state.settings.reminder.enableSystemNotifications, ready]);

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return;
    const widgetPayload = widgetTimelines ? {
      theme: bundle.state.settings.appearance.theme,
      currentDecision: bundle.state.currentDecision,
      summary: bundle.state.summary,
      todayWorkload: bundle.state.todayWorkload,
      currentSnapshot: bundle.state.currentSnapshot,
      inputTimeline: widgetTimelines.inputTimeline,
      recentRhythms: widgetTimelines.recentRhythms,
      selectedRecentRhythmWindowHours: bundle.state.settings.desktopWidget.recentRhythmWindowHours,
      statusMessage: bundle.state.statusMessage,
      latestPetBubble: bundle.state.latestPetBubble,
      movementMode: bundle.state.settings.desktopWidget.movementMode,
    } : undefined;
    const menuBarPayload: MenuBarPayload = {
      currentDecision: bundle.state.currentDecision,
      summary: bundle.state.summary,
      currentSnapshot: bundle.state.currentSnapshot,
      settings: bundle.state.settings,
      statusMessage: bundle.state.statusMessage,
      latestPetBubble: bundle.state.latestPetBubble,
      activeFocus: activeFocus ? { id: activeFocus.id, taskName: activeFocus.taskName } : undefined,
      hasAvailablePetPacks: petPacks.length > 0,
    };
    if (desktopWidgetSettings.currentStatusVisible && widgetPayload) {
      void emitTo("widget-current-status", "focus-pet-widget-state", widgetPayload);
    }
    if (desktopWidgetSettings.recentRhythmVisible && widgetPayload) {
      void emitTo("widget-recent-rhythm", "focus-pet-widget-state", widgetPayload);
    }
    if (!petSettings.hidden) {
      void emitTo(
        "widget-pet-companion",
        "focus-pet-companion-state",
        makePetCompanionViewState(bundle.state),
      );
    }
    void emitTo("widget-menu-bar", "focus-pet-menu-bar-state", menuBarPayload);
  }, [
    activeFocus,
    bundle,
    desktopWidgetSettings.currentStatusVisible,
    desktopWidgetSettings.recentRhythmVisible,
    petPacks.length,
    petSettings.hidden,
    ready,
    widgetTimelines,
  ]);

  useEffect(() => {
    if (!ready || !isTauriRuntime() || petSettings.hidden) return;
    void emitTo("widget-pet-companion", "focus-pet-companion-packs", petPacks);
  }, [petPacks, petSettings.hidden, ready]);

  const actions = useMemo<FocusPetAppController["actions"]>(
    () => ({
      tick,
      startFocusSession(taskName, minutes) {
        mutate((state) => runtimeActions.startFocusSession(state, taskName, minutes));
      },
      finishFocusSession(completed = true) {
        mutate((state) => runtimeActions.finishFocusSession(state, completed));
      },
      pauseReminders(minutes) {
        mutate((state) => runtimeActions.pauseReminders(state, minutes));
      },
      resumeReminders() {
        mutate(runtimeActions.resumeReminders);
      },
      updateSettings(updater) {
        mutate((state) => runtimeActions.updateSettings(state, updater));
      },
      addRule(pattern, matchKind, category) {
        mutate((state) => runtimeActions.addRule(state, pattern, matchKind, category));
      },
      deleteRule(id) {
        mutate((state) => runtimeActions.deleteRule(state, id));
      },
      resetRecognitionRules() {
        mutate(runtimeActions.resetRecognitionRules);
      },
      async refreshRecognitionDiagnostics() {
        await refreshRecognitionDiagnostics();
      },
      togglePetHidden() {
        mutate(runtimeActions.togglePetHidden);
        // Persist visibility before creating or hiding the native window. This
        // keeps the user's choice durable even if WebView2 delays background timers.
        window.setTimeout(() => void flushPersist(), 0);
      },
      selectPetPack(packID) {
        mutate((state) => runtimeActions.setSelectedPetPack(state, packID));
      },
      async exportData(redacted = false) {
        const url = await exportSnapshot(runtimeSnapshot(bundle.state), redacted);
        mutate((state) => ({ ...state, statusMessage: redacted ? "已导出脱敏数据。" : "已导出完整数据。" }));
        return url;
      },
      async deleteAllData() {
        await deleteAllData();
        mutate(runtimeActions.clearDataState);
      },
      dismissInstallationNotice() {
        if (installationNotice) {
          markInstallationNoticeShown(installationNotice.buildIdentifier);
        }
        setInstallationNotice(undefined);
      },
      async openSystemSettings(destination) {
        await nativeOpenSystemSettings(destination);
      },
      async requestSystemPermission(destination) {
        if (destination === "notifications") {
          const delivered = await nativeDeliverNotification("Focus Pet", "这是一条 Focus Pet 权限测试通知。");
          await refreshPermissionStatus(delivered ? "已请求通知权限。" : "通知权限请求失败，请检查系统通知权限。");
          return;
        }
        await nativeOpenSystemSettings(destination);
        await refreshPermissionStatus(destination === "inputMonitoring" ? "已打开系统输入监控设置。" : "已打开系统设置。");
      },
      async refreshPermissions() {
        await refreshPermissionStatus();
      },
      async sendTestNotification() {
        const delivered = await nativeDeliverNotification("Focus Pet", "这是一条 Focus Pet 测试通知。");
        await refreshPermissionStatus(delivered ? "测试通知已发送。" : "测试通知发送失败，请检查系统通知权限。");
      },
      async openLogFolder() {
        await nativeOpenLogFolder();
      },
      async openDataFolder() {
        const opened = await nativeOpenDataFolder();
        mutate((state) => ({ ...state, statusMessage: opened ? "已打开本机数据目录。" : "当前环境无法打开数据目录。" }));
      },
      async copyDataPath() {
        const path = await nativeDataStoragePath();
        if (path) {
          await navigator.clipboard?.writeText(path).catch(() => undefined);
        }
        mutate((state) => ({ ...state, statusMessage: path ? `已复制数据目录：${path}` : "浏览器预览使用浏览器本地存储。" }));
      },
      async openCurrentLogFile() {
        const path = await nativeCurrentLogFile(true);
        mutate((state) => ({ ...state, statusMessage: path ? "已打开当前日志文件。" : "当前环境无法打开日志文件。" }));
      },
      async copyLogPath() {
        const path = await nativeCurrentLogFile(false);
        if (path) {
          await navigator.clipboard?.writeText(path).catch(() => undefined);
        }
        mutate((state) => ({ ...state, statusMessage: path ? "已复制日志文件路径。" : "当前环境无法复制日志路径。" }));
      },
      async writeDiagnosticsLogSnapshot() {
        const state = bundle.state;
        mutate(runtimeActions.writeDiagnosticSnapshot);
        if (!state.settings.logging.isEnabled) return;
        const path = await nativeAppendLogEntry({
          kind: "diagnostic",
          time: new Date().toISOString(),
          state: state.currentDecision.state,
          app: state.currentSnapshot.appName,
          reason: state.currentDecision.reason,
          inputMonitoringStatus: state.permissionSnapshot.inputMonitoring,
        }).catch(() => undefined);
        mutate((current) => ({
          ...current,
          statusMessage: path ? "诊断快照已写入本机日志。" : "诊断日志写入失败，请检查数据目录权限。",
        }));
      },
      async refreshPetPacks() {
        await refreshPetPacks();
      },
      async importPetPack() {
        try {
          const imported = await nativeImportPetPack();
          if (!imported || imported.length === 0) {
            mutate((state) => ({ ...state, statusMessage: "当前环境无法打开资源包选择器。" }));
            return;
          }
          setPetPacks((records) => mergePetPacks(records, imported));
          mutate((state) => ({
            ...runtimeActions.setSelectedPetPack(
              runtimeActions.unhidePetPacks(state, imported.map((record) => record.id)),
              imported[0].id,
            ),
            statusMessage: importedPackMessage(imported),
          }));
        } catch (error) {
          mutate((state) => ({ ...state, statusMessage: importErrorMessage(error) }));
        }
      },
      async importPetPackFromPath(path) {
        try {
          const imported = await nativeImportPetPackFromPath(path);
          if (!imported || imported.length === 0) {
            mutate((state) => ({ ...state, statusMessage: "当前环境无法按路径导入资源包。" }));
            return;
          }
          setPetPacks((records) => mergePetPacks(records, imported));
          mutate((state) => ({
            ...runtimeActions.setSelectedPetPack(
              runtimeActions.unhidePetPacks(state, imported.map((record) => record.id)),
              imported[0].id,
            ),
            statusMessage: importedPackMessage(imported),
          }));
        } catch (error) {
          mutate((state) => ({ ...state, statusMessage: importErrorMessage(error) }));
        }
      },
      async deletePetPack(packID) {
        const record = petPacks.find((item) => item.id === packID);
        if (record?.path) {
          const deleted = await nativeDeletePetPack(packID);
          if (!deleted) {
            mutate((state) => ({ ...state, statusMessage: "当前资源包不可删除或不存在。" }));
            return;
          }
        }
        const nextRecords = petPacks.filter((record) => record.id !== packID);
        setPetPacks(nextRecords);
        setBundle((current) => {
          const nextState = {
            ...recomputeDerived(ensureSelectedPetPack(runtimeActions.hidePetPack(current.state, packID), nextRecords)),
            statusMessage: record?.path ? "桌宠资源包已删除。" : "桌宠资源包已隐藏。",
          };
          persist(runtimeSnapshot(nextState));
          return { ...current, state: nextState };
        });
      },
      showPetStatusBubble() {
        mutate((state) => runtimeActions.transientPetIntent(state));
      },
      testAgentCompletion() {
        const message = "Codex 已完成：Focus Pet 智能体通知测试";
        mutate((state) => runtimeActions.transientPetIntent(state, "taskCompleted", message, "agent", 12_000));
        void nativeDeliverNotification("任务已完成", message).catch(() => false);
      },
    }),
    [
      bundle.state,
      flushPersist,
      installationNotice,
      mutate,
      persist,
      petPacks,
      refreshPermissionStatus,
      refreshRecognitionDiagnostics,
      refreshPetPacks,
      tick,
    ],
  );

  return {
    bundle,
    ready,
    catalogEntries,
    petPacks,
    selectedTab,
    setSelectedTab,
    activeFocus,
    installationNotice,
    actions,
  };
};

const installationNoticeStorageKey = "focus-pet-last-install-notice-build";

const shouldShowInstallationNotice = (snapshot: InstallationSnapshot): boolean => {
  if (snapshot.isRunningFromMountedVolume) return true;
  if (!snapshot.isInstalled) return false;
  try {
    return localStorage.getItem(installationNoticeStorageKey) !== snapshot.buildIdentifier;
  } catch {
    return true;
  }
};

const markInstallationNoticeShown = (buildIdentifier: string): void => {
  try {
    localStorage.setItem(installationNoticeStorageKey, buildIdentifier);
  } catch {
    // Browser storage can be unavailable in restricted preview contexts.
  }
};
