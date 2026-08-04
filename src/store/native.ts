import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { AgentCompletionEvent, ClassificationRule, InstallationSnapshot, LocalStoreSnapshot, NativeActivitySample, NativeRuntimeEnvelope, SystemMetricsSample } from "../core/types";
import type { CodexEventEnvelope, CodexHookConfigurationResult, CodexIntegrationStatus, CodexSessionSnapshot, CodexSyncPreferences, SshConnectionStatus, SshHostCandidate, SshHostDiagnostic, SshProvisionResult, SshUninstallResult } from "../core/codexSessions";
import type { PetPackRecord, PetSourceActionAssets } from "../resources/petPack";
import { importedPetPackRecord } from "../resources/petPack";

export const isTauriRuntime = (): boolean => "__TAURI_INTERNALS__" in window;

export const nativeLoadSnapshot = async (): Promise<LocalStoreSnapshot | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<LocalStoreSnapshot>("load_snapshot");
};

export const nativeSaveSnapshot = async (snapshot: LocalStoreSnapshot): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("save_snapshot", { snapshot });
};

export const nativeSetClassificationRules = async (rules: ClassificationRule[]): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("set_classification_rules", { rules });
};

export const nativeQuitApp = async (): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("quit_app");
};

export const nativePerformMenuBarAction = async (action: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("perform_menu_bar_action", { action });
};

export const nativeSetPetPanelPosition = async (x: number, y: number): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("set_pet_panel_position", { x, y });
};

export const nativeSetPetPanelIgnoresMouseEvents = async (ignores: boolean): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("set_pet_panel_ignores_mouse_events", { ignores });
};

export const nativePetPanelPointerPosition = async (): Promise<{ x: number; y: number } | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<{ x: number; y: number } | undefined>("pet_panel_pointer_position");
};

export const nativeActivitySample = async (): Promise<NativeActivitySample | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<NativeActivitySample>("sample_activity");
};

export const nativeRuntimeSnapshot = async (): Promise<NativeRuntimeEnvelope | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<NativeRuntimeEnvelope>("native_runtime_snapshot");
};

export const nativeSystemMetrics = async (): Promise<SystemMetricsSample | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<SystemMetricsSample>("sample_system_metrics");
};

export const nativeDrainAgentEvents = async (): Promise<AgentCompletionEvent[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<AgentCompletionEvent[]>("drain_agent_events");
};

export const nativeAgentEventInboxPath = async (): Promise<string | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<string>("agent_event_inbox_path");
};

export const nativeDrainCodexSessionEvents = async (): Promise<CodexEventEnvelope[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<CodexEventEnvelope[]>("drain_codex_session_events");
};

export const nativeCodexSessionSnapshot = async (): Promise<CodexSessionSnapshot[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<CodexSessionSnapshot[]>("codex_session_snapshot");
};

export const nativeCodexIntegrationStatus = async (): Promise<CodexIntegrationStatus | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<CodexIntegrationStatus>("codex_integration_status");
};

export const nativeSetCodexSyncPreferences = async (preferences: CodexSyncPreferences): Promise<CodexSyncPreferences> => {
  if (!isTauriRuntime()) return preferences;
  return invoke<CodexSyncPreferences>("set_codex_sync_preferences", { preferences });
};

export const nativeStartCodexManagedDaemon = async (): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("start_codex_managed_daemon");
};

export const nativePollCodexManagedStatus = async (): Promise<CodexEventEnvelope[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<CodexEventEnvelope[]>("poll_codex_managed_status");
};

export const nativeInstallCodexHooks = async (): Promise<CodexHookConfigurationResult> => {
  if (!isTauriRuntime()) throw new Error("Codex Hook 仅能在 Focus Pet 桌面应用中安装。");
  return invoke<CodexHookConfigurationResult>("install_codex_hooks");
};

export const nativeUninstallCodexHooks = async (): Promise<CodexHookConfigurationResult> => {
  if (!isTauriRuntime()) throw new Error("Codex Hook 仅能在 Focus Pet 桌面应用中移除。");
  return invoke<CodexHookConfigurationResult>("uninstall_codex_hooks");
};

export const nativeDiscoverCodexSshHosts = async (): Promise<SshHostCandidate[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<SshHostCandidate[]>("discover_codex_ssh_hosts");
};

export const nativeSaveCodexSshHost = async (host: SshHostCandidate): Promise<SshHostCandidate> => {
  if (!isTauriRuntime()) return host;
  return invoke<SshHostCandidate>("save_codex_ssh_host", {
    alias: host.alias,
    hostname: host.hostname,
    user: host.user,
    port: host.port,
  });
};

export const nativeForgetCodexSshHost = async (alias: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("forget_codex_ssh_host", { alias });
};

export const nativeDiagnoseCodexSshHost = async (alias: string): Promise<SshHostDiagnostic> => {
  if (!isTauriRuntime()) throw new Error("SSH 主机仅能在 Focus Pet 桌面应用中连接。");
  return invoke<SshHostDiagnostic>("diagnose_codex_ssh_host", { alias });
};

