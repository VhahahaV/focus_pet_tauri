import { describe, expect, it } from "vitest";
import { ActivityClassifier } from "../core/classification";
import { sanitizeWindowTitle } from "../core/activity";
import { evaluateState } from "../core/stateEngine";
import { finishFocusSession, makeFocusSession, remainingFocusSeconds } from "../core/sessions";
import { evaluateNudge } from "../core/nudge";
import { makeActivityHistorySnapshot, makeAttentionHistorySnapshot, recordInputActivity, recordStateSegment } from "../core/timeline";
import { buildDailySummary } from "../core/summary";
import { defaultAppSettings, judgmentPresetSettings, matchingJudgmentPreset } from "../core/settings";
import type { ActivitySnapshot, FocusStateSnapshot, StateDecision } from "../core/types";
import { importedPetPackRecord, normalizePetPack, validatePetPack } from "../resources/petPack";
import {
  advanceRuntime,
  emptyRuntime,
  inputMonitoringPermissionTitle,
  notificationPermissionTitle,
  permissionSnapshotForDisplay,
  runtimeActions,
} from "../app/runtime";
import { applyNativeMenuAction, nativeMenuTab } from "../app/nativeMenu";
import { applyDesktopWidgetMoved, widgetWindowSyncState } from "../app/widgetWindows";
import { cyclePlayableSourceAction, nextPetFrameIndex, resolveDisplaySourceAction } from "../app/petCompanionLogic";
import { makePetCompanionViewState } from "../app/petCompanionPayload";
import { activitySampleForRuntime } from "../app/activitySampling";
import { emptySnapshot, pruneSnapshotForRetention, redactedSnapshot } from "../store/localStore";

const baseSnapshot = (overrides: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
  timestamp: "2026-07-07T10:00:00.000Z",
  appName: "Cursor",
  bundleID: "com.cursor",
  windowTitle: "Focus Pet migration",
  titleStored: false,
  category: "work",
  idleSeconds: 0,
  switchCountLast5Min: 0,
  switchCountLast15Min: 0,
  activeCategoryDuration: 240,
  activeAppDuration: 240,
  isFocusSessionActive: false,
  isSystemSleeping: false,
  isScreenLocked: false,
  source: ["frontmostApplication"],
  ...overrides,
});

