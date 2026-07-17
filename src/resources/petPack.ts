import type { PetAction, PetIntentKind } from "../core/types";
import { intentFromLegacyAction, preferredSourceActionIDs } from "../core/pet";

export interface PetPackSize {
  width: number;
  height: number;
}

export interface PetPackAnchor {
  x: number;
  y: number;
}

export interface PetAnimationSpec {
  folder: string;
  fps: number;
  loop: boolean;
  frameCount?: number;
}

export interface PetAudioSpec {
  file: string;
  volume: number;
}

export interface PetSourceActionSpec {
  id: string;
  title: string;
  folder: string;
  fps: number;
  loop: boolean;
  frameCount?: number;
  audio?: PetAudioSpec;
}

export interface PetPack {
  schemaVersion: number;
  id: string;
  name: string;
  author: string;
  style: string;
  license: string;
  distribution: string;
  defaultSize: PetPackSize;
  anchor: PetPackAnchor;
  animations: Partial<Record<PetAction, PetAnimationSpec>>;
  audio: Partial<Record<PetAction, PetAudioSpec>>;
  sourceActions: PetSourceActionSpec[];
  idleSourceActionIDs: string[];
}

export interface PetPackRecord {
  id: string;
  name: string;
  author: string;
  style: string;
  license: string;
  distribution: string;
  path?: string;
  previewURL?: string;
  pack: PetPack;
  validation: PetPackValidationResult;
  sourceActionAssets?: PetSourceActionAssets[];
}

export interface PetSourceActionAssets {
  id: string;
  frameURLs: string[];
  audioURL?: string;
}

export type PetPackValidationError =
  | "unsupportedSchema"
  | "missingID"
  | "missingName"
  | "missingSourceActions"
  | `missingRequiredAction:${PetAction}`
  | `invalidFrameCount:${PetAction}`
  | `missingAnimationFolder:${PetAction}`
  | `missingAnimationFrames:${PetAction}`;

export type PetPackValidationWarning = "missingPreview" | "missingLicense" | "missingDistribution";

export interface PetPackValidationResult {
  errors: PetPackValidationError[];
  warnings: PetPackValidationWarning[];
  isValid: boolean;
}

const legacyAction = (key: string): PetAction | undefined => {
  switch (key) {
    case "sleeping":
      return "sleep";
    case "nudgeDistracted":
      return "distractedLook";
    case "nudgeEntertainment":
      return "nudgeStrong";
    case "welcomeBack":
      return "welcomeBack";
    case "idleSpecial":
      return "idle";
    case "playfulIdle":
      return "run";
    default:
      return undefined;
  }
};

const petActionValues: PetAction[] = [
  "idle",
  "blink",
  "breath",
  "sleep",
  "wake",
  "focusStart",
  "focusStable",
  "stretch",
  "distractedLook",
  "nudgeGentle",
  "nudgeStrong",
  "welcomeBack",
  "dragged",
  "landing",
  "run",
  "screenTransfer",
  "mouseSummon",
];

const parseAudio = (value: unknown): PetAudioSpec | undefined => {
  if (typeof value === "string") return { file: value, volume: 0.55 };
  if (value && typeof value === "object") {
    const record = value as Partial<PetAudioSpec>;
    if (typeof record.file === "string") return { file: record.file, volume: Math.min(1, Math.max(0, record.volume ?? 0.55)) };
  }
  return undefined;
};

