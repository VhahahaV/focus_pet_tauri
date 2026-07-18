import type { PetIntent, PetSettings } from "../core/types";
import {
  resolveSourceActionForIntent,
  sourceActionAssetsForID,
  type PetPackRecord,
  type PetSourceActionSpec,
} from "../resources/petPack";

export interface RandomSourceActionState {
  packID?: string;
  sourceActionID?: string;
  switchedAt?: number;
}

export interface ResolvedPetSourceAction {
  action?: PetSourceActionSpec;
  randomState: RandomSourceActionState;
}

export const nextPetFrameIndex = (
  currentIndex: number,
  frameCount: number,
  animationEnabled: boolean,
  loop = true,
): number => {
  if (frameCount <= 0) return 0;
  const current = Math.max(0, Math.min(Math.trunc(currentIndex), frameCount - 1));
  if (!animationEnabled || frameCount === 1) return current;
  const next = current + 1;
  if (next < frameCount) return next;
  return loop ? 0 : current;
};

const playableSourceActions = (record: PetPackRecord): PetSourceActionSpec[] => {
  const seen = new Set<string>();
  const actions: PetSourceActionSpec[] = [];
  for (const action of record.pack.sourceActions) {
    if (seen.has(action.id)) continue;
    const assets = sourceActionAssetsForID(record, action.id);
    const isPlayable = !record.sourceActionAssets || record.sourceActionAssets.length === 0 || Boolean(assets?.frameURLs.length);
    if (!isPlayable) continue;
    seen.add(action.id);
    actions.push(action);
  }
  return actions;
};

export const cyclePlayableSourceAction = (
  record: PetPackRecord | undefined,
  currentSourceActionID: string | undefined,
  now = Date.now(),
): ResolvedPetSourceAction => {
  if (!record) return { action: undefined, randomState: {} };
  const candidates = playableSourceActions(record);
  if (candidates.length === 0) return { action: undefined, randomState: {} };
  const currentIndex = currentSourceActionID
    ? candidates.findIndex((action) => action.id === currentSourceActionID)
    : -1;
  const next = candidates[(currentIndex + 1) % candidates.length];
  return {
    action: next,
    randomState: { packID: record.id, sourceActionID: next.id, switchedAt: now },
  };
};

const nextRandomIndex = (length: number, currentIndex: number, random: () => number): number => {
  let nextIndex = Math.floor(random() * length);
  if (nextIndex === currentIndex) nextIndex = (nextIndex + 1) % length;
  return nextIndex;
};

export const resolveDisplaySourceAction = (
  intent: PetIntent,
  record: PetPackRecord | undefined,
  settings: PetSettings,
  randomState: RandomSourceActionState,
  now = Date.now(),
  random = Math.random,
): ResolvedPetSourceAction => {
  if (!record) return { action: undefined, randomState: {} };
  const mappedSourceActionID = settings.intentSourceActionIDByPack[record.id]?.[intent.kind];
  const fallback = resolveSourceActionForIntent(intent.kind, record.pack, mappedSourceActionID);
  if (!settings.randomActionSwitchEnabled || intent.source === "physicalInteraction") {
    return { action: fallback, randomState: {} };
  }

  const candidates = playableSourceActions(record);
  if (candidates.length <= 1) return { action: fallback, randomState: {} };

  const intervalMs = Math.max(15, settings.randomActionSwitchSeconds) * 1000;
  const currentIndex =
    randomState.packID === record.id && randomState.sourceActionID
      ? candidates.findIndex((action) => action.id === randomState.sourceActionID)
      : -1;

  if (currentIndex < 0 || randomState.switchedAt === undefined) {
    const initialID =
      fallback && candidates.some((action) => action.id === fallback.id)
        ? fallback.id
        : candidates[nextRandomIndex(candidates.length, -1, random)].id;
    return {
      action: candidates.find((action) => action.id === initialID) ?? fallback,
      randomState: { packID: record.id, sourceActionID: initialID, switchedAt: now },
    };
  }

  if (now - randomState.switchedAt < intervalMs) {
    return {
      action: candidates[currentIndex],
      randomState,
    };
  }

  const next = candidates[nextRandomIndex(candidates.length, currentIndex, random)];
  return {
    action: next,
    randomState: { packID: record.id, sourceActionID: next.id, switchedAt: now },
  };
};
