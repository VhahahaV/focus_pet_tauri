import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Eye,
  Import,
  Link2,
  LoaderCircle,
  PawPrint,
  Play,
  RefreshCw,
  Repeat2,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusPet } from "../app/AppContext";
import { petIntentLabels, petPlacementLabels } from "../core/labels";
import { advancedMappingIntents, userMappingIntents } from "../core/pet";
import type { PetIntentKind } from "../core/types";
import { SegmentedControl, SliderRow, SoftButton, TogglePill } from "./ui";
import {
  resolveSourceActionForIntent,
  sourceActionAssetsForID,
  type PetPackRecord,
  type PetSourceActionSpec,
} from "../resources/petPack";

const fallbackPetPreviewURL = `${import.meta.env.BASE_URL}assets/pet-pixel-cat.png`;

const validationIssueTitle = (issue: string): string => {
  if (issue === "unsupportedSchema") return "Schema 不支持";
  if (issue === "missingID") return "缺少 ID";
  if (issue === "missingName") return "缺少名称";
  if (issue === "missingSourceActions") return "缺少动作资源";
  if (issue === "missingPreview") return "缺少预览图";
  if (issue === "missingLicense") return "缺少许可证";
  if (issue === "missingDistribution") return "缺少分发说明";
  if (issue.startsWith("missingRequiredAction:")) return `缺少动作 ${issue.replace("missingRequiredAction:", "")}`;
  if (issue.startsWith("invalidFrameCount:")) return `帧数异常 ${issue.replace("invalidFrameCount:", "")}`;
  if (issue.startsWith("missingAnimationFolder:")) return `缺少目录 ${issue.replace("missingAnimationFolder:", "")}`;
  if (issue.startsWith("missingAnimationFrames:")) return `缺少帧 ${issue.replace("missingAnimationFrames:", "")}`;
  return issue;
};

const intervalTitle = (seconds: number): string => {
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds % 60 !== 0) return `${seconds} 秒`;
  return `${seconds / 60} 分钟`;
};

const playableSourceActions = (record: PetPackRecord): PetSourceActionSpec[] => {
  const assets = record.sourceActionAssets ?? [];
  if (assets.length === 0) return record.pack.sourceActions;
  const playableIDs = new Set(assets.filter((asset) => asset.frameURLs.length > 0).map((asset) => asset.id));
  const playable = record.pack.sourceActions.filter((action) => playableIDs.has(action.id));
  return playable.length > 0 ? playable : record.pack.sourceActions;
};

const resolvePreviewAction = (
  record: PetPackRecord | undefined,
  intent: PetIntentKind,
  mappedSourceActionID: string | undefined,
  previewSourceActionID: string | undefined,
  actions: PetSourceActionSpec[],
): PetSourceActionSpec | undefined => {
  if (!record) return undefined;
  const preview = actions.find((action) => action.id === previewSourceActionID);
  if (preview) return preview;
  const resolved = resolveSourceActionForIntent(intent, record.pack, mappedSourceActionID);
  if (resolved && actions.some((action) => action.id === resolved.id)) return resolved;
  return actions[0] ?? resolved;
};

const PetPreviewStage = ({ record, action }: { record: PetPackRecord; action?: PetSourceActionSpec }) => {
  const frames = useMemo(() => (action ? sourceActionAssetsForID(record, action.id)?.frameURLs ?? [] : []), [action, record]);
  const [frameIndex, setFrameIndex] = useState(0);
  const previewFPS = Math.min(6, Math.max(1, action?.fps ?? 6));

  useEffect(() => {
    setFrameIndex(0);
  }, [action?.id, frames.length]);

  useEffect(() => {
    if (!action || frames.length <= 1) return;
    const timer = window.setInterval(() => {
      setFrameIndex((current) => (current + 1) % frames.length);
    }, 1000 / previewFPS);
    return () => window.clearInterval(timer);
  }, [action, frames.length, previewFPS]);

  const frameURL = frames[frameIndex % Math.max(1, frames.length)] ?? record.previewURL ?? fallbackPetPreviewURL;

  return (
    <div className="pet-preview-stage">
      {frameURL ? <img src={frameURL} alt="" /> : <PawPrint className="pet-preview-placeholder" size={34} />}
      <span>{action?.title ?? "未选择"}</span>
      {action ? <em>{Math.round(Math.min(action.fps, previewFPS))} fps</em> : null}
    </div>
  );
};

