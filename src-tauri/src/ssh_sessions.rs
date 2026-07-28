use crate::codex_sessions::{
    connect_app_server_proxy_with_timeout, read_app_server_proxy_message,
    send_app_server_proxy_message, CodexEventEnvelope,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

const STREAM_HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(30);
/// A proxy process is not evidence of a usable App Server connection. Current
/// Codex versions can leave that proxy without forwarding its WebSocket
/// upgrade while the underlying daemon stays healthy. Keep the probe short
/// and passive.
const APP_SERVER_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// `thread/status/changed` is pushed immediately when available. Inventory is
/// refreshed every two seconds so an App Server that suppresses broadcasts for
/// passive observers still appears real-time in the desktop UI.
const APP_SERVER_POLL_INTERVAL: Duration = Duration::from_secs(2);
const SSH_HOSTS_FILE: &str = "codex-ssh-hosts.json";
static SSH_EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// The documented `codex app-server proxy` is preferred. Some current
/// Codex versions can accept a direct Unix-socket WebSocket client while the
/// proxy subprocess never forwards the upgrade; in that case a tiny Python
/// byte relay is a transport-only fallback. It sends no Codex command and
/// keeps the Unix socket inaccessible outside the existing SSH connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AppServerTransport {
    Proxy,
    DirectUnixSocket,
}

