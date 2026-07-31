import { ChevronDown, ChevronUp, Globe2, LoaderCircle, Monitor, TriangleAlert } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  codexSessionIsActive,
  codexStatusLabel,
  type CodexSessionSnapshot,
} from "../core/codexSessions";

interface CodexSessionPanelProps {
  sessions: CodexSessionSnapshot[];
}

const COLLAPSED_KEY = "focus-pet-codex-panel-collapsed";

const initialCollapsed = (): boolean => {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
};

const sessionStatusClass = (session: CodexSessionSnapshot): string => {
  if (session.runtime === "systemError" || session.currentTurn?.status === "failed") return "is-error";
  if (codexSessionIsActive(session)) return "is-active";
  return "is-idle";
};

const StatusIcon = ({ session }: { session: CodexSessionSnapshot }) => {
  if (session.runtime === "systemError" || session.currentTurn?.status === "failed") {
    return <TriangleAlert size={13} aria-hidden />;
  }
  if (codexSessionIsActive(session)) return <LoaderCircle className="codex-session-spinner" size={13} aria-hidden />;
  return <span className="codex-session-idle-dot" aria-hidden />;
};

export const CodexSessionPanel = ({ sessions }: CodexSessionPanelProps) => {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const ordered = useMemo(
    () => sessions
      .filter(codexSessionIsActive)
      .sort((left, right) =>
        `${left.hostId}:${left.sessionId}`.localeCompare(`${right.hostId}:${right.sessionId}`),
      )
      .slice(0, 12),
    [sessions],
  );
  const [selectedKey, setSelectedKey] = useState<string>();
  const selected = ordered.find((session) => `${session.hostId}:${session.sessionId}` === selectedKey)
    ?? ordered.find(codexSessionIsActive)
    ?? ordered[0];
  const activeCount = ordered.filter(codexSessionIsActive).length;
  const visibleMessage = useDeferredValue(selected?.latestVisibleMessage?.text);

  useEffect(() => {
    if (!selected) return;
    setSelectedKey((current) =>
      ordered.some((session) => `${session.hostId}:${session.sessionId}` === current)
        ? current
        : `${selected.hostId}:${selected.sessionId}`,
    );
  }, [ordered, selected]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSED_KEY, String(next));
      } catch {
        // A private WebView can disable storage; collapse still works in-memory.
      }
      return next;
    });
  };

  if (!selected) return null;
  if (collapsed) {
    return (
      <section className="codex-session-panel is-collapsed" aria-label="Codex 会话">
        <button className="codex-session-summary-button" type="button" onClick={toggleCollapsed} aria-expanded={false}>
          <LoaderCircle className="codex-session-spinner" size={14} aria-hidden />
          <span>{`${activeCount} 个任务运行中`}</span>
          <ChevronUp size={14} aria-hidden />
        </button>
      </section>
    );
  }

  return (
    <section className="codex-session-panel" aria-label="Codex 会话" aria-live="polite">
      <header className="codex-session-panel-header">
        <span>
          <strong>Codex 会话</strong>
          <small>{`${activeCount} 个任务运行中`}</small>
        </span>
        <button type="button" onClick={toggleCollapsed} aria-label="收起 Codex 会话" aria-expanded>
          <ChevronDown size={15} aria-hidden />
        </button>
      </header>
      <div className="codex-session-list" role="tablist" aria-label="Codex 会话列表">
        {ordered.map((session) => {
          const key = `${session.hostId}:${session.sessionId}`;
          const selectedNow = key === `${selected.hostId}:${selected.sessionId}`;
          return (
            <button
              className={`codex-session-tab ${sessionStatusClass(session)} ${selectedNow ? "is-selected" : ""}`}
              key={key}
              type="button"
              role="tab"
              aria-selected={selectedNow}
              onClick={() => setSelectedKey(key)}
              title={session.cwd ?? session.title}
            >
              {session.hostKind === "ssh" ? <Globe2 size={13} aria-hidden /> : <Monitor size={13} aria-hidden />}
              <span>
                <strong>{session.hostKind === "ssh" ? session.hostId : session.title}</strong>
                <small>{session.hostKind === "ssh" ? session.title : session.cwd ?? "本机"}</small>
              </span>
              <em><StatusIcon session={session} />{codexStatusLabel(session)}</em>
            </button>
          );
        })}
      </div>
      <article className={`codex-session-message ${sessionStatusClass(selected)}`}>
        <div className="codex-session-message-meta">
          <span><StatusIcon session={selected} />{codexStatusLabel(selected)}</span>
          <small>{selected.hostKind === "ssh" ? `远程 · ${selected.hostId}` : "本机"}</small>
        </div>
        {visibleMessage ? (
          <div className="codex-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
                img: ({ alt }) => <span className="codex-markdown-image-placeholder">[图片：{alt || "未命名"}]</span>,
              }}
            >
              {visibleMessage}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="codex-session-placeholder">
            {codexSessionIsActive(selected) ? "Codex 正在处理，输出会在这里实时更新。" : `${codexStatusLabel(selected)}，暂无可展示的 assistant 输出。`}
          </p>
        )}
      </article>
    </section>
  );
};
