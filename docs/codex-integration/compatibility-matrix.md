# Codex App Server compatibility matrix

This matrix records protocol evidence used by Focus Pet. It contains no user
prompt, session id, workspace path, credential, or assistant content.

| Runtime | Evidence date | Transport verification | Read-only methods used | Result / Focus Pet behavior |
| --- | --- | --- | --- | --- |
| macOS bundled App Server `0.146.0-alpha.3.1` | 2026-07-29 | An isolated `CODEX_HOME` with `app-server --listen unix://` completed HTTP Upgrade + WebSocket `initialize` / `initialized`. | `thread/list` | Compatible. Empty inventory was returned without a model turn. This proves the codec but not managed-daemon reuse. |
| macOS temporary managed daemon, bundled App Server `0.146.0-alpha.3.1` | 2026-07-29 | A temporary `CODEX_HOME` containing an isolated standalone symlink completed `daemon start → daemon version → app-server proxy → WebSocket initialize → thread/list → daemon stop`. | `thread/list` | Compatible lifecycle proof with no personal Codex state changed. It proves Focus Pet's managed-daemon transport contract, not the user's missing standalone installation. |
| macOS npm CLI (current user installation) | 2026-07-29 | `app-server daemon version` reports no control socket; the normal CLI can start an official App Server with `app-server --listen unix://`. | `thread/list` (pending real-user-home validation) | Available on explicit opt-in. Focus Pet owns the direct observer process and stops only that child when the application exits. The optional standalone runtime enables Codex's durable managed-daemon mode; it is not required for exact status. |
| Linux SSH host, CLI `0.145.0`, App Server `0.142.0` | 2026-07-29 | `codex app-server proxy` failed to complete passive WebSocket upgrade; an SSH-contained relay to the same existing Unix Socket completed it. | `thread/list`, `thread/turns/list(itemsView=summary)` | Compatible through `directUnixSocket` fallback. Read-only inventory returned active, idle and not-loaded threads; a newest idle turn contained an `agentMessage`, proving final-message projection without printing or persisting test content. No daemon/bootstrap/restart, thread resume, turn, approval, input, or content request was sent during verification. |

## Generated schema evidence

The macOS bundled App Server generated its experimental JSON Schema successfully
in a temporary isolated directory. The generated `ClientRequest` and
`ServerNotification` schemas include all methods Focus Pet relies on:

- `initialize` / `initialized`
- `thread/list`
- `thread/turns/list`
- `thread/status/changed`

The schema also exposes state-changing APIs such as `thread/resume`, approvals,
and input responses. Focus Pet treats those as denylisted: the observer only
sends the four lifecycle/inventory calls above and never responds to server
requests.

## Compatibility rules

1. Prefer the documented `codex app-server proxy` transport.
2. If the proxy cannot complete a passive WebSocket upgrade, retry only a
   byte-for-byte Unix Socket relay inside the same authenticated SSH channel.
3. If both transports fail, mark the host unavailable; never bootstrap,
   restart, terminate, or alter the existing daemon.
4. Process `thread/status/changed` immediately. Refresh `thread/list` every
   two seconds as a bounded fallback for passive observers that receive no
   broadcast.
5. Exact local state requires a reachable official App Server. Focus Pet first
   reuses a running socket, then starts Codex's durable managed daemon when
   standalone is present, and otherwise may explicitly start a normal CLI App
   Server it owns. The app must not install the standalone runtime automatically.

The repository's sanitized fixtures are in
`src-tauri/fixtures/codex/`. They are deliberately synthetic and validate only
the fields used by the reducer and privacy filter.