impl AppServerTransport {
    fn identifier(self) -> &'static str {
        match self {
            Self::Proxy => "appServerProxy",
            Self::DirectUnixSocket => "directUnixSocket",
        }
    }

    fn remote_command(self, codex_path: &str) -> String {
        match self {
            Self::Proxy => codex_command(codex_path, "app-server proxy"),
            Self::DirectUnixSocket => direct_unix_socket_relay_command(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostCandidate {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedSshHost {
    alias: String,
    hostname: String,
    user: Option<String>,
    port: Option<u16>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostDiagnostic {
    pub alias: String,
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub operating_system: String,
    pub architecture: String,
    pub codex_version: String,
    /// Exact executable selected by a read-only non-interactive SSH probe.
    /// This matters for nvm/asdf installations whose normal login startup files
    /// are deliberately not sourced by Focus Pet.
    pub codex_path: String,
    pub daemon_status: String,
    /// `appServerProxy` is the official Codex proxy. `directUnixSocket` is a
    /// byte-for-byte WebSocket relay fallback used only when that proxy is
    /// demonstrably unresponsive on an otherwise running daemon.
    pub transport: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProvisionResult {
    pub alias: String,
    pub daemon_status: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshUninstallResult {
    pub alias: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionStatus {
    pub alias: String,
    /// `connecting`, `connected`, or `disconnected`. This is transport
    /// health only: it must never be used to infer that a remote Codex turn
    /// has ended.
    pub status: String,
}

#[derive(Default)]
struct SshInner {
    events: VecDeque<CodexEventEnvelope>,
    connections: HashMap<String, SshConnectionStatus>,
    stop_requested: HashSet<String>,
}

#[derive(Clone, Default)]
pub struct SshSessionManager {
    inner: Arc<Mutex<SshInner>>,
}

impl SshSessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn connect(&self, alias: &str) -> Result<(), String> {
        validate_alias(alias)?;
        let diagnostic = diagnose_host(alias)?;
        if diagnostic.daemon_status != "ready" {
            return Err(connection_readiness_error(&diagnostic));
        }
        let inner = self.inner.clone();
        let alias = alias.to_string();
        {
            let mut state = inner
                .lock()
                .map_err(|_| "SSH session state lock is unavailable".to_string())?;
            if state.connections.contains_key(&alias) && !state.stop_requested.contains(&alias) {
                return Ok(());
            }
            state.stop_requested.remove(&alias);
            state.connections.insert(
                alias.clone(),
                SshConnectionStatus {
                    alias: alias.clone(),
                    status: "connecting".to_string(),
                },
            );
        }
        std::thread::spawn(move || run_stream_loop(inner, alias, diagnostic));
        Ok(())
    }

    pub fn disconnect(&self, alias: &str) -> Result<(), String> {
        validate_alias(alias)?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "SSH session state lock is unavailable".to_string())?;
        state.stop_requested.insert(alias.to_string());
        state.connections.insert(
            alias.to_string(),
            SshConnectionStatus {
                alias: alias.to_string(),
                status: "disconnected".to_string(),
            },
        );
        Ok(())
    }

    pub fn drain(&self) -> Result<Vec<CodexEventEnvelope>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "SSH session state lock is unavailable".to_string())?;
        Ok(inner.events.drain(..).collect())
    }

    pub fn connection_statuses(&self) -> Result<Vec<SshConnectionStatus>, String> {
        let inner = self
            .inner
            .lock()
            .map_err(|_| "SSH session state lock is unavailable".to_string())?;
        let mut statuses = inner.connections.values().cloned().collect::<Vec<_>>();
        statuses.sort_by(|left, right| left.alias.cmp(&right.alias));
        Ok(statuses)
    }
}

pub fn discover_hosts() -> Result<Vec<SshHostCandidate>, String> {
    let aliases = aliases_from_config(&ssh_config_path())?;
    let mut hosts = aliases
        .into_iter()
        .filter_map(|alias| resolve_host(&alias).ok())
        .collect::<Vec<_>>();
    for saved in saved_hosts()? {
        if !hosts.iter().any(|host| host.alias == saved.alias) {
            hosts.push(saved.into());
        }
    }
    hosts.sort_by(|left, right| left.alias.cmp(&right.alias));
    Ok(hosts)
}

/// Save a direct OpenSSH target in Focus Pet's own application data. This
/// avoids editing `~/.ssh/config`, while still leaving host-key verification
/// and all authentication choices to OpenSSH.
pub fn save_host(
    alias: &str,
    hostname: &str,
    user: Option<&str>,
    port: Option<u16>,
) -> Result<SshHostCandidate, String> {
    validate_alias(alias)?;
    validate_hostname(hostname)?;
    if let Some(user) = user {
        validate_username(user)?;
    }
    let record = SavedSshHost {
        alias: alias.to_string(),
        hostname: hostname.to_string(),
        user: user.map(ToOwned::to_owned),
        port,
    };
    let mut records = saved_hosts()?;
    if let Some(existing) = records.iter_mut().find(|existing| existing.alias == alias) {
        *existing = record.clone();
    } else {
        records.push(record.clone());
    }
    records.sort_by(|left, right| left.alias.cmp(&right.alias));
    write_saved_hosts(&records)?;
    Ok(record.into())
}

pub fn forget_host(alias: &str) -> Result<(), String> {
    validate_alias(alias)?;
    let mut records = saved_hosts()?;
    let before = records.len();
    records.retain(|record| record.alias != alias);
    if records.len() == before {
        return Ok(());
    }
    write_saved_hosts(&records)
}

pub fn diagnose_host(alias: &str) -> Result<SshHostDiagnostic, String> {
    let candidate = resolve_host(alias)?;
    let remote = run_ssh(alias, codex_diagnostic_command())?;
    let mut operating_system = None;
    let mut architecture = None;
    let mut codex_path = None;
    let mut codex_version = None;
    let mut daemon_status = "notRunning".to_string();
    for line in remote.lines().map(str::trim) {
        if let Some(value) = line.strip_prefix("FOCUS_PET_OS=") {
            operating_system = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("FOCUS_PET_ARCH=") {
            architecture = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("FOCUS_PET_CODEX_PATH=") {
            codex_path = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("FOCUS_PET_CODEX_VERSION=") {
            codex_version = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("FOCUS_PET_DAEMON_STATUS=") {
            daemon_status = value.to_string();
        }
    }
    let (Some(operating_system), Some(architecture), Some(codex_path), Some(codex_version)) =
        (operating_system, architecture, codex_path, codex_version)
    else {
        return Err("未在非交互 SSH 环境中找到可运行的 Codex。请在设置中提供 Codex 可执行路径，或确保其 Node runtime 同时可用。".to_string());
    };
    let mut transport = None;
    // `daemon version` only says that Codex owns a daemon. It does not prove
    // this app can speak to its control socket. Prefer the public proxy, then
    // test a pure byte relay because current proxy builds can hang before the
    // WebSocket upgrade even though the same Unix socket is healthy.
    if daemon_status == "running" {
        daemon_status = match select_app_server_transport(alias, &codex_path) {
            Ok(selected) => {
                transport = Some(selected.identifier().to_string());
                "ready".to_string()
            }
            Err(_) => "proxyUnresponsive".to_string(),
        };
    }
    Ok(SshHostDiagnostic {
        alias: candidate.alias,
        hostname: candidate.hostname,
        user: candidate.user,
        port: candidate.port,
        operating_system,
        architecture,
        codex_version,
        codex_path,
        daemon_status,
        transport,
    })
}

pub fn provision_host(alias: &str) -> Result<SshProvisionResult, String> {
    let diagnostic = diagnose_host(alias)?;
    let post_bootstrap = match diagnostic.daemon_status.as_str() {
        "ready" => diagnostic,
        "notRunning" => {
            // This is explicitly invoked by the Settings confirmation button.
            // It is the official Codex setup command, not a Focus Pet upload.
            run_ssh(
                alias,
                &codex_command(&diagnostic.codex_path, "app-server daemon bootstrap"),
            )?;
            diagnose_host(alias)?
        }
        "proxyUnresponsive" => {
            return Err("检测到远端 Codex daemon 正在运行，但标准 proxy 与直连 Socket 的只读 App Server 握手均未获响应。为避免影响正在运行的 Codex 会话，未执行 bootstrap、重启或任何远端修改。请确认该会话由公开 App Server 管理，或通过官方 Remote Control 配对接入。".to_string());
        }
        _ => return Err(connection_readiness_error(&diagnostic)),
    };
    if post_bootstrap.daemon_status != "ready" {
        return Err(connection_readiness_error(&post_bootstrap));
    }
    Ok(SshProvisionResult {
        alias: alias.to_string(),
        daemon_status: post_bootstrap.daemon_status,
        message: format!(
            "已验证远端 Codex App Server 的只读 SSH {} 通道；Focus Pet 会同步会话状态。",
            post_bootstrap.transport.as_deref().unwrap_or("proxy")
        ),
    })
}

/// The official daemon is owned by Codex and may serve the user's other Codex
/// clients. Removing a host must therefore only stop Focus Pet's SSH proxy; it
/// must never stop, uninstall, or mutate the remote Codex daemon.
pub fn uninstall_host(alias: &str) -> Result<SshUninstallResult, String> {
    validate_alias(alias)?;
    Ok(SshUninstallResult {
        alias: alias.to_string(),
        message:
            "已断开 Focus Pet 的 SSH App Server 通道；远端 Codex daemon、认证和其他客户端均未修改。"
                .to_string(),
    })
}

fn run_stream_loop(inner: Arc<Mutex<SshInner>>, alias: String, diagnostic: SshHostDiagnostic) {
    let host_id = format!("ssh:{alias}");
    let mut failed_attempts = 0usize;
    loop {
        if stop_is_requested(&inner, &alias) {
            return;
        }
        let Some(transport) = diagnostic
            .transport
            .as_deref()
            .and_then(app_server_transport_from_identifier)
        else {
            mark_connection(&inner, &alias, "disconnected");
            return;
        };
        let command = transport.remote_command(&diagnostic.codex_path);
        let child = ssh_process(&alias, &command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            mark_connection(&inner, &alias, "disconnected");
            failed_attempts = failed_attempts.saturating_add(1);
            std::thread::sleep(reconnect_delay(&alias, failed_attempts));
            continue;
        };
        let Some(stdin) = child.stdin.take() else {
            mark_connection(&inner, &alias, "disconnected");
            let _ = child.wait();
            failed_attempts = failed_attempts.saturating_add(1);
            std::thread::sleep(reconnect_delay(&alias, failed_attempts));
            continue;
        };
        let Some(stdout) = child.stdout.take() else {
            mark_connection(&inner, &alias, "disconnected");
            let _ = child.wait();
            failed_attempts = failed_attempts.saturating_add(1);
            std::thread::sleep(reconnect_delay(&alias, failed_attempts));
            continue;
        };
        let Ok((mut stdin, stdout)) = connect_app_server_proxy_with_timeout(
            &mut child,
            stdin,
            stdout,
            APP_SERVER_HANDSHAKE_TIMEOUT,
        ) else {
            mark_connection(&inner, &alias, "disconnected");
            let _ = child.kill();
            let _ = child.wait();
            failed_attempts = failed_attempts.saturating_add(1);
            std::thread::sleep(reconnect_delay(&alias, failed_attempts));
            continue;
        };
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stdout = stdout;
            while let Ok(Some(line)) = read_app_server_proxy_message(&mut stdout) {
                if sender.send(line).is_err() {
                    return;
                }
            }
        });
        let mut last_stream_activity = Instant::now();
        let mut received_activity = false;
        let mut initialized = false;
        let handshake_deadline = Instant::now() + APP_SERVER_HANDSHAKE_TIMEOUT;
        let mut next_request_id = 2_u64;
        let mut pending_requests = HashMap::<u64, AppServerRequest>::new();
        // A completion is fetched at most once until the same thread becomes
        // active again. This keeps the proxy passive and avoids repeatedly
        // downloading durable history during the periodic state refresh.
        let mut loaded_completion_threads = HashSet::<String>::new();
        let mut next_poll_at = Instant::now();
        if send_app_server_message(
            &mut stdin,
            json!({
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "focus_pet",
                        "title": "Focus Pet",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true }
                }
            }),
        )
        .is_err()
        {
            let _ = child.kill();
        }
        loop {
            if stop_is_requested(&inner, &alias) {
                let _ = child.kill();
                break;
            }
            if !initialized && Instant::now() >= handshake_deadline {
                // Do not label a merely spawned SSH process as connected.
                // This selected transport did not complete its public
                // initialize handshake; the reconnect loop will re-check it.
                let _ = child.kill();
                break;
            }
            if initialized && Instant::now() >= next_poll_at {
                let request_id = next_request_id;
                next_request_id = next_request_id.saturating_add(1);
                if send_app_server_message(
                    &mut stdin,
                    json!({
                        "method": "thread/list",
                        "id": request_id,
                        "params": {
                            "cursor": null,
                            "limit": 100,
                            "sortKey": "updated_at",
                            "sortDirection": "desc"
                        }
                    }),
                )
                .is_err()
                {
                    let _ = child.kill();
                    break;
                }
                pending_requests.insert(request_id, AppServerRequest::ThreadList);
                next_poll_at = Instant::now() + APP_SERVER_POLL_INTERVAL;
            }
            match receiver.recv_timeout(Duration::from_secs(1)) {
                Ok(line) => {
                    last_stream_activity = Instant::now();
                    received_activity = true;
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if message.get("id").and_then(Value::as_u64) == Some(1) && !initialized {
                        if message.get("error").is_some() || message.get("result").is_none() {
                            let _ = child.kill();
                            break;
                        }
                        if send_app_server_message(
                            &mut stdin,
                            json!({ "method": "initialized", "params": {} }),
                        )
                        .is_err()
                        {
                            let _ = child.kill();
                            break;
                        }
                        initialized = true;
                        mark_connection(&inner, &alias, "connected");
                        next_poll_at = Instant::now();
                    }
                    let request = message
                        .get("id")
                        .and_then(Value::as_u64)
                        .and_then(|id| pending_requests.remove(&id));
                    let events =
                        app_server_events_from_message(&host_id, &message, request.as_ref());
                    if !events.is_empty() {
                        let thread_transitions = events
                            .iter()
                            .filter_map(app_server_thread_runtime)
                            .collect::<Vec<_>>();
                        push_events(&inner, events);
                        for (thread_id, runtime) in thread_transitions {
                            if runtime == "active" {
                                loaded_completion_threads.remove(&thread_id);
                                continue;
                            }
                            if runtime != "idle"
                                || !loaded_completion_threads.insert(thread_id.clone())
                            {
                                continue;
                            }
                            let request_id = next_request_id;
                            next_request_id = next_request_id.saturating_add(1);
                            if send_app_server_message(
                                &mut stdin,
                                json!({
                                    "method": "thread/turns/list",
                                    "id": request_id,
                                    "params": {
                                        "threadId": thread_id,
                                        "limit": 1,
                                        "sortDirection": "desc",
                                        "itemsView": "summary"
                                    }
                                }),
                            )
                            .is_ok()
                            {
                                pending_requests
                                    .insert(request_id, AppServerRequest::TurnsList { thread_id });
                            }
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout)
                    if stream_is_stale(last_stream_activity, Instant::now()) =>
                {
                    let _ = child.kill();
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        mark_connection(&inner, &alias, "disconnected");
        let _ = child.wait();
        if stop_is_requested(&inner, &alias) {
            return;
        }
        failed_attempts = if received_activity {
            0
        } else {
            failed_attempts.saturating_add(1)
        };
        std::thread::sleep(reconnect_delay(&alias, failed_attempts.saturating_add(1)));
    }
}

fn send_app_server_message(
    stdin: &mut std::process::ChildStdin,
    message: Value,
) -> Result<(), String> {
    send_app_server_proxy_message(stdin, message)
}

/// Select a working byte transport without modifying the remote daemon.
/// `app-server proxy` remains the first choice because it is the documented
/// Codex entrypoint. The direct relay only exists for the known case where
/// that proxy hangs while its already-running Unix Socket accepts WebSocket
/// clients normally.
fn select_app_server_transport(
    alias: &str,
    codex_path: &str,
) -> Result<AppServerTransport, String> {
    for transport in [
        AppServerTransport::Proxy,
        AppServerTransport::DirectUnixSocket,
    ] {
        if probe_app_server_transport(alias, &transport.remote_command(codex_path)).is_ok() {
            return Ok(transport);
        }
    }
    Err("远端 App Server 的全部只读传输通道均未响应。".to_string())
}

/// Send only `initialize` and wait for its JSON-RPC response. This neither
/// resumes a thread nor issues a turn/item/history request; it is safe to use
/// as a readiness check around a daemon serving another Codex client.
fn probe_app_server_transport(alias: &str, command: &str) -> Result<(), String> {
    let mut child = ssh_process(alias, &command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动远端 App Server proxy：{error}"))?;
    let result = (|| {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "远端 App Server proxy 未提供标准输入。".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "远端 App Server proxy 未提供标准输出。".to_string())?;
        let (mut stdin, stdout) = connect_app_server_proxy_with_timeout(
            &mut child,
            stdin,
            stdout,
            APP_SERVER_HANDSHAKE_TIMEOUT,
        )?;
        send_app_server_message(
            &mut stdin,
            json!({
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "focus_pet_probe",
                        "title": "Focus Pet readiness check",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": { "experimentalApi": true }
                }
            }),
        )?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut stdout = stdout;
            while let Ok(Some(line)) = read_app_server_proxy_message(&mut stdout) {
                if sender.send(line).is_err() {
                    return;
                }
            }
        });
        let deadline = Instant::now() + APP_SERVER_HANDSHAKE_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("远端 App Server proxy 在只读握手期间未响应。".to_string());
            }
            let line = receiver
                .recv_timeout(remaining)
                .map_err(|_| "远端 App Server proxy 在只读握手期间未响应。".to_string())?;
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id").and_then(Value::as_u64) != Some(1) {
                continue;
            }
            if message.get("error").is_some() {
                return Err("远端 App Server 拒绝了 Focus Pet 的只读握手。".to_string());
            }
            return message
                .get("result")
                .is_some()
                .then_some(())
                .ok_or_else(|| "远端 App Server 返回了无效的握手响应。".to_string());
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn connection_readiness_error(diagnostic: &SshHostDiagnostic) -> String {
    match diagnostic.daemon_status.as_str() {
        "notRunning" => "远端 Codex App Server daemon 尚未运行。可在确认后点击“启用接入”启动官方 daemon。".to_string(),
        "proxyUnresponsive" => "远端 Codex daemon 已运行，但标准 proxy 与直连 Socket 的只读 App Server 握手均未响应。Focus Pet 不会 bootstrap、重启或干预现有会话；该主机需要通过官方 Remote Control 配对接入。".to_string(),
        "ready" => "远端 Codex App Server 已就绪。".to_string(),
        _ => "远端 Codex App Server 尚未达到可安全连接状态。".to_string(),
    }
}

fn push_events(inner: &Arc<Mutex<SshInner>>, events: Vec<CodexEventEnvelope>) {
    if let Ok(mut state) = inner.lock() {
        state.events.extend(events);
        while state.events.len() > 2_000 {
            state.events.pop_front();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AppServerRequest {
    ThreadList,
    TurnsList { thread_id: String },
}

fn app_server_events_from_message(
    host_id: &str,
    message: &Value,
    request: Option<&AppServerRequest>,
) -> Vec<CodexEventEnvelope> {
    if message.get("method").and_then(Value::as_str) == Some("thread/status/changed") {
        return app_server_status_event(host_id, message.get("params").unwrap_or(&Value::Null))
            .into_iter()
            .collect();
    }
    if let Some(AppServerRequest::TurnsList { thread_id }) = request {
        return app_server_completion_events(host_id, thread_id, message);
    }
    message
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
        .map(|threads| {
            threads
                .iter()
                .filter_map(|thread| app_server_thread_event(host_id, thread))
                .collect()
        })
        .unwrap_or_default()
}

fn app_server_thread_runtime(event: &CodexEventEnvelope) -> Option<(String, String)> {
    (event.kind == "turn.statusChanged")
        .then(|| event.payload.get("runtime").and_then(Value::as_str))
        .flatten()
        .map(|runtime| (event.session_id.clone(), runtime.to_string()))
}

/// `thread/turns/list` is explicitly read-only and returns persisted items
/// without calling `thread/resume`. Only terminal `agentMessage` text is
/// projected; user messages, reasoning and tool output are never emitted.
fn app_server_completion_events(
    host_id: &str,
    requested_thread_id: &str,
    message: &Value,
) -> Vec<CodexEventEnvelope> {
    let now = chrono::Utc::now().to_rfc3339();
    message
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            let thread_id = turn
                .get("threadId")
                .or_else(|| turn.get("thread_id"))
                .and_then(Value::as_str);
            let turn_id = turn.get("id").and_then(Value::as_str);
            let occurred_at = now.clone();
            turn.get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |item| {
                    (item.get("type").and_then(Value::as_str) == Some("agentMessage"))
                        .then_some(item)?;
                    let text = item.get("text").and_then(Value::as_str)?.trim();
                    if text.is_empty() {
                        return None;
                    }
                    let item_id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("agent-message");
                    let session_id = thread_id.unwrap_or(requested_thread_id);
                    if session_id.is_empty() {
                        return None;
                    }
                    let sequence = SSH_EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                    Some(CodexEventEnvelope {
                        schema_version: 1,
                        event_id: format!("{host_id}:appserver:{session_id}:{item_id}:{sequence}"),
                        sequence,
                        host_id: host_id.to_string(),
                        session_id: session_id.to_string(),
                        thread_id: Some(session_id.to_string()),
                        turn_id: turn_id.map(ToOwned::to_owned),
                        occurred_at: occurred_at.clone(),
                        received_at: occurred_at.clone(),
                        kind: "message.updated".to_string(),
                        source: "appServer".to_string(),
                        confidence: "exact".to_string(),
                        payload: json!({
                            "itemId": item_id,
                            "role": "assistant",
                            "phase": "final_answer",
                            "text": text,
                            "isFinal": true,
                        }),
                    })
                })
        })
        .collect()
}

fn app_server_status_event(host_id: &str, params: &Value) -> Option<CodexEventEnvelope> {
    let thread_id = params.get("threadId")?.as_str()?;
    app_server_thread_event(
        host_id,
        &json!({ "id": thread_id, "status": params.get("status")? }),
    )
}

fn app_server_thread_event(host_id: &str, thread: &Value) -> Option<CodexEventEnvelope> {
    let thread_id = thread.get("id")?.as_str()?;
    let status = thread.get("status")?;
    let runtime = status.get("type")?.as_str()?;
    if runtime == "notLoaded" {
        return None;
    }
    let active_flags = status
        .get("activeFlags")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let sequence = SSH_EVENT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = chrono::Utc::now().to_rfc3339();
    Some(CodexEventEnvelope {
        schema_version: 1,
        event_id: format!("{host_id}:appserver:{thread_id}:{sequence}"),
        sequence,
        host_id: host_id.to_string(),
        session_id: thread_id.to_string(),
        thread_id: Some(thread_id.to_string()),
        turn_id: None,
        occurred_at: now.clone(),
        received_at: now,
        kind: "turn.statusChanged".to_string(),
        source: "appServer".to_string(),
        confidence: "exact".to_string(),
        payload: json!({
            "runtime": runtime,
            "activeFlags": active_flags,
            "cwd": thread.get("cwd"),
            "title": thread.get("name").or_else(|| thread.get("preview")),
        }),
    })
}

fn stop_is_requested(inner: &Arc<Mutex<SshInner>>, alias: &str) -> bool {
    inner
        .lock()
        .map(|state| state.stop_requested.contains(alias))
        .unwrap_or(true)
}

fn stream_is_stale(last_activity: Instant, now: Instant) -> bool {
    now.saturating_duration_since(last_activity) >= STREAM_HEARTBEAT_TIMEOUT
}

/// Stable per-host jitter avoids synchronized reconnect storms without adding a
/// random-number dependency to the desktop binary.
fn reconnect_delay(alias: &str, failed_attempts: usize) -> Duration {
    let base = [1_u64, 2, 5, 10, 30][failed_attempts.saturating_sub(1).min(4)];
    let jitter = alias.bytes().fold(0_u64, |hash, byte| {
        hash.wrapping_mul(31).wrapping_add(byte as u64)
    }) % 251;
    Duration::from_millis(base.saturating_mul(1_000).saturating_add(jitter))
}

fn mark_connection(inner: &Arc<Mutex<SshInner>>, alias: &str, status: &str) {
    if let Ok(mut state) = inner.lock() {
        state.connections.insert(
            alias.to_string(),
            SshConnectionStatus {
                alias: alias.to_string(),
                status: status.to_string(),
            },
        );
    }
}

fn resolve_host(alias: &str) -> Result<SshHostCandidate, String> {
    validate_alias(alias)?;
    if let Some(saved) = saved_hosts()?
        .into_iter()
        .find(|saved| saved.alias == alias)
    {
        return Ok(saved.into());
    }
    let output = Command::new("ssh")
        .args(["-G", alias])
        .output()
        .map_err(|error| format!("无法读取 SSH 配置：{error}"))?;
    if !output.status.success() {
        return Err(format!("SSH Host {alias} 不可解析。"));
    }
    let mut values = HashMap::new();
    let resolved = String::from_utf8_lossy(&output.stdout);
    for line in resolved.lines() {
        if let Some((key, value)) = line.split_once(' ') {
            values.insert(key, value.trim());
        }
    }
    Ok(SshHostCandidate {
        alias: alias.to_string(),
        hostname: values.get("hostname").copied().unwrap_or(alias).to_string(),
        user: values.get("user").map(|value| (*value).to_string()),
        port: values.get("port").and_then(|value| value.parse().ok()),
        source: "sshConfig".to_string(),
    })
}

fn run_ssh(alias: &str, remote_command: &str) -> Result<String, String> {
    validate_alias(alias)?;
    let output = ssh_process(alias, remote_command)
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("无法连接 SSH Host：{error}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() {
            "SSH 命令失败。".to_string()
        } else {
            error
        })
    }
}

fn ssh_process(alias: &str, remote_command: &str) -> Command {
    let mut command = Command::new("ssh");
    command.arg("-T");
    if let Ok(Some(saved)) =
        saved_hosts().map(|records| records.into_iter().find(|record| record.alias == alias))
    {
        if let Some(port) = saved.port {
            command.arg("-p").arg(port.to_string());
        }
        let destination = saved
            .user
            .map(|user| format!("{user}@{}", saved.hostname))
            .unwrap_or(saved.hostname);
        command.arg(destination);
    } else {
        command.arg(alias);
    }
    command.arg(remote_command);
    command
}

/// Do not source shell startup files: they may have side effects and make a
/// diagnostic unsafe. Instead probe common npm runtime locations and prepend
/// the selected executable's directory when invoking the Node launcher.
fn codex_diagnostic_command() -> &'static str {
    r#"printf 'FOCUS_PET_OS=%s\n' "$(uname -s)"; printf 'FOCUS_PET_ARCH=%s\n' "$(uname -m)"; for candidate in "$HOME/.local/bin/codex" "$HOME/.npm-global/bin/codex" "$HOME/.volta/bin/codex" "$HOME/.asdf/shims/codex" "$HOME"/.nvm/versions/node/*/bin/codex /usr/local/bin/codex /usr/bin/codex /opt/homebrew/bin/codex; do [ -x "$candidate" ] || continue; candidate_dir=${candidate%/*}; version=$(PATH="$candidate_dir:$PATH" "$candidate" --version 2>/dev/null) || continue; printf 'FOCUS_PET_CODEX_PATH=%s\n' "$candidate"; printf 'FOCUS_PET_CODEX_VERSION=%s\n' "$version"; daemon=$(PATH="$candidate_dir:$PATH" "$candidate" app-server daemon version 2>/dev/null || true); case "$daemon" in *'"status":"running"'*|*'"status": "running"'*) printf 'FOCUS_PET_DAEMON_STATUS=running\n' ;; *) printf 'FOCUS_PET_DAEMON_STATUS=notRunning\n' ;; esac; break; done"#
}

fn codex_command(codex_path: &str, arguments: &str) -> String {
    // `codex_path` originates only from the constrained discovery command
    // above. Single-quote anyway before passing it through OpenSSH's remote
    // shell so a compromised host record cannot turn a diagnostic into shell
    // interpolation on a later reconnect.
    let escaped_path = codex_path.replace('\'', "'\\\"'\\\"'");
    let parent = Path::new(codex_path)
        .parent()
        .and_then(Path::to_str)
        .unwrap_or_default()
        .replace('\'', "'\\\"'\\\"'");
    format!("PATH='{parent}':$PATH; export PATH; '{escaped_path}' {arguments}")
}

fn app_server_transport_from_identifier(identifier: &str) -> Option<AppServerTransport> {
    match identifier {
        "appServerProxy" => Some(AppServerTransport::Proxy),
        "directUnixSocket" => Some(AppServerTransport::DirectUnixSocket),
        _ => None,
    }
}

/// A dependency-free SSH stdio relay for the *existing* App Server Unix
/// socket. The payload contains only byte forwarding: it neither starts
/// Codex nor calls a shell startup file. Python 3 is deliberately required
/// for this fallback, while hosts without it simply retain the standard
/// `codex app-server proxy` route.
fn direct_unix_socket_relay_command() -> String {
    const RELAY_BASE64: &str = "aW1wb3J0IG9zLHNlbGVjdCxzb2NrZXQKcz1zb2NrZXQuc29ja2V0KHNvY2tldC5BRl9VTklYLHNvY2tldC5TT0NLX1NUUkVBTSkKcy5jb25uZWN0KG9zLnBhdGguZXhwYW5kdXNlcignfi8uY29kZXgvYXBwLXNlcnZlci1jb250cm9sL2FwcC1zZXJ2ZXItY29udHJvbC5zb2NrJykpCndoaWxlIFRydWU6CiByLF8sXz1zZWxlY3Quc2VsZWN0KFswLHNdLFtdLFtdKQogaWYgMCBpbiByOgogIGI9b3MucmVhZCgwLDY1NTM2KQogIGlmIG5vdCBiOiBicmVhawogIHMuc2VuZGFsbChiKQogaWYgcyBpbiByOgogIGI9cy5yZWN2KDY1NTM2KQogIGlmIG5vdCBiOiBicmVhawogIG9zLndyaXRlKDEsYikK";
    format!("python3 -u -c \"import base64;exec(base64.b64decode('{RELAY_BASE64}'))\"")
}

/// Collect concrete aliases from the user's SSH config and its `Include`
/// files. Resolution still goes through `ssh -G`, so HostName/User/Port and
/// OpenSSH's precedence rules remain authoritative.
fn aliases_from_config(config_path: &PathBuf) -> Result<Vec<String>, String> {
    let mut aliases = Vec::new();
    let mut visited = HashSet::new();
    collect_aliases_from_config(config_path, &mut aliases, &mut visited)?;
    Ok(aliases)
}

fn collect_aliases_from_config(
    config_path: &PathBuf,
    aliases: &mut Vec<String>,
    visited: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let canonical = std::fs::canonicalize(config_path).unwrap_or_else(|_| config_path.clone());
    if !visited.insert(canonical) {
        return Ok(());
    }
    let contents = match std::fs::read_to_string(config_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    for line in contents.lines() {
        let line = line.split('#').next().unwrap_or_default().trim();
        let Some((key, values)) = ssh_directive(line) else {
            continue;
        };
        if key.eq_ignore_ascii_case("host") {
            for alias in values.split_whitespace() {
                if alias.contains('*')
                    || alias.contains('?')
                    || alias.starts_with('!')
                    || !is_safe_alias(alias)
                {
                    continue;
                }
                if !aliases.iter().any(|existing| existing == alias) {
                    aliases.push(alias.to_string());
                }
            }
        } else if key.eq_ignore_ascii_case("include") {
            for pattern in values.split_whitespace() {
                for included in expand_include_pattern(config_path, pattern) {
                    collect_aliases_from_config(&included, aliases, visited)?;
                }
            }
        }
    }
    Ok(())
}

fn ssh_directive(line: &str) -> Option<(&str, &str)> {
    let (key, values) = line.split_once(char::is_whitespace)?;
    Some((key, values.trim()))
}

fn expand_include_pattern(config_path: &PathBuf, pattern: &str) -> Vec<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let expanded = if let Some(suffix) = pattern.strip_prefix("~/") {
        home.unwrap_or_else(|| PathBuf::from(".")).join(suffix)
    } else {
        let path = PathBuf::from(pattern);
        if path.is_absolute() {
            path
        } else {
            config_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(path)
        }
    };
    let Some(name) = expanded.file_name().and_then(|value| value.to_str()) else {
        return Vec::new();
    };
    if !name.contains('*') && !name.contains('?') {
        return vec![expanded];
    }
    let Some(parent) = expanded.parent() else {
        return Vec::new();
    };
    let mut matches = std::fs::read_dir(parent)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let file_name = file_name.to_str()?;
            (simple_glob_match(name, file_name) && entry.path().is_file()).then_some(entry.path())
        })
        .collect::<Vec<_>>();
    matches.sort();
    matches
}

fn simple_glob_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut pattern_index, mut value_index, mut star, mut resume) = (0, 0, None, 0);
    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star = Some(pattern_index);
            pattern_index += 1;
            resume = value_index;
        } else if let Some(star_index) = star {
            pattern_index = star_index + 1;
            resume += 1;
            value_index = resume;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn ssh_config_path() -> PathBuf {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ssh/config")
}

impl From<SavedSshHost> for SshHostCandidate {
    fn from(value: SavedSshHost) -> Self {
        Self {
            alias: value.alias,
            hostname: value.hostname,
            user: value.user,
            port: value.port,
            source: "focusPet".to_string(),
        }
    }
}

fn saved_hosts_path() -> PathBuf {
    focus_pet_data_root().join(SSH_HOSTS_FILE)
}

fn saved_hosts() -> Result<Vec<SavedSshHost>, String> {
    let path = saved_hosts_path();
    match fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|error| format!("无法解析 Focus Pet SSH 主机配置：{error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_saved_hosts(records: &[SavedSshHost]) -> Result<(), String> {
    let path = saved_hosts_path();
    let parent = path
        .parent()
        .ok_or_else(|| "SSH 主机配置目录不可用".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".focus-pet-ssh-hosts-{}-{}.tmp",
        std::process::id(),
        chrono::Utc::now().timestamp_micros()
    ));
    let serialized = serde_json::to_vec_pretty(records).map_err(|error| error.to_string())?;
    {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&serialized)
            .map_err(|error| error.to_string())?;
        file.write_all(b"\n").map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    set_private_file_permissions(&temporary);
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    set_private_file_permissions(&path);
    Ok(())
}

fn focus_pet_data_root() -> PathBuf {
    if let Some(path) = env::var_os("FOCUS_PET_DATA_DIR").map(PathBuf::from) {
        return path;
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        return home.join("Library/Application Support/Focus Pet");
    }
    #[cfg(target_os = "windows")]
    {
        return env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("Focus Pet");
    }
    #[cfg(target_os = "linux")]
    {
        return env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("Focus Pet");
    }
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) {}

fn validate_alias(alias: &str) -> Result<(), String> {
    if is_safe_alias(alias) {
        Ok(())
    } else {
        Err("SSH Host alias 只能包含字母、数字、点、下划线和连字符。".to_string())
    }
}

fn validate_hostname(hostname: &str) -> Result<(), String> {
    let valid = !hostname.is_empty()
        && hostname.len() <= 253
        && hostname
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'));
    valid
        .then_some(())
        .ok_or_else(|| "SSH 主机地址只能包含字母、数字、点和连字符。".to_string())
}

fn validate_username(username: &str) -> Result<(), String> {
    let valid = !username.is_empty()
        && username.len() <= 128
        && username.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    valid
        .then_some(())
        .ok_or_else(|| "SSH 用户名只能包含字母、数字、点、下划线和连字符。".to_string())
}

fn is_safe_alias(alias: &str) -> bool {
    !alias.is_empty()
        && alias.len() <= 128
        && alias.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

#[cfg(test)]
mod tests {
    use super::{
        aliases_from_config, app_server_events_from_message, app_server_transport_from_identifier,
        codex_command, direct_unix_socket_relay_command, is_safe_alias, reconnect_delay,
        stream_is_stale, validate_alias, AppServerRequest, AppServerTransport, SshSessionManager,
        APP_SERVER_POLL_INTERVAL, STREAM_HEARTBEAT_TIMEOUT,
    };
    use serde_json::json;
    use std::{
        fs,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn accepts_only_concrete_safe_ssh_aliases() {
        assert!(is_safe_alias("work-prod_01"));
        assert!(validate_alias("work.prod-01").is_ok());
        assert!(validate_alias("work; rm -rf /").is_err());
        assert!(validate_alias("*").is_err());
        assert!(validate_alias("../../host").is_err());
    }

    #[test]
    fn discovers_concrete_aliases_in_included_ssh_configs() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("focus-pet-ssh-config-{unique}"));
        let includes = root.join("conf.d");
        fs::create_dir_all(&includes).expect("create test SSH config directory");
        fs::write(
            root.join("config"),
            "Host local-only *.wildcard !negated\n  HostName example\nInclude conf.d/*.conf\n",
        )
        .expect("write main SSH config");
        fs::write(
            includes.join("remote.conf"),
            "Host remote-prod remote_dev\n  HostName remote.example\n",
        )
        .expect("write included SSH config");

        let aliases = aliases_from_config(&root.join("config")).expect("discover aliases");
        assert_eq!(aliases, vec!["local-only", "remote-prod", "remote_dev"]);
        fs::remove_dir_all(root).expect("remove generated test SSH config");
    }

    #[test]
    fn app_server_status_broadcast_and_thread_list_are_exact_remote_events() {
        let broadcast = json!({
            "method": "thread/status/changed",
            "params": { "threadId": "thread-active", "status": { "type": "active", "activeFlags": ["waitingOnApproval"] } }
        });
        let events = app_server_events_from_message("ssh:remote-prod", &broadcast, None);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].host_id, "ssh:remote-prod");
        assert_eq!(events[0].session_id, "thread-active");
        assert_eq!(events[0].payload["runtime"], "active");
        assert_eq!(events[0].payload["activeFlags"][0], "waitingOnApproval");

        let list = json!({
            "id": 2,
            "result": { "data": [
                { "id": "loaded", "status": { "type": "idle" }, "preview": "Done" },
                { "id": "history-only", "status": { "type": "notLoaded" } }
            ] }
        });
        let events = app_server_events_from_message("ssh:remote-prod", &list, None);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "loaded");
    }

    #[test]
    fn app_server_turn_history_projects_only_final_assistant_text() {
        let history = json!({
            "id": 3,
            "result": { "data": [{
                "id": "turn-1",
                "items": [
                    { "id": "user-1", "type": "userMessage", "content": [{ "type": "text", "text": "private prompt" }] },
                    { "id": "reasoning-1", "type": "reasoning", "summary": ["private reasoning"] },
                    { "id": "assistant-1", "type": "agentMessage", "text": "Safe final answer" }
                ]
            }] }
        });
        let events = app_server_events_from_message(
            "ssh:remote-prod",
            &history,
            Some(&AppServerRequest::TurnsList {
                thread_id: "thread-1".to_string(),
            }),
        );
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "message.updated");
        assert_eq!(events[0].session_id, "thread-1");
        assert_eq!(events[0].payload["text"], "Safe final answer");
        assert!(events[0].payload.get("content").is_none());
    }

    #[test]
    fn codex_command_inherits_the_discovered_node_runtime_directory() {
        let command = codex_command(
            "/home/example/.nvm/versions/node/v24/bin/codex",
            "app-server proxy",
        );
        assert!(command.contains("PATH='/home/example/.nvm/versions/node/v24/bin':$PATH"));
        assert!(command.contains("'"));
        assert!(command.ends_with("app-server proxy"));
    }

    #[test]
    fn direct_unix_socket_transport_is_explicit_and_transport_only() {
        assert_eq!(
            app_server_transport_from_identifier("directUnixSocket"),
            Some(AppServerTransport::DirectUnixSocket)
        );
        assert_eq!(
            app_server_transport_from_identifier("appServerProxy"),
            Some(AppServerTransport::Proxy)
        );
        assert!(app_server_transport_from_identifier("unknown").is_none());
        let command = direct_unix_socket_relay_command();
        assert!(command.starts_with("python3 -u -c "));
        assert!(command.contains("base64.b64decode"));
        assert!(!command.contains("codex app-server"));
    }

    #[test]
    fn reconnect_backoff_is_capped_jittered_and_heartbeat_timeout_is_explicit() {
        let first = reconnect_delay("remote-prod", 1);
        let capped = reconnect_delay("remote-prod", 99);
        assert!(first >= Duration::from_secs(1));
        assert!(first < Duration::from_millis(1_251));
        assert!(capped >= Duration::from_secs(30));
        assert!(capped < Duration::from_millis(30_251));

        let now = Instant::now();
        assert!(!stream_is_stale(now, now));
        assert!(stream_is_stale(now - STREAM_HEARTBEAT_TIMEOUT, now));
        assert_eq!(APP_SERVER_POLL_INTERVAL, Duration::from_secs(2));
    }

    #[test]
    fn explicit_disconnect_marks_transport_offline_without_ending_a_codex_turn() {
        let manager = SshSessionManager::new();
        manager
            .disconnect("remote-prod")
            .expect("request disconnect");
        let status = manager.connection_statuses().expect("read status");
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].alias, "remote-prod");
        assert_eq!(status[0].status, "disconnected");
        assert!(manager.drain().expect("drain events").is_empty());
    }
}
