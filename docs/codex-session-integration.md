# Codex CLI session integration

Focus Pet uses Codex's official App Server as its primary session integration.
It first reuses a running control socket, otherwise uses Codex's managed daemon
when available, or starts an explicit Focus Pet-owned `app-server --listen
unix://` observer from a normal CLI. `codex app-server proxy` normally exposes
its WebSocket-framed JSON-RPC stream (HTTP Upgrade + WebSocket text frames, not
JSONL). If that proxy fails its passive upgrade despite a healthy daemon, Focus
Pet falls back to an SSH-contained byte relay to the same Unix socket. Focus Pet
only observes `thread/status/changed` plus read-only thread history methods; it
never sends prompts, approvals, interrupts, or tool responses to Codex. Hooks
and rollout parsing are compatibility fallback paths.

## Local setup

Open **Settings → Reminders → 智能体任务**, then select **启用精确状态**.
This starts or connects to the official managed App Server. Modern Codex CLI
clients automatically reuse its default Unix socket. Install **Codex Hook** only
when the diagnostic explicitly reports that managed App Server is unavailable.

The Hook installer writes only Focus Pet handlers to the user-level `~/.codex/hooks.json`,
makes a private backup before changing an existing file, and leaves other handlers
in place. In Codex, run `/hooks` and trust `Focus Pet session sync`.

If the user-level `config.toml` already contains inline `[hooks]`, Focus Pet will
not create a second `hooks.json`; copy the command shown in Settings into the
existing representation instead.

The default privacy mode shows only assistant-visible text. User prompts,
reasoning, tool parameters, terminal output, credentials, and environment values
are not surfaced by this integration.

The configuration card also offers **仅状态**. Switching to it removes visible
assistant summaries from the current in-memory session list and prevents future
assistant text from reaching the journal or the desktop UI; lifecycle state stays
available. This setting is stored locally in Focus Pet's application-data
directory.

## Exact status

The **启用精确状态** button first reuses a healthy control socket. If no socket
is present, it starts `codex app-server daemon start` when the optional
standalone runtime is installed; otherwise it starts the official normal-CLI
command `codex app-server --listen unix://` as a Focus Pet-owned observer. It
then opens a long-lived `codex app-server proxy` observer. It receives the official
`thread/status/changed` broadcast, refreshes with read-only `thread/list`, and
reads only the newest `agentMessage` through `thread/turns/list` after a turn
becomes idle. Focus Pet does not call `thread/resume` and never subscribes to a
user-owned thread. Status broadcasts are rendered immediately; when an App
Server does not broadcast to a passive observer, the same read-only inventory
refreshes every two seconds. WebSocket handshakes use a fresh secure nonce and
each client frame uses a fresh secure mask.

The observer is not started at Focus Pet launch. It starts only after the user
explicitly enables exact status. A normal package-manager CLI is sufficient for
the Focus Pet-owned mode; Focus Pet closes only that child on its normal Quit
actions and never stops a user-owned daemon, ChatGPT, IDE, or terminal process.
Some package-manager installations cannot start Codex's *durable managed
daemon*, because that mode requires `$CODEX_HOME/packages/standalone/current/codex`.
Settings offers the official installer command (`curl -fsSL
https://chatgpt.com/codex/install.sh | sh`) solely as an optional clipboard
action; Focus Pet never executes it. After the user has reviewed and run it,
use **刷新 Codex 状态** to switch to durable mode.

## SSH hosts

Focus Pet finds concrete aliases in `~/.ssh/config` and its ordinary `Include`
files, and can save a direct host/IP, user and port in its own local settings
without editing `~/.ssh/config`. It resolves config aliases with `ssh -G` and
uses OpenSSH's configured route, host-key policy, ProxyJump, and identities.
Selecting **接入 host** checks the remote OS, architecture, Codex executable
path, daemon status, and a passive WebSocket `initialize` handshake. It tries
the official SSH `app-server proxy` first; only if that proxy does not relay a
valid upgrade, it retries through an SSH-contained Unix Socket byte relay. If
no daemon is running, the user can confirm the official `codex app-server
daemon bootstrap`; if both read-only transports are unavailable, Focus Pet
stops there. It never bootstraps, restarts, or copies an existing client's
credentials. No Focus Pet binary is uploaded and no remote Hook or session
journal is installed for the normal path.

The SSH list is intentionally two-step: **检查** is read-only and displays the
remote OS, architecture, Codex version, executable path, daemon capability and
the selected read-only transport. Only **确认接入** bootstraps a daemon that is
not already running. When the official proxy is unresponsive but the Unix
Socket is healthy, the UI labels the safe direct-Socket fallback; when both
transports are unresponsive, it leaves that daemon untouched.
When the daemon cannot be used, the UI offers the explicitly labeled
compatibility Hook mode instead.

**移除** first stops the local SSH proxy. It does not remove Codex, its
authentication, the official daemon, or any other Hook handler. A separately
enabled compatibility Hook can be removed independently.

The app never opens an App Server TCP port. Remote sessions use the globe
indicator, while the connection button shows **连接中 / 已连接 / 已断开**. A
disconnected SSH host is offline, not a completed task.

## ChatGPT / Codex Remote Control hosts

The Codex App's globe sessions use the official experimental Remote Control
surface. It is intentionally separate from opening a second raw proxy to the
same Unix socket: a controller must be explicitly paired. Current Codex source
exposes `remoteControl/pairing/start` and controller-device management, while
the remote CLI must also expose a compatible `codex remote-control pair` flow.
Focus Pet never copies another client's connection preamble, pairing artifact,
or credentials. On hosts that only expose an older Remote Control command, the
settings panel reports the limitation and leaves the existing ChatGPT/Codex
connection untouched.
