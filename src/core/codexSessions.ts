export type CodexEventSource = "hook" | "appServer" | "rollout" | "legacyNotify" | "processProbe";

export interface CodexEventEnvelope {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  hostId: string;
  sessionId: string;
  threadId?: string;
  turnId?: string;
  occurredAt: string;
  receivedAt: string;
  kind: "host.connected" | "host.disconnected" | "session.started" | "session.ended" | "turn.started" | "turn.statusChanged" | "message.updated" | "turn.completed" | string;
  source: CodexEventSource | string;
  confidence: "exact" | "inferred" | string;
  payload: Record<string, unknown>;
}

export interface CodexVisibleMessage {
  itemId?: string;
  role: "user" | "assistant" | string;
  phase?: string;
  text: string;
  isFinal: boolean;
  updatedAt: string;
}

export interface CodexTurnState {
  turnId: string;
  status: "inProgress" | "completed" | "failed" | "interrupted" | "unknown" | string;
  startedAt?: string;
  completedAt?: string;
  errorSummary?: string;
}

export interface CodexSessionSnapshot {
  hostId: string;
  hostKind: "local" | "ssh" | string;
  sessionId: string;
  threadId?: string;
  title: string;
  cwd?: string;
  lifecycle: "open" | "closed" | "unknown" | string;
  runtime: "notLoaded" | "idle" | "active" | "systemError" | "unknown" | string;
  activeFlags: string[];
  currentTurn?: CodexTurnState;
  latestVisibleMessage?: CodexVisibleMessage;
  capabilityMode: "managed" | "hooks" | "legacy" | string;
  updatedAt: string;
}

export interface CodexIntegrationStatus {
  journalPath: string;
  hooksPath: string;
  codexConfigPath: string;
  hookCommand: string;
  hookFileExists: boolean;
  hasInlineHooks: boolean;
  mode: "configured" | "notConfigured" | string;
  contentMode: "statusOnly" | "assistantVisible" | string;
  managedDaemonStatus: "running" | "available" | "ephemeralAvailable" | "unavailable" | string;
  managedDaemonMessage: string;
}

export interface CodexSyncPreferences {
  contentMode: "statusOnly" | "assistantVisible";
}

export interface CodexHookConfigurationResult {
  message: string;
  hooksPath: string;
  backupPath?: string;
}

export interface SshHostCandidate {
  alias: string;
  hostname: string;
  user?: string;
  port?: number;
  source: "sshConfig" | "focusPet" | string;
}

export interface SshConnectionStatus {
  alias: string;
  /** Transport health only; it does not change any Codex session lifecycle. */
  status: "connecting" | "connected" | "disconnected" | string;
}

export interface SshHostDiagnostic extends SshHostCandidate {
  operatingSystem: string;
  architecture: string;
  codexVersion: string;
  codexPath: string;
  /** `ready` means the official read-only App Server handshake succeeded. */
  daemonStatus: "ready" | "running" | "notRunning" | "proxyUnresponsive" | string;
  /** The verified SSH byte transport; absent until a running daemon is probed. */
  transport?: "appServerProxy" | "directUnixSocket" | string;
}

export interface SshProvisionResult {
  alias: string;
  daemonStatus: "ready" | "running" | "notRunning" | "proxyUnresponsive" | string;
  message: string;
}

export interface SshUninstallResult {
  alias: string;
  message: string;
}

const sourcePriority: Record<string, number> = {
  appServer: 5,
  hook: 4,
  rollout: 3,
  legacyNotify: 2,
  processProbe: 1,
};

const sessionKey = (session: Pick<CodexSessionSnapshot, "hostId" | "sessionId">): string => `${session.hostId}:${session.sessionId}`;

const eventSourcePriority = (event: CodexEventEnvelope): number => sourcePriority[event.source] ?? 0;

