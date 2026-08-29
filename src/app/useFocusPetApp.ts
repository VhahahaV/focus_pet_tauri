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
  NativeRuntimeEnvelope,
} from "../core/types";
import { sanitizeWindowTitle } from "../core/activity";
import { ActivityClassifier, loadCatalogEntries } from "../core/classification";
import { activeFocusSession } from "../core/sessions";
import { buildDailySummary } from "../core/summary";
import { inputWorkloadSummary, makeInputTimelineSnapshot } from "../core/timeline";
import { dayBounds } from "../core/utils";
import { intentKindForState, makePetIntent } from "../core/pet";
import { codexBubble, onlyActiveCodexSessions, reduceActiveCodexEvents, reduceCodexEvents, type CodexIntegrationStatus, type CodexSessionSnapshot, type CodexSyncPreferences, type SshConnectionStatus, type SshHostCandidate, type SshHostDiagnostic } from "../core/codexSessions";
import type { PetPackRecord } from "../resources/petPack";
import { emptySnapshot, loadSnapshot, normalizeSnapshot, saveSnapshot } from "../store/localStore";
import {
  nativeActivitySample,
  nativeConnectCodexSshHost,
  nativeCodexSshConnectionStatus,
  nativeCodexIntegrationStatus,
  nativeSetCodexSyncPreferences,
  nativeCodexSessionSnapshot,
  nativeDiscoverCodexSshHosts,
  nativeForgetCodexSshHost,
  nativeDiagnoseCodexSshHost,
  nativeInstallCodexHooks,
  nativePollCodexManagedStatus,
  nativeProvisionCodexSshHost,
  nativeSaveCodexSshHost,
  nativeStartCodexManagedDaemon,
  nativeUninstallCodexSshHost,
  nativeUninstallCodexHooks,
  nativeDrainAgentEvents,
  nativeDeletePetPack,
  nativeDeliverNotification,
  nativeImportPetPack,
  nativeImportPetPackFromPath,
  nativeInstallationSnapshot,
  nativeListPetPacks,
  nativePetPackAssets,
  nativeRuntimeSnapshot,
  nativeSetClassificationRules,
  nativeSyncWidgetWindows,
  isTauriRuntime,
} from "../store/native";
import { activitySampleForRuntime } from "./activitySampling";
import {
  advanceRuntime,
  emptyRuntime,
  inputMonitoringPermissionTitle,
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
import { mergeNativeRuntimeDelta } from "./nativeRuntimeDelta";

export interface FocusPetAppController {
  bundle: RuntimeBundle;
  ready: boolean;
  catalogEntries: ClassificationCatalogEntry[];
  petPacks: PetPackRecord[];
  selectedTab: DashboardTab;
  setSelectedTab: (tab: DashboardTab) => void;
  activeFocus: ReturnType<typeof activeFocusSession>;
  codexSessions: CodexSessionSnapshot[];
  codexIntegration?: CodexIntegrationStatus;
  codexManagedStatusEnabled: boolean;
  codexSshHosts: SshHostCandidate[];
  codexSshConnections: SshConnectionStatus[];
  codexSshDiagnostics: Record<string, SshHostDiagnostic>;
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
    dismissInstallationNotice: () => void;
    refreshPetPacks: () => Promise<void>;
    importPetPack: () => Promise<void>;
    importPetPackFromPath: (path: string) => Promise<void>;
    deletePetPack: (packID: string) => Promise<void>;
    showPetStatusBubble: () => void;
    testAgentCompletion: () => void;
    refreshCodexIntegration: () => Promise<void>;
    enableCodexManagedStatus: () => Promise<void>;
    installCodexHooks: () => Promise<void>;
    uninstallCodexHooks: () => Promise<void>;
    copyCodexHookCommand: () => Promise<void>;
    copyCodexStandaloneInstallCommand: () => Promise<void>;
    updateCodexSyncPreferences: (preferences: CodexSyncPreferences) => Promise<void>;
    discoverCodexSshHosts: () => Promise<void>;
    saveCodexSshHost: (host: SshHostCandidate) => Promise<void>;
    forgetCodexSshHost: (alias: string) => Promise<void>;
    diagnoseCodexSshHost: (alias: string) => Promise<void>;
    provisionCodexSshHost: (alias: string) => Promise<void>;
    uninstallCodexSshHost: (alias: string) => Promise<void>;
  };
}