export const nativeProvisionCodexSshHost = async (alias: string): Promise<SshProvisionResult> => {
  if (!isTauriRuntime()) throw new Error("SSH 主机仅能在 Focus Pet 桌面应用中启用官方 App Server 接入。");
  return invoke<SshProvisionResult>("provision_codex_ssh_host", { alias });
};

export const nativeUninstallCodexSshHost = async (alias: string): Promise<SshUninstallResult> => {
  if (!isTauriRuntime()) throw new Error("SSH 主机仅能在 Focus Pet 桌面应用中移除。");
  return invoke<SshUninstallResult>("uninstall_codex_ssh_host", { alias });
};

export const nativeConnectCodexSshHost = async (alias: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("connect_codex_ssh_host", { alias });
};

export const nativeDrainCodexSshEvents = async (): Promise<CodexEventEnvelope[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<CodexEventEnvelope[]>("drain_codex_ssh_events");
};

export const nativeCodexSshConnectionStatus = async (): Promise<SshConnectionStatus[]> => {
  if (!isTauriRuntime()) return [];
  return invoke<SshConnectionStatus[]>("codex_ssh_connection_status");
};

export const nativeAppIcon = async (bundleID: string | undefined, appName: string): Promise<string | undefined> => {
  if (!isTauriRuntime()) return undefined;
  const path = await invoke<string | undefined>("app_icon", { bundleId: bundleID, appName });
  return path ? convertFileSrc(path) : undefined;
};

export const nativeInstallationSnapshot = async (): Promise<InstallationSnapshot | undefined> => {
  if (!isTauriRuntime()) return undefined;
  return invoke<InstallationSnapshot>("installation_snapshot");
};

export const nativeImportPetPack = async (): Promise<PetPackRecord[] | undefined> => {
  if (!isTauriRuntime()) return undefined;
  const imported = await invoke<PetPackRecord[] | undefined>("choose_and_import_pet_pack");
  return imported?.map(resolveImportedPetPack);
};

export const nativeImportPetPackFromPath = async (path: string): Promise<PetPackRecord[] | undefined> => {
  if (!isTauriRuntime()) return undefined;
  const imported = await invoke<PetPackRecord[]>("import_pet_pack_from_path", { path });
  return imported.map(resolveImportedPetPack);
};

export const nativeListPetPacks = async (): Promise<PetPackRecord[]> => {
  if (!isTauriRuntime()) return [];
  const records = await invoke<PetPackRecord[]>("list_pet_packs");
  return records.map(resolveImportedPetPack);
};

export const nativePetPackAssets = async (id: string): Promise<PetSourceActionAssets[]> => {
  if (!isTauriRuntime()) return [];
  const assets = await invoke<NativePetSourceActionAssets[]>("pet_pack_assets", { id });
  return assets.map(resolvePetSourceActionAssets);
};

export const nativeDeletePetPack = async (id: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("delete_pet_pack", { id });
};

export const nativeDeliverNotification = async (title: string, body: string): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("deliver_notification", { title, body });
};

export const nativeSyncWidgetWindows = async (
  currentStatusVisible: boolean,
  recentRhythmVisible: boolean,
  currentStatusOrigin: { x: number; y: number } | undefined,
  recentRhythmOrigin: { x: number; y: number } | undefined,
  petCompanionVisible: boolean,
  petSize: number,
  petPlacement: string,
  petOrigin?: { x: number; y: number },
): Promise<boolean> => {
  if (!isTauriRuntime()) return false;
  return invoke<boolean>("sync_widget_windows", {
    currentStatusVisible,
    recentRhythmVisible,
    currentStatusOriginX: currentStatusOrigin?.x,
    currentStatusOriginY: currentStatusOrigin?.y,
    recentRhythmOriginX: recentRhythmOrigin?.x,
    recentRhythmOriginY: recentRhythmOrigin?.y,
    petCompanionVisible,
    petSize,
    petPlacement,
    petOriginX: petOrigin?.x,
    petOriginY: petOrigin?.y,
  });
};

type NativePetPackRecord = Omit<PetPackRecord, "sourceActionAssets"> & {
  previewUrl?: string;
  sourceActionAssets?: NativePetSourceActionAssets[];
};

type NativePetSourceActionAssets = {
  id: string;
  frameURLs?: string[];
  frameUrls?: string[];
  audioURL?: string;
  audioUrl?: string;
};

const resolvePetSourceActionAssets = (asset: NativePetSourceActionAssets): PetSourceActionAssets => ({
  id: asset.id,
  frameURLs: (asset.frameURLs ?? asset.frameUrls ?? []).map((url) => convertFileSrc(url)),
  audioURL: asset.audioURL ?? asset.audioUrl ? convertFileSrc(asset.audioURL ?? asset.audioUrl ?? "") : undefined,
});

const resolveImportedPetPack = (record: PetPackRecord): PetPackRecord => {
  const nativeRecord = record as NativePetPackRecord;
  const rawPreviewURL = nativeRecord.previewURL ?? nativeRecord.previewUrl;
  const previewURL = rawPreviewURL ? convertFileSrc(rawPreviewURL) : undefined;
  const sourceActionAssets = nativeRecord.sourceActionAssets?.map(resolvePetSourceActionAssets);
  return importedPetPackRecord({ ...nativeRecord, previewURL: rawPreviewURL, sourceActionAssets }, previewURL);
};
