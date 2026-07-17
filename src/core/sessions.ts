import type { FocusSession, FocusSessionStatus } from "./types";
import { makeID, secondsBetween, safeTrim } from "./utils";

export const makeFocusSession = (
  taskName: string,
  minutes: number,
  start = new Date(),
): FocusSession => ({
  id: makeID("focus"),
  taskName: safeTrim(taskName) ?? "专注任务",
  start: start.toISOString(),
  targetDurationSeconds: Math.max(60, Math.round(minutes * 60)),
  end: undefined,
  effectiveFocusSeconds: 0,
  distractedSeconds: 0,
  awaySeconds: 0,
  switchCount: 0,
  interruptionCount: 0,
  mainAppName: undefined,
  completed: false,
  status: "active",
});

export const remainingFocusSeconds = (session: FocusSession, now = new Date()): number =>
  Math.max(0, session.targetDurationSeconds - secondsBetween(session.start, session.end ?? now));

export const finishFocusSession = (
  session: FocusSession,
  status: FocusSessionStatus,
  end = new Date(),
  mainAppName?: string,
): FocusSession => ({
  ...session,
  end: end.toISOString(),
  status,
  completed: status === "completed",
  mainAppName: mainAppName ?? session.mainAppName,
});

export const activeFocusSession = (sessions: FocusSession[]): FocusSession | undefined =>
  [...sessions].reverse().find((session) => session.status === "active" && !session.end);