const sampleActivity = async (): Promise<NativeActivitySample | undefined> => {
  const native = await nativeActivitySample().catch(() => undefined);
  return activitySampleForRuntime(native, isTauriRuntime());
};

const recomputeDerived = (state: AppRuntimeState): AppRuntimeState => {
  const now = new Date();
  const bounds = dayBounds(now);
  // Snapshots are normalized once at the storage/native boundary. Repeating
  // that pass here mapped every retained input bucket on every five-second
  // sample and made interactions degrade with history length.
  const normalizedState = state;
  return {
    ...normalizedState,
    settings: {
      ...normalizedState.settings,
      desktopWidgetVisible:
        normalizedState.settings.desktopWidget.currentStatusVisible || normalizedState.settings.desktopWidget.recentRhythmVisible,
    },
    summary: buildDailySummary(
      now,
      normalizedState.stateSegments,
      normalizedState.appUsage,
      normalizedState.focusSessions,
      normalizedState.nudges,
      normalizedState.breakSessions,
    ),
    todayWorkload: inputWorkloadSummary(normalizedState.inputActivity, bounds.start, bounds.end),
  };
};

const applyNativeRuntimeEnvelope = (
  current: RuntimeBundle,
  envelope: NativeRuntimeEnvelope,
): RuntimeBundle => {
  const normalized = envelope.snapshot
    ? normalizeSnapshot(envelope.snapshot)
    : mergeNativeRuntimeDelta(runtimeSnapshot(current.state), envelope.delta);
  const now = new Date(envelope.currentDecision.timestamp);
  const stateChanged = current.state.currentDecision.state !== envelope.currentDecision.state;
  const intentExpired = current.state.currentPetIntent.expiresAt
    ? new Date(current.state.currentPetIntent.expiresAt) <= now
    : false;
  let currentPetIntent = intentExpired
    ? makePetIntent(intentKindForState(envelope.currentDecision.state), "state", {
        startedAt: envelope.currentDecision.timestamp,
      })
    : current.state.currentPetIntent;
  let latestPetBubble = intentExpired ? undefined : current.state.latestPetBubble;
  const isNewNudge = envelope.latestNudge && envelope.latestNudge.id !== current.latestNudge?.id;
  const protectedIntentActive = !intentExpired
    && (currentPetIntent.source === "physicalInteraction" || currentPetIntent.source === "agent");
  if (isNewNudge && envelope.latestNudge && !protectedIntentActive) {
    const visibleMilliseconds = envelope.latestNudge.reason === "breakEnding" ? 6_000 : 22_000;
    currentPetIntent = makePetIntent(envelope.latestNudge.petIntent, "nudge", {
      startedAt: envelope.latestNudge.time,
      expiresAt: new Date(new Date(envelope.latestNudge.time).getTime() + visibleMilliseconds).toISOString(),
      message: envelope.latestNudge.message,
    });
    latestPetBubble = envelope.latestNudge.message;
  } else if (currentPetIntent.source === "state") {
    currentPetIntent = makePetIntent(intentKindForState(envelope.currentDecision.state), "state", {
      startedAt: stateChanged ? envelope.currentDecision.timestamp : currentPetIntent.startedAt,
    });
  }
  return {
    ...current,
    latestNudge: envelope.latestNudge ?? current.latestNudge,
    state: recomputeDerived({
      ...current.state,
      ...normalized,
      // Settings and classification edits are owned by this WebView. Native
      // runtime envelopes may have been sampled before the debounced save
      // reached Rust, so accepting their stale copy would visibly undo a
      // just-selected theme or toggle.
      settings: current.state.settings,
      classificationRules: current.state.classificationRules,
      currentSnapshot: envelope.currentSnapshot,
      currentDecision: envelope.currentDecision,
      currentPetIntent,
      latestPetBubble,
    }),
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

export const useFocusPetApp = (): FocusPetAppController => {
  const [bundle, setBundle] = useState<RuntimeBundle>(() => emptyRuntime());
  const [catalogEntries, setCatalogEntries] = useState<ClassificationCatalogEntry[]>([]);
  const [petPacks, setPetPacks] = useState<PetPackRecord[]>([]);
  const [selectedTab, setSelectedTab] = useState<DashboardTab>("today");
  const [installationNotice, setInstallationNotice] = useState<InstallationSnapshot | undefined>();
  const [codexSessions, setCodexSessions] = useState<CodexSessionSnapshot[]>([]);
  const [codexIntegration, setCodexIntegration] = useState<CodexIntegrationStatus | undefined>();
  const [codexManagedStatusEnabled, setCodexManagedStatusEnabled] = useState(false);
  const [codexSshHosts, setCodexSshHosts] = useState<SshHostCandidate[]>([]);
  const [codexSshConnections, setCodexSshConnections] = useState<SshConnectionStatus[]>([]);
  const [codexSshDiagnostics, setCodexSshDiagnostics] = useState<Record<string, SshHostDiagnostic>>({});
  const [ready, setReady] = useState(false);
  const codexDashboardEnabled = selectedTab === "settings"
    || bundle.state.settings.codex.showInToday;
  const catalogRef = useRef<ClassificationCatalogEntry[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingSnapshot = useRef<LocalStoreSnapshot | undefined>(undefined);
  const saveInFlight = useRef<Promise<void> | undefined>(undefined);
  const lastPersistedAt = useRef(0);
  const tickInFlight = useRef<Promise<void> | undefined>(undefined);
  const fullSnapshotInFlight = useRef<Promise<void> | undefined>(undefined);
  const lastNativeRuntimeGeneration = useRef(-1);
  const nativeSampleUnavailable = useRef(false);
  const lastNotificationID = useRef<string | undefined>(undefined);
  const physicalIntentResetTimer = useRef<number | undefined>(undefined);
  const hydratingPetPackIDs = useRef<Set<string>>(new Set());
  const hydratedPetPackIDs = useRef<Set<string>>(new Set());
  const classificationCommitRequested = useRef(false);
  const classificationSaveInFlight = useRef<Promise<void> | undefined>(undefined);

  const acceptNativeRuntimeEnvelope = useCallback((envelope: NativeRuntimeEnvelope | undefined) => {
    if (!envelope || envelope.generation <= lastNativeRuntimeGeneration.current) return;
    lastNativeRuntimeGeneration.current = envelope.generation;
    setBundle((current) => applyNativeRuntimeEnvelope(current, envelope));
  }, []);

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
    while (classificationSaveInFlight.current) {
      const request = classificationSaveInFlight.current;
      await request.catch(() => undefined);
      if (classificationSaveInFlight.current === request) {
        classificationSaveInFlight.current = undefined;
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
        const installationSnapshot = await startupTimeout(
          nativeInstallationSnapshot(),
          900,
          undefined,
          () => undefined,
        ).catch(() => undefined);
        if (!cancelled && installationSnapshot && shouldShowInstallationNotice(installationSnapshot)) {
          setInstallationNotice(installationSnapshot);
        }
        const state = ensureSelectedPetPack(
          {
            ...initial.state,
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

  const mutateClassification = useCallback(
    (updater: (state: AppRuntimeState) => AppRuntimeState) => {
      classificationCommitRequested.current = true;
      setBundle((current) => {
        // Classification edits do not change historical totals. Keep the
        // click path proportional to the small rules array instead of walking
        // every stored history segment through recomputeDerived.
        const nextState = updater(current.state);
        if (nextState === current.state) {
          classificationCommitRequested.current = false;
          return current;
        }
        return { ...current, state: nextState };
      });
    },
    [],
  );

  useEffect(() => {
    if (!classificationCommitRequested.current) return;
    classificationCommitRequested.current = false;
    const { classificationRules } = bundle.state;
    if (!isTauriRuntime()) {
      persist(runtimeSnapshot(bundle.state));
      return;
    }
    // Send only the small rules document across IPC. Rust updates its live
    // classifier and triggers an immediate resident sample, so the current
    // app reflects the manual category without waiting for the next tick.
    // Avoid forcing an extra full-history snapshot through the WebView on the
    // user's click path.
    const previousRequest = classificationSaveInFlight.current;
    const request = (previousRequest ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const saved = await nativeSetClassificationRules(classificationRules);
        if (!saved) throw new Error("原生分类规则服务不可用");
      });
    classificationSaveInFlight.current = request;
    void request.then(
      () => {
        if (classificationSaveInFlight.current === request) {
          classificationSaveInFlight.current = undefined;
        }
      },
      (error) => {
        if (classificationSaveInFlight.current !== request) return;
        classificationSaveInFlight.current = undefined;
        setBundle((current) => ({
          ...current,
          state: {
            ...current.state,
            statusMessage: `分类规则保存失败：${error instanceof Error ? error.message : String(error)}`,
          },
        }));
      },
    );
  }, [bundle.state, bundle.state.classificationRules, persist]);

  const tick = useCallback((): Promise<void> => {
    if (isTauriRuntime()) {
      return nativeRuntimeSnapshot()
        .then(acceptNativeRuntimeEnvelope)
        .catch(() => undefined);
    }
    if (tickInFlight.current) return tickInFlight.current;
    const request = (async () => {
      const sample = await sampleActivity();
      if (!sample) {
        if (!nativeSampleUnavailable.current) {
          nativeSampleUnavailable.current = true;
          setBundle((current) => ({
            ...current,
            state: {
              ...current.state,
              statusMessage: "Windows 原生监控采样暂时不可用，本轮未写入模拟数据。",
            },
          }));
        }
        return;
      }
      const recoveredFromUnavailable = nativeSampleUnavailable.current;
      nativeSampleUnavailable.current = false;
      setBundle((current) => {
        const next = advanceRuntime(current, sample, catalogRef.current);
        const sampledState = recoveredFromUnavailable
          ? { ...next.state, statusMessage: "Windows 原生监控采样已恢复。" }
          : next.state;
        const nextState = sampledState;
        persist(runtimeSnapshot(nextState), "sample");
        return { ...next, state: nextState };
      });
    })();
    tickInFlight.current = request;
    void request.finally(() => {
      if (tickInFlight.current === request) tickInFlight.current = undefined;
    });
    return request;
  }, [acceptNativeRuntimeEnvelope, persist]);

  useEffect(() => {
    if (!ready || !isTauriRuntime()) return undefined;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refreshFullSnapshot = () => {
      if (disposed || document.visibilityState === "hidden" || fullSnapshotInFlight.current) return;
      const request = nativeRuntimeSnapshot()
        .then(acceptNativeRuntimeEnvelope)
        .catch(() => undefined);
      fullSnapshotInFlight.current = request;
      void request.finally(() => {
        if (fullSnapshotInFlight.current === request) fullSnapshotInFlight.current = undefined;
      });
    };
    void listen<NativeRuntimeEnvelope>("focus-pet-native-runtime", (event) => {
      acceptNativeRuntimeEnvelope(event.payload);
    }).then((dispose) => {
      if (disposed) {
        dispose();
        return;
      }
      unlisten = dispose;
      refreshFullSnapshot();
    });
    window.addEventListener("focus", refreshFullSnapshot);
    document.addEventListener("visibilitychange", refreshFullSnapshot);
    const fullRefreshInterval = window.setInterval(refreshFullSnapshot, 30 * 60_000);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(fullRefreshInterval);
      window.removeEventListener("focus", refreshFullSnapshot);
      document.removeEventListener("visibilitychange", refreshFullSnapshot);
    };
  }, [acceptNativeRuntimeEnvelope, ready]);

  const refreshRecognitionDiagnostics = useCallback(async () => {
    const sample = await sampleActivity();
    if (!sample) {
      mutate((state) => ({
        ...state,
        statusMessage: "Windows 原生监控采样不可用，未生成模拟诊断。",
      }));
      return;
    }
    mutate((state) => {
      const classifier = new ActivityClassifier(state.classificationRules, catalogRef.current);
      const category = classifier.classify(sample.appName, sample.bundleID, sample.windowTitle);
      const sanitizedTitle = sanitizeWindowTitle(sample.windowTitle);
      return {
        ...state,
        recognitionDiagnostic: {
          sampledAt: sample.timestamp,
          sampleQuality: sample.sampleQuality,
          appName: sample.appName,
          bundleID: sample.bundleID,
          windowTitle: sanitizedTitle.rawTitle ?? sanitizedTitle.titleDisplay,
          idleSeconds: sample.idleSeconds,
          keyboardCount: sample.keyboardCount,
          pointerCount: sample.pointerCount,
          switchCount: sample.switchCount,
          isScreenLocked: sample.isScreenLocked,
          category,
          catalogEntryCount: catalogRef.current.length,
          defaultRuleCount: classifier.defaultRules.length,
          userRuleCount: state.classificationRules.length,
          inputMonitoringStatus: inputMonitoringPermissionTitle(sample.inputMonitoringStatus),
        },
        statusMessage: "识别诊断已刷新。",
      };
    });
  }, [mutate]);

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
    if (!ready || !isTauriRuntime() || !codexDashboardEnabled) return undefined;
    let disposed = false;
    let refreshing = false;
    const refreshCodexSnapshot = async () => {
      if (disposed || refreshing) return;
      refreshing = true;
      try {
        const [snapshot, status] = await Promise.all([
          nativeCodexSessionSnapshot(),
          selectedTab === "settings" ? nativeCodexIntegrationStatus() : Promise.resolve(undefined),
        ]);
        if (disposed) return;
        setCodexSessions(onlyActiveCodexSessions(snapshot));
        if (status) {
          setCodexIntegration(status);
          if (
            ["running", "available", "ephemeralAvailable"].includes(status.managedDaemonStatus)
          ) {
            void nativeStartCodexManagedDaemon()
              .then((started) => setCodexManagedStatusEnabled(started))
              .catch(() => setCodexManagedStatusEnabled(false));
          }
        }
      } catch {
        // Codex is optional and must not disturb the focus runtime.
      } finally {
        refreshing = false;
      }
    };
    let unlisten: (() => void) | undefined;
    void listen<import("../core/codexSessions").CodexEventEnvelope[]>("codex-session-events", (event) => {
      if (!disposed && event.payload.length > 0) {
        setCodexSessions((current) => reduceActiveCodexEvents(current, event.payload));
      }
    }).then((dispose) => {
      unlisten = dispose;
      void refreshCodexSnapshot();
    });
    // Native events are primary. This slow snapshot only recovers a listener
    // setup race or an older runtime that cannot deliver event batches.
    const interval = window.setInterval(() => void refreshCodexSnapshot(), 10_000);
    return () => {
      disposed = true;
      unlisten?.();
      window.clearInterval(interval);
    };
  }, [codexDashboardEnabled, ready, selectedTab]);

  useEffect(() => {
    if (!ready || !isTauriRuntime() || selectedTab !== "settings") return undefined;
    let disposed = false;
    const refreshSshStatus = async () => {
      try {
        const connections = await nativeCodexSshConnectionStatus();
        if (!disposed) setCodexSshConnections(connections);
      } catch {
        // SSH reconnects happen in the native manager.
      }
    };
    void nativeDiscoverCodexSshHosts().then((hosts) => {
      if (!disposed) setCodexSshHosts(hosts);
    }).catch(() => undefined);
    void refreshSshStatus();
    const interval = window.setInterval(() => void refreshSshStatus(), 5_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [ready, selectedTab]);

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
    void listen<{ x: number; y: number; phase?: "dragging" | "landing" | "follow" }>("focus-pet-companion-moved", (event) => {
      if (event.payload.phase !== "follow") {
        window.clearTimeout(physicalIntentResetTimer.current);
        physicalIntentResetTimer.current = undefined;
      }
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
        if (event.payload.phase === "follow") {
          if (state.settings.pet.placement !== "custom") return state;
          return runtimeActions.updateSettings(state, (settings) => ({
            ...settings,
            pet: {
              ...settings.pet,
              customOriginX: event.payload.x,
              customOriginY: event.payload.y,
            },
          }));
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
      if (event.payload.phase === "landing" || event.payload.phase === undefined) {
        physicalIntentResetTimer.current = window.setTimeout(() => {
          physicalIntentResetTimer.current = undefined;
          mutate((state) => {
            if (
              state.currentPetIntent.source !== "physicalInteraction"
              || state.currentPetIntent.kind !== "landing"
            ) {
              return state;
            }
            return {
              ...state,
              currentPetIntent: makePetIntent(
                intentKindForState(state.currentDecision.state),
                "state",
              ),
            };
          });
        }, 1_600);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      unlisten?.();
      window.clearTimeout(physicalIntentResetTimer.current);
      physicalIntentResetTimer.current = undefined;
    };
  }, [mutate, ready]);

  const desktopWidgetSettings = bundle.state.settings.desktopWidget;
  const petSettings = bundle.state.settings.pet;
  const petCompanionStateRef = useRef(makePetCompanionViewState(bundle.state, undefined, codexSessions));
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
  petCompanionStateRef.current = makePetCompanionViewState(bundle.state, codexBubble(codexSessions), codexSessions);
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
    if (!ready || isTauriRuntime()) return undefined;
    void tick();
    const interval = window.setInterval(() => {
      void tick();
    }, 10000);
    return () => window.clearInterval(interval);
  }, [ready, tick]);

  const activeFocus = activeFocusSession(bundle.state.focusSessions);
  const codexBubbleText = useMemo(() => codexBubble(codexSessions), [codexSessions]);

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
        makePetCompanionViewState(bundle.state, codexBubbleText, codexSessions),
      );
    }
    void emitTo("widget-menu-bar", "focus-pet-menu-bar-state", menuBarPayload);
  }, [
    activeFocus,
    bundle,
    codexBubbleText,
    codexSessions,
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
  }, [petPacks, petSettings.hidden, petSettings.selectedPackID, ready]);

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
        mutateClassification((state) => runtimeActions.addRule(state, pattern, matchKind, category));
      },
      deleteRule(id) {
        mutateClassification((state) => runtimeActions.deleteRule(state, id));
      },
      resetRecognitionRules() {
        mutateClassification(runtimeActions.resetRecognitionRules);
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
      dismissInstallationNotice() {
        if (installationNotice) {
          markInstallationNoticeShown(installationNotice.buildIdentifier);
        }
        setInstallationNotice(undefined);
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
      async refreshCodexIntegration() {
        const [snapshot, status] = await Promise.all([
          nativeCodexSessionSnapshot(),
          nativeCodexIntegrationStatus(),
        ]);
        setCodexSessions(snapshot);
        setCodexIntegration(status);
      },
      async enableCodexManagedStatus() {
        try {
          const started = await nativeStartCodexManagedDaemon();
          if (!started) throw new Error("Codex App Server daemon 未能启动。");
          const events = await nativePollCodexManagedStatus();
          setCodexSessions((current) => reduceCodexEvents(current, events));
          setCodexManagedStatusEnabled(true);
          setCodexIntegration(await nativeCodexIntegrationStatus());
          mutate((state) => ({ ...state, statusMessage: "Codex 精确状态已启用。" }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mutate((state) => ({ ...state, statusMessage: `Codex 精确状态不可用：${message}` }));
          throw error;
        }
      },
      async installCodexHooks() {
        try {
          const result = await nativeInstallCodexHooks();
          const status = await nativeCodexIntegrationStatus();
          setCodexIntegration(status);
          mutate((state) => ({ ...state, statusMessage: result.message }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mutate((state) => ({ ...state, statusMessage: `Codex Hook 安装失败：${message}` }));
          throw error;
        }
      },
      async uninstallCodexHooks() {
        try {
          const result = await nativeUninstallCodexHooks();
          const status = await nativeCodexIntegrationStatus();
          setCodexIntegration(status);
          mutate((state) => ({ ...state, statusMessage: result.message }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mutate((state) => ({ ...state, statusMessage: `Codex Hook 移除失败：${message}` }));
          throw error;
        }
      },
      async copyCodexHookCommand() {
        const status = codexIntegration ?? await nativeCodexIntegrationStatus();
        if (!status?.hookCommand) throw new Error("当前环境无法取得 Codex Hook 命令。");
        await navigator.clipboard?.writeText(status.hookCommand);
        mutate((state) => ({ ...state, statusMessage: "已复制 Codex Hook 命令。" }));
      },
      async copyCodexStandaloneInstallCommand() {
        // Standalone is optional: a normal Codex CLI can run Focus Pet's
        // explicitly started observer. This installer only enables Codex's
        // durable managed-daemon mode, and is always user initiated.
        await navigator.clipboard?.writeText("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
        mutate((state) => ({ ...state, statusMessage: "已复制官方 standalone 安装命令；它可启用持久 daemon，普通 Codex CLI 也可直接启用精确状态。" }));
      },
      async updateCodexSyncPreferences(preferences) {
        const result = await nativeSetCodexSyncPreferences(preferences);
        const status = await nativeCodexIntegrationStatus();
        setCodexIntegration(status);
        if (result.contentMode === "statusOnly") {
          setCodexSessions((current) => current.map((session) => ({ ...session, latestVisibleMessage: undefined })));
        }
        mutate((state) => ({
          ...state,
          statusMessage: result.contentMode === "statusOnly" ? "Codex 已切换为仅同步状态。" : "Codex 将显示 assistant 可见摘要。",
        }));
      },
      async discoverCodexSshHosts() {
        const hosts = await nativeDiscoverCodexSshHosts();
        setCodexSshHosts(hosts);
        mutate((state) => ({ ...state, statusMessage: hosts.length ? `发现 ${hosts.length} 个 SSH Host。` : "没有发现可用的 SSH Host alias。" }));
      },
      async saveCodexSshHost(host) {
        const saved = await nativeSaveCodexSshHost(host);
        setCodexSshHosts((current) => [...current.filter((existing) => existing.alias !== saved.alias), saved].sort((left, right) => left.alias.localeCompare(right.alias)));
        mutate((state) => ({ ...state, statusMessage: `已保存 SSH 主机 ${saved.alias}；可先执行只读检查。` }));
      },
      async forgetCodexSshHost(alias) {
        await nativeForgetCodexSshHost(alias);
        setCodexSshHosts((current) => current.filter((host) => host.alias !== alias));
        setCodexSshDiagnostics((current) => {
          const { [alias]: _removed, ...remaining } = current;
          return remaining;
        });
        setCodexSshConnections((current) => current.filter((connection) => connection.alias !== alias));
        mutate((state) => ({ ...state, statusMessage: `已从 Focus Pet 移除 SSH 主机 ${alias}；未修改 ~/.ssh/config 或远端环境。` }));
      },
      async diagnoseCodexSshHost(alias) {
        try {
          const diagnostic = await nativeDiagnoseCodexSshHost(alias);
          setCodexSshDiagnostics((current) => ({ ...current, [alias]: diagnostic }));
          mutate((state) => ({
            ...state,
            statusMessage: `${alias} 可接入：${diagnostic.operatingSystem} ${diagnostic.architecture} · ${diagnostic.codexVersion}`,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mutate((state) => ({ ...state, statusMessage: `SSH 主机检查失败：${message}` }));
          throw error;
        }
      },
      async provisionCodexSshHost(alias) {
        try {
          const diagnostic = await nativeDiagnoseCodexSshHost(alias);
          const result = await nativeProvisionCodexSshHost(alias);
          const connected = await nativeConnectCodexSshHost(alias);
          if (!connected) throw new Error("无法建立远端 Codex 只读同步通道。");
          mutate((state) => ({ ...state, statusMessage: `${result.message}（${diagnostic.operatingSystem} ${diagnostic.architecture}）` }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mutate((state) => ({ ...state, statusMessage: `SSH Codex 连接失败：${message}` }));
          throw error;
        }
      },
      async uninstallCodexSshHost(alias) {
        try {
          const result = await nativeUninstallCodexSshHost(alias);
          setCodexSshDiagnostics((current) => {
            const next = { ...current };
            delete next[alias];
            return next;
          });
          mutate((state) => ({ ...state, statusMessage: result.message }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          mutate((state) => ({ ...state, statusMessage: `SSH Codex 断开失败：${message}` }));
          throw error;
        }
      },
    }),
    [
      flushPersist,
      installationNotice,
      mutate,
      mutateClassification,
      persist,
      petPacks,
      refreshRecognitionDiagnostics,
      refreshPetPacks,
      tick,
      codexIntegration,
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
    codexSessions,
    codexIntegration,
    codexManagedStatusEnabled,
    codexSshHosts,
    codexSshConnections,
    codexSshDiagnostics,
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