export const normalizePetPack = (raw: unknown): PetPack => {
  const record = raw as Partial<PetPack> & {
    animations?: Record<string, PetAnimationSpec>;
    audio?: Record<string, unknown>;
    license?: string | { type?: string; note?: string };
  };
  const animations: Partial<Record<PetAction, PetAnimationSpec>> = {};
  for (const [key, animation] of Object.entries(record.animations ?? {})) {
    const action = petActionValues.includes(key as PetAction) ? (key as PetAction) : legacyAction(key);
    if (!action || animations[action]) continue;
    animations[action] = {
      folder: animation.folder,
      fps: Math.max(1, animation.fps),
      loop: Boolean(animation.loop),
      frameCount: animation.frameCount === undefined ? undefined : Math.max(0, animation.frameCount),
    };
  }
  const audio: Partial<Record<PetAction, PetAudioSpec>> = {};
  for (const [key, audioValue] of Object.entries(record.audio ?? {})) {
    const action = petActionValues.includes(key as PetAction) ? (key as PetAction) : legacyAction(key);
    const parsed = parseAudio(audioValue);
    if (!action || !parsed || audio[action]) continue;
    audio[action] = parsed;
  }
  let license = "";
  if (typeof record.license === "string") {
    license = record.license;
  } else if (record.license && typeof record.license === "object") {
    const legacyLicense = record.license as { type?: string; note?: string };
    license = [legacyLicense.type, legacyLicense.note].filter(Boolean).join(" · ");
  }
  return {
    schemaVersion: record.schemaVersion ?? 1,
    id: record.id ?? "",
    name: record.name ?? "",
    author: record.author ?? "Focus Pet",
    style: record.style ?? "minimal_2d",
    license,
    distribution: record.distribution ?? "",
    defaultSize: {
      width: Math.max(1, record.defaultSize?.width ?? 120),
      height: Math.max(1, record.defaultSize?.height ?? 120),
    },
    anchor: {
      x: record.anchor?.x ?? 0.5,
      y: record.anchor?.y ?? 1,
    },
    animations,
    audio,
    sourceActions: (record.sourceActions ?? []).map((action) => ({
      id: action.id,
      title: action.title || action.id,
      folder: action.folder,
      fps: Math.max(1, action.fps),
      loop: Boolean(action.loop),
      frameCount: action.frameCount === undefined ? undefined : Math.max(0, action.frameCount),
      audio: action.audio,
    })),
    idleSourceActionIDs: record.idleSourceActionIDs ?? [],
  };
};

export const semanticAnimationKey = (action: PetAction, pack: PetPack): PetAction | undefined => {
  if (pack.animations[action]) return action;
  const fallbacks: Partial<Record<PetAction, PetAction[]>> = {
    focusStart: ["idle", "breath", "blink"],
    focusStable: ["breath", "idle", "blink"],
    stretch: ["blink", "idle"],
    distractedLook: ["nudgeGentle", "idle"],
    nudgeGentle: ["distractedLook", "blink", "idle"],
    nudgeStrong: ["nudgeGentle", "distractedLook", "idle"],
    welcomeBack: ["wake", "idle"],
    dragged: ["idle"],
    landing: ["idle"],
    run: ["screenTransfer", "idle"],
    screenTransfer: ["run", "idle"],
    mouseSummon: ["welcomeBack", "run", "idle"],
  };
  return fallbacks[action]?.find((fallback) => pack.animations[fallback]);
};

export const animationKeyForAction = (action: PetAction, pack: PetPack): PetAction | undefined =>
  semanticAnimationKey(action, pack) ?? (Object.keys(pack.animations).sort()[0] as PetAction | undefined);

export const resolveSourceActionForIntent = (
  intent: PetIntentKind,
  pack: PetPack,
  customSourceActionID?: string,
): PetSourceActionSpec | undefined => {
  if (customSourceActionID) {
    const custom = pack.sourceActions.find((action) => action.id === customSourceActionID);
    if (custom) return custom;
  }
  const preferred = preferredSourceActionIDs[intent];
  return (
    preferred.map((id) => pack.sourceActions.find((action) => action.id === id)).find(Boolean) ??
    pack.sourceActions.find((action) => action.id === intent) ??
    pack.sourceActions.find((action) => intentFromLegacyAction(action.id as PetAction) === intent) ??
    pack.sourceActions[0]
  );
};