describe("Focus Pet migrated core", () => {
  it("never substitutes browser preview input for a failed native sample", () => {
    const now = new Date("2026-07-18T10:00:00.000Z");
    expect(activitySampleForRuntime(undefined, true, now)).toBeUndefined();
    expect(activitySampleForRuntime(undefined, false, now)?.inputMonitoringStatus).toBe("browser-preview");

    const nativeSample = activitySampleForRuntime(undefined, false, now)!;
    expect(activitySampleForRuntime(nativeSample, true, now)).toBe(nativeSample);
  });

  it("advances looping and one-shot pet animations without overrunning frames", () => {
    expect(nextPetFrameIndex(0, 3, true, true)).toBe(1);
    expect(nextPetFrameIndex(2, 3, true, true)).toBe(0);
    expect(nextPetFrameIndex(2, 3, true, false)).toBe(2);
    expect(nextPetFrameIndex(1, 3, false, true)).toBe(1);
    expect(nextPetFrameIndex(99, 3, true, false)).toBe(2);
    expect(nextPetFrameIndex(0, 0, true, true)).toBe(0);
  });

  it("normalizes native input monitoring states to Swift permission titles", () => {
    expect(inputMonitoringPermissionTitle("available")).toBe("已允许");
    expect(inputMonitoringPermissionTitle("frontmost-app-window-cg-event-tap · available")).toBe("已允许");
    expect(inputMonitoringPermissionTitle("needs-input-monitoring-permission")).toBe("待开启");
    expect(inputMonitoringPermissionTitle("检查中")).toBe("检查中");
  });

  it("normalizes Windows native permission adapter details for display", () => {
    expect(notificationPermissionTitle("windows-notification-runtime-available")).toBe("已允许");
    expect(notificationPermissionTitle("denied")).toBe("待开启");
    expect(permissionSnapshotForDisplay({
      refreshedAt: "2026-07-18T00:00:00.000Z",
      inputMonitoring: "windows-low-level-hooks-available",
      notifications: "windows-notification-runtime-available",
    })).toEqual({
      refreshedAt: "2026-07-18T00:00:00.000Z",
      inputMonitoring: "已允许",
      notifications: "已允许",
    });
  });

  it("classifies work and entertainment with user rules taking priority", () => {
    const classifier = new ActivityClassifier([
      { id: "user-youtube", matchKind: "windowTitle", pattern: "YouTube 教程", category: "work", priority: 0 },
    ]);
    expect(classifier.classify("Safari", undefined, "YouTube 教程 - React")).toBe("work");
    expect(classifier.classify("Safari", undefined, "YouTube 首页")).toBe("entertainment");
  });

  it("redacts window titles unless raw-title storage is enabled", () => {
    const privacy = defaultAppSettings().privacy;
    const sanitized = sanitizeWindowTitle("Project_Secret_123 - Draft", privacy);
    expect(sanitized.rawTitle).toBeUndefined();
    expect(sanitized.titleStored).toBe(false);
    expect(sanitized.titleDisplay).toContain("•");
  });

  it("evaluates the three-state priority rules", () => {
    expect(evaluateState(baseSnapshot({ idleSeconds: 800 }), "focus").state).toBe("away");
    expect(evaluateState(baseSnapshot({ idleSeconds: 220 }), "focus").state).toBe("distracted");
    expect(evaluateState(baseSnapshot({ category: "work" }), "distracted").state).toBe("focus");
  });

  it("matches migrated recognition sensitivity presets", () => {
    expect(matchingJudgmentPreset(defaultAppSettings().judgment)).toBe("relaxed");
    expect(matchingJudgmentPreset(judgmentPresetSettings("balanced"))).toBe("balanced");
    expect(matchingJudgmentPreset(judgmentPresetSettings("strict"))).toBe("strict");
    expect(matchingJudgmentPreset({ ...judgmentPresetSettings("strict"), idleAwaySeconds: 360 })).toBe("custom");
  });

  it("records timeline and builds daily summaries", () => {
    const decision: StateDecision = {
      timestamp: "2026-07-07T10:00:10.000Z",
      state: "focus",
      category: "work",
      confidence: 0.8,
      reason: ["workCategory"],
      stableDuration: 10,
    };
    const segments = recordStateSegment(decision, baseSnapshot({ timestamp: decision.timestamp }), [], 10);
    const summary = buildDailySummary(new Date("2026-07-07T12:00:00.000Z"), segments, [], [], []);
    expect(summary.focusSeconds).toBe(10);
    expect(summary.appUsage[0]?.appName).toBe("Cursor");
  });

  it("buckets input activity", () => {
    const buckets = recordInputActivity("2026-07-07T10:00:12.000Z", 3, 2, 1, []);
    const updated = recordInputActivity("2026-07-07T10:00:45.000Z", 4, 0, 0, buckets);
    expect(updated).toHaveLength(1);
    expect(updated[0].keyboardCount).toBe(7);
    expect(updated[0].switchCount).toBe(1);
  });

  it("builds range-based history snapshots from state, app, and input timelines", () => {
    const history = makeActivityHistorySnapshot(
      7,
      [
        {
          id: "focus",
          start: "2026-07-07T09:00:00.000Z",
          end: "2026-07-07T10:00:00.000Z",
          state: "focus",
          appName: "Cursor",
          category: "work",
          titleStored: false,
          source: ["frontmostApplication"],
        },
        {
          id: "away",
          start: "2026-07-07T10:00:00.000Z",
          end: "2026-07-07T10:30:00.000Z",
          state: "away",
          appName: "Away",
          category: "ignore",
          titleStored: false,
          source: ["idleTime"],
        },
      ],
      [
        { id: "cursor", start: "2026-07-07T09:00:00.000Z", end: "2026-07-07T09:45:00.000Z", appName: "Cursor", bundleID: "com.cursor", category: "work" },
        { id: "sleep", start: "2026-07-07T10:00:00.000Z", end: "2026-07-07T10:30:00.000Z", appName: "Sleep", category: "ignore" },
      ],
      [{ start: "2026-07-07T09:30:00.000Z", end: "2026-07-07T09:31:00.000Z", keyboardCount: 120, pointerCount: 30, switchCount: 2 }],
      new Date("2026-07-08T09:00:00.000Z"),
    );

    expect(history.focusSeconds).toBe(3600);
    expect(history.awaySeconds).toBe(1800);
    expect(history.averageFocusSeconds).toBe(Math.round(3600 / 7));
    expect(history.topApps).toHaveLength(1);
    expect(history.topApps[0].appName).toBe("Cursor");
    expect(history.appActiveSeconds).toBe(2700);
    expect(history.estimatedTypedCharacters).toBe(120);
    expect(history.pointerActionCount).toBe(30);
    expect(history.contextSwitchCount).toBe(2);
    expect(history.inputActiveSeconds).toBe(60);
  });

  it("can exclude weekends from range-based history snapshots", () => {
    const saturdayFocus = {
      id: "saturday",
      start: "2026-07-04T09:00:00.000Z",
      end: "2026-07-04T10:00:00.000Z",
      state: "focus" as const,
      appName: "Cursor",
      category: "work" as const,
      titleStored: false,
      source: ["frontmostApplication" as const],
    };
    const mondayFocus = {
      id: "monday",
      start: "2026-07-06T09:00:00.000Z",
      end: "2026-07-06T10:00:00.000Z",
      state: "focus" as const,
      appName: "Cursor",
      category: "work" as const,
      titleStored: false,
      source: ["frontmostApplication" as const],
    };
    const history = makeActivityHistorySnapshot(7, [saturdayFocus, mondayFocus], [], [], new Date("2026-07-08T09:00:00.000Z"), true);
    expect(history.skipsWeekends).toBe(true);
    expect(history.dayCount).toBe(5);
    expect(history.focusSeconds).toBe(3600);
    expect(history.averageFocusSeconds).toBe(Math.round(3600 / 5));
  });

  it("builds week and month attention heatmap buckets", () => {
    const localDateKey = (date: string) => {
      const value = new Date(date);
      const year = value.getFullYear();
      const month = `${value.getMonth() + 1}`.padStart(2, "0");
      const day = `${value.getDate()}`.padStart(2, "0");
      return `${year}-${month}-${day}`;
    };
    const history = makeAttentionHistorySnapshot(
      [
        {
          id: "overnight",
          start: new Date(2026, 6, 6, 23, 30).toISOString(),
          end: new Date(2026, 6, 7, 0, 30).toISOString(),
          state: "focus",
          appName: "Cursor",
          category: "work",
          titleStored: false,
          source: ["frontmostApplication"],
        },
        {
          id: "distracted",
          start: new Date(2026, 6, 7, 10, 0).toISOString(),
          end: new Date(2026, 6, 7, 10, 15).toISOString(),
          state: "distracted",
          appName: "Safari",
          category: "entertainment",
          titleStored: false,
          source: ["windowTitle"],
        },
      ],
      new Date(2026, 6, 8, 9, 0),
    );

    expect(history.weeks).toHaveLength(12);
    expect(history.months).toHaveLength(6);
    expect(history.focusSeconds).toBe(3600);
    expect(history.distractedSeconds).toBe(900);
    const currentWeekDays = history.weeks.at(-1)!.days;
    expect(currentWeekDays.find((day) => localDateKey(day.date) === "2026-07-06")?.focusSeconds).toBe(1800);
    expect(currentWeekDays.find((day) => localDateKey(day.date) === "2026-07-07")?.focusSeconds).toBe(1800);
    expect(currentWeekDays.find((day) => localDateKey(day.date) === "2026-07-07")?.distractedSeconds).toBe(900);
  });

  it("tracks focus-session remaining time", () => {
    const session = makeFocusSession("迁移", 25, new Date("2026-07-07T10:00:00.000Z"));
    expect(remainingFocusSeconds(session, new Date("2026-07-07T10:10:00.000Z"))).toBe(900);
  });

  it("creates nudges after thresholds and respects cooldown groups", () => {
    const state: FocusStateSnapshot = {
      id: "state",
      timestamp: "2026-07-07T10:12:00.000Z",
      state: "distracted",
      category: "entertainment",
      stableDuration: 12 * 60,
      appName: "Safari",
      reason: ["entertainmentStable"],
    };
    const first = evaluateNudge(state, "focus", 0, new Date("2026-07-07T10:12:00.000Z"), {});
    expect(first?.reason).toBe("distractedStrong");
    const second = evaluateNudge(state, "focus", 0, new Date("2026-07-07T10:13:00.000Z"), {
      distractedStrong: first!.time,
    });
    expect(second).toBeUndefined();
  });

  it("validates pet packs and source actions", () => {
    const pack = normalizePetPack({
      schemaVersion: 1,
      id: "pet",
      name: "Pet",
      defaultSize: { width: 100, height: 100 },
      animations: { idle: { folder: "idle", fps: 12, loop: true, frameCount: 1 } },
      sourceActions: [{ id: "idle", title: "待机", folder: "idle", fps: 12, loop: true, frameCount: 1 }],
      license: "local",
      distribution: "test",
    });
    expect(validatePetPack(pack).isValid).toBe(true);
  });

  it("normalizes imported pet-pack records from native import", () => {
    const record = importedPetPackRecord({
      id: "raw",
      name: "Raw",
      author: "Native",
      style: "test",
      license: "",
      distribution: "",
      previewURL: "asset://preview.png",
      pack: normalizePetPack({
        schemaVersion: 1,
        id: "native-pack",
        name: "Native Pack",
        animations: { idle: { folder: "idle", fps: 8, loop: true, frameCount: 1 } },
        sourceActions: [{ id: "idle", title: "Idle", folder: "idle", fps: 8, loop: true, frameCount: 1 }],
      }),
      validation: { errors: [], warnings: [], isValid: true },
      sourceActionAssets: [{ id: "idle", frameURLs: ["asset://idle/000.png"], audioURL: "asset://idle.wav" }],
    });
    expect(record.id).toBe("native-pack");
    expect(record.previewURL).toBe("asset://preview.png");
    expect(record.sourceActionAssets?.[0]?.frameURLs).toEqual(["asset://idle/000.png"]);
  });

  it("exposes newly-created nudges for notification delivery", () => {
    const runtime = emptyRuntime([]);
    const first = advanceRuntime(
      runtime,
      {
        timestamp: "2026-07-07T10:00:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Safari",
        bundleID: "com.apple.Safari",
        windowTitle: "YouTube",
        idleSeconds: 0,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    const second = advanceRuntime(
      {
        ...first,
        memory: {
          ...first.memory,
          previousState: "distracted",
          stableStateSince: "2026-07-07T09:45:00.000Z",
          lastNudgeAt: {},
        },
      },
      {
        timestamp: "2026-07-07T10:13:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Safari",
        bundleID: "com.apple.Safari",
        windowTitle: "YouTube",
        idleSeconds: 0,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    expect(second.latestNudge?.reason).toBe("distractedStrong");
  });

  it("advances runtime without mutating the previous history bundle", () => {
    const runtime = emptyRuntime([]);
    const previousMemory = { ...runtime.memory, lastNudgeAt: { ...runtime.memory.lastNudgeAt } };
    const previousArrays = {
      stateSegments: runtime.state.stateSegments,
      appUsage: runtime.state.appUsage,
      inputActivity: runtime.state.inputActivity,
      focusSessions: runtime.state.focusSessions,
      nudges: runtime.state.nudges,
    };
    const advanced = advanceRuntime(
      runtime,
      {
        timestamp: "2026-07-07T10:00:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Cursor",
        bundleID: "com.cursor",
        windowTitle: "Focus Pet",
        idleSeconds: 0,
        inputMonitoringStatus: "test",
        keyboardCount: 2,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );

    expect(runtime.memory).toEqual(previousMemory);
    expect(runtime.state.stateSegments).toBe(previousArrays.stateSegments);
    expect(runtime.state.appUsage).toBe(previousArrays.appUsage);
    expect(runtime.state.inputActivity).toBe(previousArrays.inputActivity);
    expect(runtime.state.focusSessions).toBe(previousArrays.focusSessions);
    expect(runtime.state.nudges).toBe(previousArrays.nudges);
    expect(advanced.state.stateSegments).not.toBe(previousArrays.stateSegments);
    expect(advanced.state.appUsage).not.toBe(previousArrays.appUsage);
    expect(advanced.state.inputActivity).not.toBe(previousArrays.inputActivity);
  });

  it("backfills long sampling gaps as system sleep time", () => {
    const runtime = emptyRuntime([]);
    const first = advanceRuntime(
      runtime,
      {
        timestamp: "2026-07-07T10:00:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Cursor",
        bundleID: "com.cursor",
        windowTitle: "Focus Pet",
        idleSeconds: 45 * 60,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    const second = advanceRuntime(
      first,
      {
        timestamp: "2026-07-07T10:45:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Cursor",
        bundleID: "com.cursor",
        windowTitle: "Focus Pet",
        idleSeconds: 45 * 60,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    expect(second.state.summary.awaySeconds).toBeGreaterThanOrEqual(44 * 60);
    expect(second.state.stateSegments.some((segment) => segment.state === "away" && segment.appName === "Sleep")).toBe(true);
    expect(second.state.stateSegments.some((segment) => segment.source.includes("systemSleep"))).toBe(true);
    expect(second.state.appUsage.some((segment) => segment.appName === "Sleep")).toBe(false);
    expect(second.state.appUsage.some((segment) => segment.appName === "Away")).toBe(false);
    expect(second.state.appUsage.some((segment) => segment.appName === "Locked Screen")).toBe(false);
  });

  it("keeps ordinary sampling jitter in the current tick", () => {
    const runtime = emptyRuntime([]);
    const first = advanceRuntime(
      runtime,
      {
        timestamp: "2026-07-07T10:00:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Cursor",
        bundleID: "com.cursor",
        windowTitle: "Focus Pet",
        idleSeconds: 0,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    const second = advanceRuntime(
      first,
      {
        timestamp: "2026-07-07T10:00:45.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Cursor",
        bundleID: "com.cursor",
        windowTitle: "Focus Pet",
        idleSeconds: 0,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    expect(second.state.stateSegments.some((segment) => segment.appName === "Sleep")).toBe(false);
  });

  it("does not record current away ticks as app usage", () => {
    const runtime = emptyRuntime([]);
    const advanced = advanceRuntime(
      {
        ...runtime,
        memory: {
          ...runtime.memory,
          previousState: "focus",
          lastTickAt: "2026-07-07T10:00:00.000Z",
        },
      },
      {
        timestamp: "2026-07-07T10:00:10.000Z",
        platform: "test",
        sampleQuality: "screen-locked",
        appName: "Locked Screen",
        bundleID: undefined,
        windowTitle: undefined,
        idleSeconds: 600,
        inputMonitoringStatus: "test",
        keyboardCount: 0,
        pointerCount: 0,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: true,
      },
      [],
    );
    expect(advanced.state.currentDecision.state).toBe("away");
    expect(advanced.state.stateSegments.some((segment) => segment.appName === "Locked Screen")).toBe(true);
    expect(advanced.state.appUsage.some((segment) => segment.appName === "Locked Screen")).toBe(false);
  });

  it("welcomes the user back after a long away backfill", () => {
    const runtime = emptyRuntime([]);
    const first = advanceRuntime(
      {
        ...runtime,
        state: {
          ...runtime.state,
          settings: {
            ...runtime.state.settings,
            reminder: { ...runtime.state.settings.reminder, enableWelcomeBackNudges: true },
          },
        },
      },
      {
        timestamp: "2026-07-07T10:00:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Cursor",
        bundleID: "com.cursor",
        windowTitle: "Focus Pet",
        idleSeconds: 0,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    const second = advanceRuntime(
      first,
      {
        timestamp: "2026-07-07T10:45:00.000Z",
        platform: "test",
        sampleQuality: "test",
        appName: "Cursor",
        bundleID: "com.cursor",
        windowTitle: "Focus Pet",
        idleSeconds: 0,
        inputMonitoringStatus: "test",
        keyboardCount: 1,
        pointerCount: 1,
        switchCount: 0,
        isSystemSleeping: false,
        isScreenLocked: false,
      },
      [],
    );
    expect(second.latestNudge?.reason).toBe("welcomeBack");
    expect(second.state.currentPetIntent.kind).toBe("welcomeBack");
  });

  it("maps native tray/menu actions into tabs and persisted runtime settings", () => {
    const runtime = emptyRuntime([]).state;
    const applyRequiredMenuAction = (action: Parameters<typeof applyNativeMenuAction>[1], state = runtime) => {
      const next = applyNativeMenuAction(state, action);
      expect(next).toBeDefined();
      return next!;
    };
    expect(nativeMenuTab("open-today")).toBe("today");
    expect(nativeMenuTab("open-pet")).toBe("pet");
    expect(nativeMenuTab("open-settings")).toBe("settings");
    expect(nativeMenuTab("toggle-pet")).toBeUndefined();

    const widgetsShown = applyRequiredMenuAction("toggle-widgets");
    expect(widgetsShown.settings.desktopWidget.currentStatusVisible).toBe(true);
    expect(widgetsShown.settings.desktopWidget.recentRhythmVisible).toBe(true);

    const widgetsHidden = applyRequiredMenuAction("toggle-widgets", widgetsShown);
    expect(widgetsHidden.settings.desktopWidget.currentStatusVisible).toBe(false);
    expect(widgetsHidden.settings.desktopWidget.recentRhythmVisible).toBe(false);

    const petHidden = applyRequiredMenuAction("toggle-pet");
    expect(petHidden.settings.pet.hidden).toBe(true);

    const remindersPaused = applyRequiredMenuAction("pause-reminders");
    expect(remindersPaused.settings.reminder.pauseUntil).toBeTruthy();

    const remindersResumed = applyRequiredMenuAction("resume-reminders", remindersPaused);
    expect(remindersResumed.settings.reminder.pauseUntil).toBeUndefined();

    const focusing = runtimeActions.startFocusSession(runtime, "Tray action", 25);
    const focusFinished = applyRequiredMenuAction("finish-focus", focusing);
    expect(focusFinished.focusSessions.at(-1)?.status).toBe("completed");
  });

  it("persists desktop widget window positions for later native sync", () => {
    const runtime = emptyRuntime([]).state;
    const withStatusOrigin = applyDesktopWidgetMoved(runtime, "currentStatus", { x: 120, y: 80 });
    expect(withStatusOrigin.settings.desktopWidget.currentStatusOrigin).toEqual({ x: 120, y: 80 });

    const unchanged = applyDesktopWidgetMoved(withStatusOrigin, "currentStatus", { x: 120.4, y: 80.2 });
    expect(unchanged).toBe(withStatusOrigin);

    const withRhythmOrigin = applyDesktopWidgetMoved(withStatusOrigin, "recentRhythm", { x: 460, y: 96 });
    expect(withRhythmOrigin.settings.desktopWidget.recentRhythmOrigin).toEqual({ x: 460, y: 96 });

    const onLeftMonitor = applyDesktopWidgetMoved(withRhythmOrigin, "currentStatus", { x: -1200, y: 80 });
    expect(onLeftMonitor.settings.desktopWidget.currentStatusOrigin).toEqual({ x: -1200, y: 80 });

    const syncState = widgetWindowSyncState({
      ...onLeftMonitor,
      settings: {
        ...onLeftMonitor.settings,
        desktopWidget: {
          ...onLeftMonitor.settings.desktopWidget,
          currentStatusVisible: true,
          recentRhythmVisible: true,
        },
        pet: {
          ...onLeftMonitor.settings.pet,
          placement: "custom",
          customOriginX: 300,
          customOriginY: 200,
        },
      },
    });
    expect(syncState.currentStatusOrigin).toEqual({ x: -1200, y: 80 });
    expect(syncState.recentRhythmOrigin).toEqual({ x: 460, y: 96 });
    expect(syncState.movementMode).toBe("free");
    expect(syncState.petPlacement).toBe("custom");
    expect(syncState.petOrigin).toEqual({ x: 300, y: 200 });
  });

  it("randomly rotates playable pet source actions after the configured interval", () => {
    const settings = defaultAppSettings().pet;
    const record = importedPetPackRecord({
      id: "pet",
      name: "Pet",
      author: "Native",
      style: "test",
      license: "local",
      distribution: "test",
      pack: normalizePetPack({
        schemaVersion: 1,
        id: "pet",
        name: "Pet",
        animations: { idle: { folder: "idle", fps: 8, loop: true, frameCount: 1 } },
        sourceActions: [
          { id: "idle", title: "Idle", folder: "idle", fps: 8, loop: true, frameCount: 1 },
          { id: "stretch", title: "Stretch", folder: "stretch", fps: 8, loop: true, frameCount: 1 },
        ],
      }),
      validation: { errors: [], warnings: [], isValid: true },
      sourceActionAssets: [
        { id: "idle", frameURLs: ["asset://idle/000.png"] },
        { id: "stretch", frameURLs: ["asset://stretch/000.png"] },
      ],
    });
    const intent = emptyRuntime([]).state.currentPetIntent;
    const first = resolveDisplaySourceAction(intent, record, settings, {}, 1_000, () => 0);
    expect(first.action?.id).toBe("idle");

    const second = resolveDisplaySourceAction(
      intent,
      record,
      { ...settings, randomActionSwitchSeconds: 30 },
      first.randomState,
      32_000,
      () => 0,
    );
    expect(second.action?.id).toBe("stretch");
  });

  it("cycles to the next playable pet source action on demand", () => {
    const record = importedPetPackRecord({
      id: "pet",
      name: "Pet",
      author: "Native",
      style: "test",
      license: "local",
      distribution: "test",
      pack: normalizePetPack({
        schemaVersion: 1,
        id: "pet",
        name: "Pet",
        sourceActions: [
          { id: "idle", title: "Idle", folder: "idle", fps: 8, loop: true, frameCount: 1 },
          { id: "stretch", title: "Stretch", folder: "stretch", fps: 8, loop: true, frameCount: 1 },
        ],
      }),
      validation: { errors: [], warnings: [], isValid: true },
      sourceActionAssets: [
        { id: "idle", frameURLs: ["asset://idle/000.png"] },
        { id: "stretch", frameURLs: ["asset://stretch/000.png"] },
      ],
    });
    const next = cyclePlayableSourceAction(record, "idle", 12_000);
    expect(next.action?.id).toBe("stretch");
    expect(next.randomState).toEqual({ packID: "pet", sourceActionID: "stretch", switchedAt: 12_000 });
  });

  it("marks companion drag and landing as physical pet interactions", () => {
    const runtime = emptyRuntime([]).state;
    const dragged = runtimeActions.transientPetIntent(runtime, "dragged", "拖拽中。", "physicalInteraction", 2400);
    expect(dragged.currentPetIntent.kind).toBe("dragged");
    expect(dragged.currentPetIntent.source).toBe("physicalInteraction");
    expect(dragged.currentPetIntent.interruptible).toBe(false);

    const landing = runtimeActions.transientPetIntent(dragged, "landing", "落地。", "physicalInteraction", 1800);
    expect(landing.currentPetIntent.kind).toBe("landing");
    expect(landing.currentPetIntent.source).toBe("physicalInteraction");
  });

  it("clears user recognition exceptions and diagnostic counts", () => {
    const runtime = runtimeActions.addRule(emptyRuntime([]).state, "YouTube 教程", "windowTitle", "work");
    expect(runtime.classificationRules).toHaveLength(1);
    const cleared = runtimeActions.resetRecognitionRules({
      ...runtime,
      recognitionDiagnostic: {
        ...runtime.recognitionDiagnostic,
        userRuleCount: runtime.classificationRules.length,
      },
    });
    expect(cleared.classificationRules).toEqual([]);
    expect(cleared.recognitionDiagnostic.userRuleCount).toBe(0);
    expect(cleared.statusMessage).toBe("用户识别例外已清空。");
  });

  it("hides pet packs and restores them when reimported", () => {
    const runtime = {
      ...emptyRuntime([]).state,
      settings: {
        ...emptyRuntime([]).state.settings,
        pet: {
          ...emptyRuntime([]).state.settings.pet,
          idleSourceActionIDByPack: { preview: "idle" },
          intentSourceActionIDByPack: { preview: { quietCompanion: "idle" } },
        },
      },
    };
    const hidden = runtimeActions.hidePetPack(runtime, "preview");
    expect(hidden.settings.pet.hiddenPackIDs).toEqual(["preview"]);
    expect(hidden.settings.pet.idleSourceActionIDByPack.preview).toBeUndefined();
    expect(hidden.settings.pet.intentSourceActionIDByPack.preview).toBeUndefined();

    const restored = runtimeActions.unhidePetPacks(hidden, ["preview"]);
    expect(restored.settings.pet.hiddenPackIDs).toEqual([]);
  });

  it("prunes stored history according to migrated retention settings", () => {
    const oldStart = "2026-07-01T09:00:00.000Z";
    const oldEnd = "2026-07-01T09:10:00.000Z";
    const recentStart = "2026-07-07T09:00:00.000Z";
    const recentEnd = "2026-07-07T09:10:00.000Z";
    const settings = {
      ...defaultAppSettings(),
      retention: {
        stateRetentionDays: 2,
        appUsageRetentionDays: 2,
        inputActivityRetentionDays: 2,
        sessionRetentionDays: 2,
        nudgeRetentionDays: 2,
      },
    };
    const oldFocus = finishFocusSession(
      makeFocusSession("old", 25, new Date(oldStart)),
      "completed",
      new Date(oldEnd),
    );
    const recentFocus = finishFocusSession(
      makeFocusSession("recent", 25, new Date(recentStart)),
      "completed",
      new Date(recentEnd),
    );
    const pruned = pruneSnapshotForRetention(
      {
        settings,
        classificationRules: [],
        stateSegments: [
          { id: "old-state", start: oldStart, end: oldEnd, state: "focus", appName: "Old", category: "work", titleStored: false, source: ["frontmostApplication"] },
          { id: "recent-state", start: recentStart, end: recentEnd, state: "focus", appName: "Recent", category: "work", titleStored: false, source: ["frontmostApplication"] },
        ],
        appUsage: [
          { id: "old-usage", start: oldStart, end: oldEnd, appName: "Old", category: "work" },
          { id: "recent-usage", start: recentStart, end: recentEnd, appName: "Recent", category: "work" },
        ],
        inputActivity: [
          { start: oldStart, end: oldEnd, keyboardCount: 1, pointerCount: 1, switchCount: 1 },
          { start: recentStart, end: recentEnd, keyboardCount: 2, pointerCount: 2, switchCount: 2 },
        ],
        focusSessions: [oldFocus, recentFocus],
        nudges: [
          { id: "old-nudge", time: oldEnd, reason: "distractedOverThreshold", state: "distracted", appName: "Old", category: "entertainment", petIntent: "nudgeGentle", channel: "desktop", cooldownSeconds: 600, message: "old" },
          { id: "recent-nudge", time: recentEnd, reason: "distractedOverThreshold", state: "distracted", appName: "Recent", category: "entertainment", petIntent: "nudgeGentle", channel: "desktop", cooldownSeconds: 600, message: "recent" },
        ],
      },
      new Date("2026-07-08T09:00:00.000Z"),
    );
    expect(pruned.result.totalRemoved).toBe(5);
    expect(pruned.snapshot.stateSegments.map((segment) => segment.id)).toEqual(["recent-state"]);
    expect(pruned.snapshot.appUsage.map((segment) => segment.id)).toEqual(["recent-usage"]);
    expect(pruned.snapshot.inputActivity[0].keyboardCount).toBe(2);
    expect(pruned.snapshot.focusSessions.map((session) => session.taskName)).toEqual(["recent"]);
    expect(pruned.snapshot.nudges.map((nudge) => nudge.id)).toEqual(["recent-nudge"]);
  });

  it("removes private app and task metadata before a redacted native export", () => {
    const start = "2026-07-18T09:00:00.000Z";
    const end = "2026-07-18T09:10:00.000Z";
    const session = {
      ...finishFocusSession(makeFocusSession("Secret project", 25, new Date(start)), "completed", new Date(end)),
      mainAppName: "Secret Editor",
    };
    const redacted = redactedSnapshot({
      ...emptySnapshot(),
      classificationRules: [
        { id: "secret-rule", matchKind: "windowTitle", pattern: "Secret project", category: "work", priority: 0 },
      ],
      stateSegments: [
        {
          id: "secret-state",
          start,
          end,
          state: "focus",
          appName: "Secret Editor",
          bundleID: "com.example.secret",
          category: "work",
          titleStored: true,
          titleDisplay: "Secret project - Draft",
          source: ["frontmostApplication"],
        },
      ],
      appUsage: [
        { id: "secret-usage", start, end, appName: "Secret Editor", bundleID: "com.example.secret", category: "work" },
      ],
      focusSessions: [session],
      nudges: [
        {
          id: "secret-nudge",
          time: end,
          reason: "distractedOverThreshold",
          state: "distracted",
          appName: "Secret Game",
          category: "entertainment",
          petIntent: "nudgeGentle",
          channel: "desktop",
          cooldownSeconds: 600,
          message: "return to focus",
        },
      ],
    });

    expect(redacted.classificationRules).toEqual([]);
    expect(redacted.stateSegments[0]).toMatchObject({
      appName: "工作工具",
      titleStored: false,
      bundleID: undefined,
      titleDisplay: undefined,
    });
    expect(redacted.appUsage[0]).toMatchObject({ appName: "工作工具", bundleID: undefined });
    expect(redacted.focusSessions[0]).toMatchObject({ taskName: "专注任务", mainAppName: undefined });
    expect(redacted.nudges[0].appName).toBe("容易分心");
  });

  it("builds a compact desktop pet payload without persisted history", () => {
    const runtime = emptyRuntime().state;
    const payload = makePetCompanionViewState(
      {
        ...runtime,
        summary: { ...runtime.summary, focusSeconds: 420, distractedSeconds: 30 },
        todayWorkload: { ...runtime.todayWorkload, estimatedTypedCharacters: 128, pointerActionCount: 42 },
      },
    );

    expect(payload.summary).toEqual({ focusSeconds: 420, distractedSeconds: 30 });
    expect(payload.todayWorkload).toEqual({ estimatedTypedCharacters: 128, pointerActionCount: 42 });
    expect(payload).not.toHaveProperty("stateSegments");
    expect(payload).not.toHaveProperty("appUsage");
    expect(payload).not.toHaveProperty("inputActivity");
  });

  it("turns an agent completion event into a high-priority pet intent", () => {
    const state = runtimeActions.transientPetIntent(
      emptyRuntime().state,
      "taskCompleted",
      "Codex 已完成：主题验收",
      "agent",
      12_000,
    );
    expect(state.currentPetIntent.kind).toBe("taskCompleted");
    expect(state.currentPetIntent.source).toBe("agent");
    expect(state.latestPetBubble).toBe("Codex 已完成：主题验收");
  });
});