const compact = (value: string, max = 220): string => {
  const normalized = value.replaceAll(String.fromCharCode(0), "").trim().replace(/\s+/g, " ");
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1))}…`;
};

const isTerminal = (status: string | undefined): boolean =>
  status === "completed" || status === "failed" || status === "interrupted";

const initialSession = (event: CodexEventEnvelope): CodexSessionSnapshot => ({
  hostId: event.hostId,
  hostKind: event.hostId === "local" ? "local" : "ssh",
  sessionId: event.sessionId,
  threadId: event.threadId,
  title: typeof event.payload.cwd === "string" ? event.payload.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "Codex" : "Codex",
  cwd: typeof event.payload.cwd === "string" ? event.payload.cwd : undefined,
  lifecycle: "unknown",
  runtime: "unknown",
  activeFlags: [],
  capabilityMode: event.source === "appServer" ? "managed" : event.source === "legacyNotify" ? "legacy" : "hooks",
  updatedAt: event.occurredAt,
});

const payloadString = (payload: Record<string, unknown>, key: string): string | undefined =>
  typeof payload[key] === "string" && payload[key].trim() ? payload[key].trim() : undefined;

const payloadStringList = (payload: Record<string, unknown>, key: string): string[] =>
  Array.isArray(payload[key]) ? payload[key].filter((item): item is string => typeof item === "string") : [];

export const reduceCodexEvents = (
  previous: CodexSessionSnapshot[],
  events: CodexEventEnvelope[],
): CodexSessionSnapshot[] => {
  const sessions = new Map(previous.map((session) => [sessionKey(session), session]));
  const priorities = new Map(previous.map((session) => [sessionKey(session), 0]));
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence || left.occurredAt.localeCompare(right.occurredAt))) {
    const key = `${event.hostId}:${event.sessionId}`;
    const current = sessions.get(key) ?? initialSession(event);
    const priority = eventSourcePriority(event);
    const currentPriority = priorities.get(key) ?? 0;
    const cwd = payloadString(event.payload, "cwd") ?? current.cwd;
    const next: CodexSessionSnapshot = {
      ...current,
      threadId: event.threadId ?? current.threadId,
      cwd,
      title: cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? current.title,
      capabilityMode: priority >= currentPriority ? (event.source === "appServer" ? "managed" : event.source === "legacyNotify" ? "legacy" : current.capabilityMode === "managed" ? "managed" : "hooks") : current.capabilityMode,
      updatedAt: event.occurredAt > current.updatedAt ? event.occurredAt : current.updatedAt,
    };
    if (event.kind === "session.started") {
      next.lifecycle = "open";
      next.runtime = "idle";
    } else if (event.kind === "session.ended") {
      next.lifecycle = "closed";
      next.runtime = "idle";
      next.activeFlags = [];
    } else if (event.kind === "turn.started") {
      if (!isTerminal(current.currentTurn?.status) || event.occurredAt >= (current.currentTurn?.completedAt ?? "")) {
        next.lifecycle = "open";
        next.runtime = "active";
        if (event.turnId) next.currentTurn = { turnId: event.turnId, status: "inProgress", startedAt: event.occurredAt };
      }
    } else if (event.kind === "turn.completed") {
      next.lifecycle = "open";
      next.runtime = "idle";
      if (event.turnId) {
        next.currentTurn = {
          turnId: event.turnId,
          status: "completed",
          startedAt: current.currentTurn?.turnId === event.turnId ? current.currentTurn.startedAt : undefined,
          completedAt: event.occurredAt,
        };
      }
      const text = payloadString(event.payload, "lastAssistantMessage");
      if (text) next.latestVisibleMessage = { role: "assistant", phase: "final_answer", text: compact(text), isFinal: true, updatedAt: event.occurredAt };
    } else if (event.kind === "turn.statusChanged" && priority >= currentPriority) {
      next.runtime = payloadString(event.payload, "runtime") ?? next.runtime;
      next.activeFlags = payloadStringList(event.payload, "activeFlags");
      if (event.turnId && next.currentTurn?.turnId === event.turnId && next.runtime === "active") {
        next.currentTurn = { ...next.currentTurn, status: "inProgress" };
      }
    } else if (event.kind === "message.updated") {
      const text = payloadString(event.payload, "text");
      if (text && payloadString(event.payload, "role") !== "user") {
        next.latestVisibleMessage = {
          itemId: payloadString(event.payload, "itemId"),
          role: payloadString(event.payload, "role") ?? "assistant",
          phase: payloadString(event.payload, "phase"),
          text: compact(text),
          isFinal: event.payload.isFinal === true,
          updatedAt: event.occurredAt,
        };
      }
    }
    sessions.set(key, next);
    priorities.set(key, Math.max(currentPriority, priority));
  }
  return [...sessions.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

export const codexBubble = (sessions: CodexSessionSnapshot[]): string | undefined => {
  const active = sessions.find((session) => session.lifecycle === "open" && (session.activeFlags.includes("waitingOnApproval") || session.activeFlags.includes("waitingOnUserInput") || session.runtime === "active"));
  const selected = active ?? sessions.find((session) => session.currentTurn?.status === "completed") ?? sessions[0];
  if (!selected) return undefined;
  const prefix = selected.hostKind === "ssh" ? `🌐 ${selected.title}` : selected.title;
  if (selected.activeFlags.includes("waitingOnApproval")) return `${prefix} 正在等待审批`;
  if (selected.activeFlags.includes("waitingOnUserInput")) return `${prefix} 正在等待你的输入`;
  if (selected.runtime === "active") return selected.latestVisibleMessage?.text ? `${prefix}：${selected.latestVisibleMessage.text}` : `${prefix} 正在运行`;
  if (selected.currentTurn?.status === "completed") return selected.latestVisibleMessage?.text ? `${prefix}：${selected.latestVisibleMessage.text}` : `${prefix} 已完成`;
  return selected.latestVisibleMessage?.text ? `${prefix}：${selected.latestVisibleMessage.text}` : undefined;
};

export const codexStatusLabel = (session: CodexSessionSnapshot): string => {
  if (session.activeFlags.includes("waitingOnApproval")) return "等待审批";
  if (session.activeFlags.includes("waitingOnUserInput")) return "等待输入";
  if (session.runtime === "active") return "运行中";
  if (session.currentTurn?.status === "completed") return "已完成";
  if (session.lifecycle === "closed") return "已结束";
  if (session.runtime === "systemError") return "异常";
  return "待命";
};