export const validatePetPack = (
  pack: PetPack,
  options: { previewExists?: boolean; requiredActions?: PetAction[]; folderExists?: (folder: string) => boolean; folderHasPng?: (folder: string) => boolean } = {},
): PetPackValidationResult => {
  const errors: PetPackValidationError[] = [];
  const warnings: PetPackValidationWarning[] = [];
  if (pack.schemaVersion !== 1) errors.push("unsupportedSchema");
  if (pack.id.trim().length === 0) errors.push("missingID");
  if (pack.name.trim().length === 0) errors.push("missingName");
  if (pack.sourceActions.length === 0 && Object.keys(pack.animations).length === 0) errors.push("missingSourceActions");
  for (const action of options.requiredActions ?? []) {
    if (!semanticAnimationKey(action, pack)) errors.push(`missingRequiredAction:${action}`);
  }
  for (const [action, animation] of Object.entries(pack.animations) as [PetAction, PetAnimationSpec][]) {
    if ((animation.frameCount ?? 1) < 0) errors.push(`invalidFrameCount:${action}`);
    if (options.folderExists && !options.folderExists(animation.folder)) {
      errors.push(`missingAnimationFolder:${action}`);
    } else if (options.folderHasPng && !options.folderHasPng(animation.folder)) {
      errors.push(`missingAnimationFrames:${action}`);
    }
  }
  if (options.previewExists === false) warnings.push("missingPreview");
  if (pack.license.trim().length === 0) warnings.push("missingLicense");
  if (pack.distribution.trim().length === 0) warnings.push("missingDistribution");
  return { errors, warnings, isValid: errors.length === 0 };
};

export const importedPetPackRecord = (record: PetPackRecord, previewURL?: string): PetPackRecord => {
  const pack = normalizePetPack(record.pack);
  const resolvedPreviewURL = previewURL ?? record.previewURL;
  return {
    ...record,
    id: pack.id || record.id,
    name: pack.name || record.name,
    author: pack.author || record.author,
    style: pack.style || record.style,
    license: pack.license || record.license,
    distribution: pack.distribution || record.distribution,
    previewURL: resolvedPreviewURL,
    pack,
    validation: record.validation ?? validatePetPack(pack, { previewExists: Boolean(resolvedPreviewURL) }),
    sourceActionAssets: record.sourceActionAssets ?? [],
  };
};

export const sourceActionAssetsForID = (record: PetPackRecord, sourceActionID?: string): PetSourceActionAssets | undefined => {
  if (!sourceActionID) return undefined;
  return record.sourceActionAssets?.find((asset) => asset.id === sourceActionID);
};

export const demoPetPackRecords = (): PetPackRecord[] => {
  const packs = [
    {
      id: "preview-luo-xiaohei",
      name: "罗小黑",
      author: "IXiaoHei 转换预览",
      previewURL: `${import.meta.env.BASE_URL}assets/pet-luo-xiaohei.png`,
      style: "2d",
    },
    {
      id: "preview-xiaodai",
      name: "小呆",
      author: "DyberPet 生态预览",
      previewURL: `${import.meta.env.BASE_URL}assets/pet-xiaodai.png`,
      style: "2d",
    },
    {
      id: "preview-pixel-cat",
      name: "像素猫 meme",
      author: "DyberPet 生态预览",
      previewURL: `${import.meta.env.BASE_URL}assets/pet-pixel-cat.png`,
      style: "pixel",
    },
  ];
  return packs.map((item) => {
    const pack = normalizePetPack({
      schemaVersion: 1,
      id: item.id,
      name: item.name,
      author: item.author,
      style: item.style,
      license: "本地预览素材",
      distribution: "preview-only",
      defaultSize: { width: 150, height: 150 },
      anchor: { x: 0.5, y: 1 },
      animations: {
        idle: { folder: "idle", fps: 12, loop: true, frameCount: 1 },
        sleep: { folder: "sleep", fps: 8, loop: true, frameCount: 1 },
        nudgeGentle: { folder: "nudge", fps: 12, loop: false, frameCount: 1 },
      },
      sourceActions: [
        { id: "idle", title: "待机", folder: "idle", fps: 12, loop: true, frameCount: 1 },
        { id: "sleep", title: "睡觉", folder: "sleep", fps: 8, loop: true, frameCount: 1 },
        { id: "nudgeGentle", title: "轻提醒", folder: "nudge", fps: 12, loop: false, frameCount: 1 },
      ],
      idleSourceActionIDs: ["idle"],
    });
    return {
      id: item.id,
      name: item.name,
      author: item.author,
      style: item.style,
      license: pack.license,
      distribution: pack.distribution,
      previewURL: item.previewURL,
      pack,
      validation: validatePetPack(pack, { previewExists: true }),
      sourceActionAssets: [
        {
          id: "idle",
          frameURLs: [item.previewURL],
        },
        {
          id: "sleep",
          frameURLs: [item.previewURL],
        },
        {
          id: "nudgeGentle",
          frameURLs: [item.previewURL],
        },
      ],
    };
  });
};