export const PetTab = () => {
  const { bundle, petPacks, actions } = useFocusPet();
  const selectedPack = petPacks.find((record) => record.id === bundle.state.settings.pet.selectedPackID) ?? petPacks[0];
  const [selectedIntent, setSelectedIntent] = useState<PetIntentKind>("quietCompanion");
  const [showsAdvancedIntents, setShowsAdvancedIntents] = useState(false);
  const [previewSourceActionID, setPreviewSourceActionID] = useState<string | undefined>(undefined);
  const [pendingPetAction, setPendingPetAction] = useState<string | undefined>(undefined);
  const initialRefreshPetPacks = useRef(actions.refreshPetPacks);
  const sourceActions = useMemo(() => (selectedPack ? playableSourceActions(selectedPack) : []), [selectedPack]);
  const mapped = selectedPack
    ? bundle.state.settings.pet.intentSourceActionIDByPack[selectedPack.id]?.[selectedIntent]
    : undefined;
  const selectedAction = resolvePreviewAction(selectedPack, selectedIntent, mapped, previewSourceActionID, sourceActions);
  const previewURL = selectedPack?.previewURL ?? fallbackPetPreviewURL;
  const petStatusMessage = /资源包|桌宠/.test(bundle.state.statusMessage) ? bundle.state.statusMessage : undefined;

  useEffect(() => {
    setPreviewSourceActionID(undefined);
  }, [selectedPack?.id]);

  useEffect(() => {
    void initialRefreshPetPacks.current();
  }, []);

  const selectIntent = (intent: PetIntentKind) => {
    setSelectedIntent(intent);
    if (!selectedPack) return;
    const nextMapped = bundle.state.settings.pet.intentSourceActionIDByPack[selectedPack.id]?.[intent];
    const nextResolved = resolveSourceActionForIntent(intent, selectedPack.pack, nextMapped);
    const nextActions = playableSourceActions(selectedPack);
    setPreviewSourceActionID(nextResolved?.id ?? nextActions[0]?.id);
  };

  const mapAction = (sourceAction: PetSourceActionSpec) => {
    if (!selectedPack) return;
    setPreviewSourceActionID(sourceAction.id);
    actions.updateSettings((settings) => ({
      ...settings,
      pet: {
        ...settings.pet,
        intentSourceActionIDByPack: {
          ...settings.pet.intentSourceActionIDByPack,
          [selectedPack.id]: {
            ...(settings.pet.intentSourceActionIDByPack[selectedPack.id] ?? {}),
            [selectedIntent]: sourceAction.id,
          },
        },
      },
    }));
  };

  const deletePack = async (record: PetPackRecord) => {
    const confirmed = window.confirm(`删除 ${record.pack.name}？\n会从本机移除已导入副本，并在列表中隐藏同 ID 的随应用资源。`);
    if (!confirmed) return;
    setPendingPetAction(`delete:${record.id}`);
    try {
      await actions.deletePetPack(record.id);
    } finally {
      setPendingPetAction(undefined);
    }
  };

  const runPetAction = async (key: "import" | "refresh", action: () => Promise<void>) => {
    if (pendingPetAction) return;
    setPendingPetAction(key);
    try {
      await action();
    } finally {
      setPendingPetAction(undefined);
    }
  };

  return (
    <div className="swift-pet-page">
      <h1 className="sr-only">桌宠</h1>
      <section className="pet-settings-shell">
        <div className="pet-panel-header">
          <div>
            <h2><PawPrint size={18} /> 桌宠设置</h2>
            <span>资源包</span>
          </div>
          <div className="pet-header-actions">
            <SoftButton status="pet" size="small" disabled={Boolean(pendingPetAction)} type="button" onClick={() => void runPetAction("import", actions.importPetPack)}>
              {pendingPetAction === "import" ? <LoaderCircle className="button-spinner" size={15} /> : <Import size={15} />} 导入
            </SoftButton>
            <SoftButton status="pet" size="small" disabled={Boolean(pendingPetAction)} type="button" onClick={() => void runPetAction("refresh", actions.refreshPetPacks)}>
              {pendingPetAction === "refresh" ? <LoaderCircle className="button-spinner" size={15} /> : <RefreshCw size={15} />} 刷新
            </SoftButton>
          </div>
        </div>

        <section className="pet-settings-section status-pet">
          <h3><Import size={15} /> 资源包</h3>
          <div className="pet-pack-selection-grid">
            <span className="pet-pack-grid-title">资源包</span>
            {petPacks.length === 0 ? (
              <button disabled={Boolean(pendingPetAction)} className="pet-pack-empty-card" type="button" onClick={() => void runPetAction("import", actions.importPetPack)}>
                <img className="pet-empty-mascot" src={fallbackPetPreviewURL} alt="" />
                <span>{pendingPetAction === "import" ? <LoaderCircle className="button-spinner" size={18} /> : <Import size={18} />}</span>
                <div>
                  <strong>暂无桌宠资源包</strong>
                  <small>导入单个 .zip 或包含 pet.json 的文件夹后再显示桌宠</small>
                </div>
              </button>
            ) : (
              <div className="pet-pack-grid">
                {petPacks.map((record) => {
                  const isSelected = selectedPack?.id === record.id;
                  return (
                    <div className={`pet-pack-card ${isSelected ? "active" : ""}`} key={record.id}>
                      <button aria-pressed={isSelected} className="pet-pack-card-main" type="button" onClick={() => actions.selectPetPack(record.id)}>
                        <img src={record.previewURL ?? fallbackPetPreviewURL} alt="" />
                        <span>
                          <strong>{record.pack.name}</strong>
                          <small>{record.pack.style || record.style}</small>
                        </span>
                        {isSelected ? <CheckCircle2 size={16} /> : <i />}
                      </button>
                      <button
                        aria-label={`删除资源包 ${record.pack.name}`}
                        className="pet-pack-delete-button"
                        disabled={Boolean(pendingPetAction)}
                        type="button"
                        onClick={() => void deletePack(record)}
                      >
                        {pendingPetAction === `delete:${record.id}` ? <LoaderCircle className="button-spinner" size={13} /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {petStatusMessage && petPacks.length > 0 ? <p className="pet-pack-message">{petStatusMessage}</p> : null}
        </section>

        {selectedPack ? (
          <section className="pet-settings-section status-focus">
            <h3><Link2 size={15} /> 动作映射</h3>
            <div className="pet-selected-summary">
              <img src={previewURL} alt="" />
              <div>
                <h3>{selectedPack.pack.name}</h3>
                <span>作者 {selectedPack.pack.author} · {selectedPack.pack.style}</span>
                <p>动作 {sourceActions.length} 个 · 音效 {Object.keys(selectedPack.pack.audio).length} 个</p>
                {selectedPack.validation.errors.length > 0 ? (
                  <small className="pet-validation-line error">错误：{selectedPack.validation.errors.map(validationIssueTitle).join("、")}</small>
                ) : null}
                {selectedPack.validation.warnings.length > 0 ? (
                  <small className="pet-validation-line">提示：{selectedPack.validation.warnings.map(validationIssueTitle).join("、")}</small>
                ) : null}
              </div>
              <em className={selectedPack.validation.isValid ? "" : "warning"}>
                {selectedPack.validation.isValid ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
                {selectedPack.validation.isValid ? "可用" : "需修复"}
              </em>
            </div>

            <div className="pet-mapping-panel">
              <div className="pet-mapping-header">
                <strong><Link2 size={14} /> 意图映射台</strong>
                <span>{petIntentLabels[selectedIntent]} -&gt; {selectedAction?.title ?? "未选择"}</span>
                <em>{selectedAction?.id === mapped || (!mapped && selectedAction) ? "当前映射" : "待映射"}</em>
              </div>

              <div className="pet-mapping-row">
                <h4><Sparkles size={14} /> 触发场景</h4>
                <div className="intent-row primary">
                  {userMappingIntents.map((intent) => (
                    <button
                      aria-pressed={selectedIntent === intent}
                      className={selectedIntent === intent ? "active" : ""}
                      key={intent}
                      type="button"
                      onClick={() => selectIntent(intent)}
                    >
                      <Link2 size={14} />
                      {petIntentLabels[intent]}
                    </button>
                  ))}
                </div>
                {showsAdvancedIntents ? (
                  <div className="intent-row primary compact">
                    {advancedMappingIntents.map((intent) => (
                      <button
                        aria-pressed={selectedIntent === intent}
                        className={selectedIntent === intent ? "active" : ""}
                        key={intent}
                        type="button"
                        onClick={() => selectIntent(intent)}
                      >
                        <Link2 size={14} />
                        {petIntentLabels[intent]}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button className="pet-advanced-toggle" type="button" onClick={() => setShowsAdvancedIntents((current) => !current)}>
                  <ChevronDown className={showsAdvancedIntents ? "expanded" : ""} size={13} />
                  {showsAdvancedIntents ? "收起进阶动作" : "显示进阶动作"}
                </button>
              </div>

              <div className="pet-mapping-row">
                <h4><Play size={14} /> 动作资源</h4>
                <div className="intent-row actions">
                  {sourceActions.map((sourceAction) => {
                    const isSelected = selectedAction?.id === sourceAction.id;
                    return (
                      <button
                        aria-pressed={isSelected}
                        className={`mapping-chip action-chip ${isSelected ? "active" : ""}`}
                        key={sourceAction.id}
                        type="button"
                        onClick={() => mapAction(sourceAction)}
                      >
                        {isSelected ? <CheckCircle2 size={14} /> : sourceAction.loop ? <Repeat2 size={14} /> : <Play size={13} />}
                        <span>
                          <strong>{sourceAction.title}</strong>
                          <small>{isSelected ? "当前映射" : sourceAction.loop ? "循环" : "一次"}</small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <PetPreviewStage record={selectedPack} action={selectedAction} />
            </div>
          </section>
        ) : null}

        <section className="pet-settings-section status-rest">
          <h3><Sparkles size={15} /> 显示行为</h3>
          <div className="pet-toggle-grid">
            <TogglePill status="pet" checked={!bundle.state.settings.pet.hidden} disabled={petPacks.length === 0} onCheckedChange={actions.togglePetHidden}>
              <Eye size={16} /> 显示桌宠
            </TogglePill>
            <TogglePill status="pet" checked={bundle.state.settings.pet.animationEnabled} onCheckedChange={(checked) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, animationEnabled: checked } }))}>
              <Shuffle size={16} /> 动画
            </TogglePill>
            <TogglePill status="pet" checked={bundle.state.settings.pet.audioEnabled} onCheckedChange={(checked) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, audioEnabled: checked } }))}>
              <Volume2 size={16} /> 音效
            </TogglePill>
            <TogglePill status="pet" checked={bundle.state.settings.pet.hoverStatusEnabled} onCheckedChange={(checked) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, hoverStatusEnabled: checked } }))}>
              <PawPrint size={16} /> 悬浮状态弹窗
            </TogglePill>
          </div>

          <div className="random-action-panel">
            <TogglePill status="pet" checked={bundle.state.settings.pet.randomActionSwitchEnabled} onCheckedChange={(checked) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, randomActionSwitchEnabled: checked } }))}>
              <Shuffle size={16} /> 随机换动作
            </TogglePill>
            <div>
              <label><Timer size={14} /> 切换间隔 <strong>{intervalTitle(bundle.state.settings.pet.randomActionSwitchSeconds)}</strong></label>
              <SegmentedControl
                className="intent-row interval-row"
                label="随机动作切换间隔"
                status="pet"
                value={bundle.state.settings.pet.randomActionSwitchSeconds}
                options={[30, 60, 90, 120, 300].map((seconds) => ({ value: seconds, label: intervalTitle(seconds), disabled: !bundle.state.settings.pet.randomActionSwitchEnabled }))}
                onChange={(seconds) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, randomActionSwitchSeconds: seconds } }))}
              />
            </div>
          </div>
        </section>

        <section className="pet-settings-section status-privacy">
          <h3><SlidersHorizontal size={15} /> 位置外观</h3>
          <SegmentedControl
            className="pet-placement-row"
            label="桌宠位置"
            status="privacy"
            value={bundle.state.settings.pet.placement}
            options={(["bottomRight", "bottomLeft", "topRight", "topLeft", "dock", "custom"] as const).map((placement) => ({ value: placement, label: petPlacementLabels[placement] }))}
            onChange={(placement) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, placement } }))}
          />

          <div className="pet-slider-grid">
            <SliderRow id="pet-size" label="大小" min={64} max={220} status="pet" suffix="px" value={Math.round(bundle.state.settings.pet.size)} onChange={(size) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, size } }))} />
            <SliderRow id="pet-opacity" label="透明度" min={35} max={100} status="pet" suffix="%" value={Math.round(bundle.state.settings.pet.opacity * 100)} onChange={(opacity) => actions.updateSettings((settings) => ({ ...settings, pet: { ...settings.pet, opacity: opacity / 100 } }))} />
          </div>
        </section>
      </section>
    </div>
  );
};
