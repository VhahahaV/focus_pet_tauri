import type {
  AppUsageSegment,
  BreakSession,
  FocusSession,
  InputActivityBucket,
  LocalStoreSnapshot,
  NativeRuntimeDelta,
  NudgeEvent,
  StateSegment,
} from "../core/types";

const upsertLatest = <T,>(
  current: T[],
  incoming: T[] | undefined,
  key: (item: T) => string,
): T[] => {
  if (!incoming?.length) return current;
  let next = current;
  for (const item of incoming) {
    const itemKey = key(item);
    // Native deltas update the tail; search newest first.
    const index = next.findLastIndex((candidate) => key(candidate) === itemKey);
    if (index < 0) {
      if (next === current) next = [...current];
      next.push(item);
      continue;
    }
    // IPC decoding creates fresh objects even when an inactive collection did
    // not change. Preserve that collection's reference so unrelated charts do
    // not recompute on every resident sample.
    if (next[index] === item || JSON.stringify(next[index]) === JSON.stringify(item)) continue;
    if (next === current) next = [...current];
    next[index] = item;
  }
  return next;
};

const idKey = (item: { id: string }): string => item.id;
const inputKey = (item: InputActivityBucket): string => `${item.start}|${item.end}`;

/** Merge the bounded resident-runtime event into retained WebView history.
 * Each native event contains only the latest items from collections that can
 * change during a sample, avoiding an all-history JSON decode every 5 seconds. */
export const mergeNativeRuntimeDelta = (
  current: LocalStoreSnapshot,
  delta: NativeRuntimeDelta | undefined,
): LocalStoreSnapshot => {
  if (!delta) return current;
  return {
    ...current,
    stateSegments: upsertLatest<StateSegment>(current.stateSegments, delta.stateSegments, idKey),
    appUsage: upsertLatest<AppUsageSegment>(current.appUsage, delta.appUsage, idKey),
    inputActivity: upsertLatest(current.inputActivity, delta.inputActivity, inputKey),
    focusSessions: upsertLatest<FocusSession>(current.focusSessions, delta.focusSessions, idKey),
    breakSessions: upsertLatest<BreakSession>(current.breakSessions, delta.breakSessions, idKey),
    nudges: upsertLatest<NudgeEvent>(current.nudges, delta.nudges, idKey),
  };
};
