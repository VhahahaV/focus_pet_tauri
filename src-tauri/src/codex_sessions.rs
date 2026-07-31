use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    env,
    fs::{self, File, OpenOptions},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const JOURNAL_FILE: &str = "codex-session-events.jsonl";
const PREFERENCES_FILE: &str = "codex-session-preferences.json";
const MAX_VISIBLE_MESSAGE_CHARS: usize = 2_000;
const MAX_TRANSCRIPT_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_JOURNAL_BYTES: u64 = 20 * 1024 * 1024;
const APP_SERVER_STREAM_HEARTBEAT: Duration = Duration::from_secs(30);
/// Status broadcasts are immediate when supported. A two-second inventory
/// refresh is the bounded fallback for App Server builds that do not broadcast
/// changes to passive observer clients.
const APP_SERVER_STREAM_POLL: Duration = Duration::from_secs(2);
/// Normal terminal Codex sessions write their rollout transcript here even
/// when no Hook or App Server is enabled. Keep discovery recent and bounded:
/// Focus Pet is a live companion, not a complete transcript browser.
const ROLLOUT_DISCOVERY_WINDOW: Duration = Duration::from_secs(24 * 60 * 60);
const PROCESS_PROBE_INTERVAL: Duration = Duration::from_secs(2);
const MAX_DISCOVERED_ROLLOUTS: usize = 32;
static MANAGED_STREAM_SEQUENCE: AtomicU64 = AtomicU64::new(1);
static MANAGED_STREAM_STARTED: AtomicBool = AtomicBool::new(false);
static FOCUS_PET_EPHEMERAL_APP_SERVER: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

/// `codex app-server proxy` deliberately forwards the Unix-socket WebSocket
/// byte stream unchanged. These helpers own the small, standards-compliant
/// client side needed by Focus Pet's read-only observer, so both local and SSH
/// proxy paths use the same transport rather than treating it as JSONL.
pub fn connect_app_server_proxy(
    mut stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
) -> Result<
    (
        std::process::ChildStdin,
        BufReader<std::process::ChildStdout>,
    ),
    String,
> {
    let client_key = websocket_client_key()?;
    stdin
        .write_all(
            format!(
                "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {client_key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            )
            .as_bytes(),
        )
        .map_err(|error| format!("无法向 Codex App Server 发起 WebSocket 升级：{error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("无法刷新 Codex App Server WebSocket 升级：{error}"))?;
    let mut reader = BufReader::new(stdout);
    let mut status = String::new();
    reader
        .read_line(&mut status)
        .map_err(|error| format!("无法读取 Codex App Server WebSocket 响应：{error}"))?;
    if !(status.starts_with("HTTP/1.1 101") || status.starts_with("HTTP/1.0 101")) {
        return Err("Codex App Server proxy 未接受 WebSocket 升级。".to_string());
    }
    let mut received_upgrade = false;
    let mut header_bytes = status.len();
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|error| format!("无法读取 Codex App Server WebSocket 响应头：{error}"))?;
        header_bytes = header_bytes.saturating_add(line.len());
        if header_bytes > 16 * 1024 {
            return Err("Codex App Server WebSocket 响应头过大。".to_string());
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if line
            .split_once(':')
            .map(|(name, value)| {
                name.trim().eq_ignore_ascii_case("upgrade")
                    && value.trim().eq_ignore_ascii_case("websocket")
            })
            .unwrap_or(false)
        {
            received_upgrade = true;
        }
    }
    if !received_upgrade {
        return Err("Codex App Server WebSocket 响应缺少 Upgrade 头。".to_string());
    }
    Ok((stdin, reader))
}

fn websocket_client_key() -> Result<String, String> {
    let mut nonce = [0_u8; 16];
    getrandom::getrandom(&mut nonce)
        .map_err(|error| format!("无法生成安全的 WebSocket 客户端 nonce：{error}"))?;
    Ok(BASE64_STANDARD.encode(nonce))
}

/// The raw proxy has no application-level deadline before the WebSocket
/// upgrade finishes. Keep a bounded caller-visible timeout, and only ever
/// terminate the proxy child Focus Pet just spawned; this cannot stop the
/// daemon behind it.
pub fn connect_app_server_proxy_with_timeout(
    child: &mut std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
    timeout: Duration,
) -> Result<
    (
        std::process::ChildStdin,
        BufReader<std::process::ChildStdout>,
    ),
    String,
> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(connect_app_server_proxy(stdin, stdout));
    });
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            Err("Codex App Server proxy 的 WebSocket 升级超时。".to_string())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("Codex App Server proxy 在 WebSocket 升级前已断开。".to_string())
        }
    }
}

pub fn send_app_server_proxy_message(
    stdin: &mut std::process::ChildStdin,
    message: Value,
) -> Result<(), String> {
    let payload = serde_json::to_string(&message).map_err(|error| error.to_string())?;
    write_websocket_text_frame(stdin, payload.as_bytes())
}

pub fn read_app_server_proxy_message(
    stdout: &mut BufReader<std::process::ChildStdout>,
) -> Result<Option<String>, String> {
    loop {
        let mut first = [0_u8; 1];
        match stdout.read_exact(&mut first) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(format!("读取 Codex App Server WebSocket 帧失败：{error}")),
        }
        let mut second = [0_u8; 1];
        stdout
            .read_exact(&mut second)
            .map_err(|error| format!("读取 Codex App Server WebSocket 帧失败：{error}"))?;
        let opcode = first[0] & 0x0f;
        let fin = first[0] & 0x80 != 0;
        let masked = second[0] & 0x80 != 0;
        let mut payload_len = u64::from(second[0] & 0x7f);
        if payload_len == 126 {
            let mut extended = [0_u8; 2];
            stdout
                .read_exact(&mut extended)
                .map_err(|error| format!("读取 Codex App Server WebSocket 帧长度失败：{error}"))?;
            payload_len = u64::from(u16::from_be_bytes(extended));
        } else if payload_len == 127 {
            let mut extended = [0_u8; 8];
            stdout
                .read_exact(&mut extended)
                .map_err(|error| format!("读取 Codex App Server WebSocket 帧长度失败：{error}"))?;
            payload_len = u64::from_be_bytes(extended);
        }
        if payload_len > 4 * 1024 * 1024 {
            return Err("Codex App Server WebSocket 帧超过安全大小限制。".to_string());
        }
        let mut mask = [0_u8; 4];
        if masked {
            stdout
                .read_exact(&mut mask)
                .map_err(|error| format!("读取 Codex App Server WebSocket 掩码失败：{error}"))?;
        }
        let mut payload = vec![0_u8; payload_len as usize];
        stdout
            .read_exact(&mut payload)
            .map_err(|error| format!("读取 Codex App Server WebSocket 负载失败：{error}"))?;
        if masked {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % mask.len()];
            }
        }
        match opcode {
            0x1 if fin => {
                return String::from_utf8(payload)
                    .map(Some)
                    .map_err(|_| "Codex App Server WebSocket 文本帧不是 UTF-8。".to_string());
            }
            0x8 => return Ok(None),
            0x9 | 0xA => continue,
            0x1 | 0x0 => {
                return Err(
                    "Codex App Server 使用了 Focus Pet 当前不支持的分片 WebSocket 帧。".to_string(),
                );
            }
            _ => continue,
        }
    }
}

fn write_websocket_text_frame(
    stdin: &mut std::process::ChildStdin,
    payload: &[u8],
) -> Result<(), String> {
    let payload_len = payload.len();
    if payload_len > 65_535 {
        return Err("Codex App Server 请求超过 WebSocket 帧大小限制。".to_string());
    }
    let mut mask = [0_u8; 4];
    getrandom::getrandom(&mut mask)
        .map_err(|error| format!("无法生成安全的 WebSocket 掩码：{error}"))?;
    stdin
        .write_all(&[0x81])
        .and_then(|_| {
            if payload_len < 126 {
                stdin.write_all(&[0x80 | payload_len as u8])
            } else {
                stdin.write_all(&[0x80 | 126])?;
                stdin.write_all(&(payload_len as u16).to_be_bytes())
            }
        })
        .and_then(|_| stdin.write_all(&mask))
        .map_err(|error| format!("写入 Codex App Server WebSocket 帧失败：{error}"))?;
    let masked = payload
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ mask[index % mask.len()])
        .collect::<Vec<_>>();
    stdin
        .write_all(&masked)
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("刷新 Codex App Server WebSocket 帧失败：{error}"))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexEventEnvelope {
    pub schema_version: u8,
    pub event_id: String,
    pub sequence: u64,
    pub host_id: String,
    pub session_id: String,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub occurred_at: String,
    pub received_at: String,
    pub kind: String,
    pub source: String,
    pub confidence: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexVisibleMessage {
    pub item_id: Option<String>,
    pub role: String,
    pub phase: Option<String>,
    pub text: String,
    pub is_final: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnState {
    pub turn_id: String,
    pub status: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionSnapshot {
    pub host_id: String,
    pub host_kind: String,
    pub session_id: String,
    pub thread_id: Option<String>,
    pub title: String,
    pub cwd: Option<String>,
    pub lifecycle: String,
    pub runtime: String,
    pub active_flags: Vec<String>,
    pub current_turn: Option<CodexTurnState>,
    pub latest_visible_message: Option<CodexVisibleMessage>,
    pub capability_mode: String,
    pub updated_at: String,
    #[serde(skip)]
    transcript_path: Option<String>,
    #[serde(skip)]
    status_source_priority: u8,
    #[serde(skip)]
    status_received_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexIntegrationStatus {
    pub journal_path: String,
    pub hooks_path: String,
    pub codex_config_path: String,
    pub hook_command: String,
    pub hook_file_exists: bool,
    pub has_inline_hooks: bool,
    pub mode: String,
    pub content_mode: String,
    /// `running`, `available`, `ephemeralAvailable`, or `unavailable`. This
    /// local check does not start, install, or otherwise alter Codex.
    pub managed_daemon_status: String,
    pub managed_daemon_message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSyncPreferences {
    /// `statusOnly` never persists or presents assistant text. The default is
    /// deliberately limited to assistant-visible output, never user prompts.
    pub content_mode: String,
}

impl Default for CodexSyncPreferences {
    fn default() -> Self {
        Self {
            content_mode: "assistantVisible".to_string(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHookConfigurationResult {
    pub message: String,
    pub hooks_path: String,
    pub backup_path: Option<String>,
}

#[derive(Default)]
struct TranscriptCursor {
    offset: u64,
    remainder: String,
}

#[derive(Clone, Debug)]
struct RolloutObservation {
    modified_at: SystemTime,
    runtime: String,
    lifecycle: String,
    process_open: bool,
}

#[derive(Default)]
struct ManagerInner {
    sessions: BTreeMap<String, CodexSessionSnapshot>,
    seen_event_ids: BTreeSet<String>,
    transcript_cursors: HashMap<String, TranscriptCursor>,
    rollout_observations: HashMap<String, RolloutObservation>,
    rollout_process_probe_at: Option<Instant>,
    open_rollout_paths: Option<HashSet<PathBuf>>,
    pending_events: VecDeque<CodexEventEnvelope>,
    journal_offset: u64,
    journal_remainder: String,
}

#[derive(Clone)]
pub struct CodexSessionManager {
    inner: std::sync::Arc<Mutex<ManagerInner>>,
}

impl CodexSessionManager {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Arc::new(Mutex::new(ManagerInner::default())),
        }
    }

    pub fn drain(&self) -> Result<Vec<CodexEventEnvelope>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Codex session state lock is unavailable".to_string())?;
        let mut incoming = read_journal_events(&mut inner)?;
        // Managed App Server notifications are ingested on their reader thread.
        // Drain that outbox first so the Tauri event bridge can forward deltas
        // to React instead of leaving them stranded in the native snapshot.
        let mut delivered = inner.pending_events.drain(..).collect::<Vec<_>>();
        let preferences = sync_preferences();
        for mut event in incoming.drain(..) {
            if !apply_content_policy(&mut event, &preferences) {
                continue;
            }
            if !inner.seen_event_ids.insert(event.event_id.clone()) {
                continue;
            }
            apply_event(&mut inner, &event);
            delivered.push(event);
        }
        let inventory_events = discover_local_rollout_events(&mut inner);
        for mut event in inventory_events {
            if !apply_content_policy(&mut event, &preferences) {
                continue;
            }
            if !inner.seen_event_ids.insert(event.event_id.clone()) {
                continue;
            }
            apply_event(&mut inner, &event);
            delivered.push(event);
        }
        let transcript_events = collect_transcript_events(&mut inner);
        for mut event in transcript_events {
            if !apply_content_policy(&mut event, &preferences) {
                continue;
            }
            if !inner.seen_event_ids.insert(event.event_id.clone()) {
                continue;
            }
            apply_event(&mut inner, &event);
            delivered.push(event);
        }
        if inner.seen_event_ids.len() > 16_000 {
            let retained = inner
                .seen_event_ids
                .iter()
                .rev()
                .take(8_000)
                .cloned()
                .collect::<BTreeSet<_>>();
            inner.seen_event_ids = retained;
        }
        Ok(delivered)
    }

    pub fn snapshot(&self) -> Result<Vec<CodexSessionSnapshot>, String> {
        let _ = self.drain()?;
        let inner = self
            .inner
            .lock()
            .map_err(|_| "Codex session state lock is unavailable".to_string())?;
        Ok(inner.sessions.values().cloned().collect())
    }

    pub fn ingest_external(
        &self,
        events: Vec<CodexEventEnvelope>,
    ) -> Result<Vec<CodexEventEnvelope>, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Codex session state lock is unavailable".to_string())?;
        let mut delivered = Vec::new();
        let preferences = sync_preferences();
        for mut event in events {
            if !apply_content_policy(&mut event, &preferences) {
                continue;
            }
            if !inner.seen_event_ids.insert(event.event_id.clone()) {
                continue;
            }
            apply_event(&mut inner, &event);
            delivered.push(event);
        }
        Ok(delivered)
    }

    fn ingest_external_queued(
        &self,
        events: Vec<CodexEventEnvelope>,
    ) -> Result<Vec<CodexEventEnvelope>, String> {
        let delivered = self.ingest_external(events)?;
        if delivered.is_empty() {
            return Ok(delivered);
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Codex session state lock is unavailable".to_string())?;
        inner.pending_events.extend(delivered.iter().cloned());
        Ok(delivered)
    }
}

pub fn start_managed_daemon() -> Result<bool, String> {
    let executable = codex_executable()
        .ok_or_else(|| "未找到可运行的 Codex CLI；请确认已完成安装。".to_string())?;
    let control_socket = codex_home().join("app-server-control/app-server-control.sock");
    if control_socket.exists() {
        app_server_request(
            "thread/list",
            json!({ "cursor": null, "limit": 1, "sortKey": "updated_at", "sortDirection": "desc" }),
        )
        .map_err(|_| "检测到 Codex App Server control socket，但它未能完成只读握手；Focus Pet 不会替换或重启该进程。".to_string())?;
        return Ok(true);
    }
    let output = codex_command(&executable)
        .args(["app-server", "daemon", "start"])
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("unable to start Codex App Server daemon: {error}"))?;
    if output.status.success() {
        Ok(true)
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if detail.contains("managed standalone Codex install not found") {
            return start_focus_pet_ephemeral_app_server();
        }
        Err(if detail.is_empty() {
            "Codex App Server daemon did not start successfully".to_string()
        } else {
            format!("Codex App Server daemon did not start successfully: {detail}")
        })
    }
}

/// Start the official App Server directly when the user has a normal Codex CLI
/// but not the separately-installed managed standalone runtime. Focus Pet owns
/// this local fallback and stops it during normal Quit actions; an existing
/// user-owned control socket is never replaced or terminated.
fn start_focus_pet_ephemeral_app_server() -> Result<bool, String> {
    let holder = FOCUS_PET_EPHEMERAL_APP_SERVER.get_or_init(|| Mutex::new(None));
    let mut child_slot = holder
        .lock()
        .map_err(|_| "Focus Pet App Server state lock is unavailable".to_string())?;
    if let Some(child) = child_slot.as_mut() {
        if child
            .try_wait()
            .map_err(|error| format!("unable to inspect Focus Pet App Server: {error}"))?
            .is_none()
        {
            return Ok(true);
        }
    }
    *child_slot = None;
    let executable = codex_executable()
        .ok_or_else(|| "未找到可运行的 Codex CLI；请确认已完成安装。".to_string())?;
    let child = codex_command(&executable)
        .args(["app-server", "--listen", "unix://"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("unable to start Focus Pet App Server: {error}"))?;
    *child_slot = Some(child);
    drop(child_slot);

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let socket = codex_home().join("app-server-control/app-server-control.sock");
        if socket.exists()
            && app_server_request(
                "thread/list",
                json!({ "cursor": null, "limit": 1, "sortKey": "updated_at", "sortDirection": "desc" }),
            )
            .is_ok()
        {
            return Ok(true);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    stop_focus_pet_ephemeral_app_server();
    Err("Focus Pet 启动的 Codex App Server 未在 5 秒内完成只读握手。".to_string())
}

/// Stop only the direct App Server process spawned by Focus Pet. This never
/// sends a daemon stop command and never affects an App Server owned by Codex,
/// ChatGPT, an IDE, or another terminal.
pub fn stop_focus_pet_ephemeral_app_server() {
    let Some(holder) = FOCUS_PET_EPHEMERAL_APP_SERVER.get() else {
        return;
    };
    let Ok(mut child_slot) = holder.lock() else {
        return;
    };
    let Some(mut child) = child_slot.take() else {
        return;
    };
    let _ = child.kill();
    let _ = child.wait();
}

/// Maintains a passive, long-lived subscription to Codex's official managed
/// App Server. It never starts/resumes a thread or sends model input: status
/// broadcasts and read-only history calls are the sole protocol operations.
/// Hook/transcript collection stays enabled as a compatibility fallback.
pub fn start_managed_event_stream(manager: CodexSessionManager) {
    if MANAGED_STREAM_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    std::thread::spawn(move || loop {
        let received_activity = run_managed_event_stream_once(&manager);
        // If the daemon has not been enabled yet, a slow retry avoids noisy
        // process churn. A live connection uses the same reconnect delay after
        // an unexpected proxy exit.
        std::thread::sleep(if received_activity {
            Duration::from_secs(2)
        } else {
            Duration::from_secs(10)
        });
    });
}

fn run_managed_event_stream_once(manager: &CodexSessionManager) -> bool {
    let Some(executable) = codex_executable() else {
        return false;
    };
    run_managed_event_stream_once_with_command(manager, &executable)
}

fn run_managed_event_stream_once_with_command(
    manager: &CodexSessionManager,
    executable: &Path,
) -> bool {
    let child = codex_command(executable)
        .args(["app-server", "proxy"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let Ok(mut child) = child else {
        return false;
    };
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    };
    let Ok((mut stdin, stdout)) =
        connect_app_server_proxy_with_timeout(&mut child, stdin, stdout, Duration::from_secs(5))
    else {
        let _ = child.kill();
        let _ = child.wait();
        return false;
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
    if send_app_server_stream_message(
        &mut stdin,
        json!({
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": { "name": "focus_pet", "title": "Focus Pet", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "experimentalApi": true }
            }
        }),
    )
    .is_err()
    {
        let _ = child.kill();
        let _ = child.wait();
        return false;
    }

    let mut initialized = false;
    let mut next_request_id = 2_u64;
    let mut pending = HashMap::<u64, ManagedStreamRequest>::new();
    let mut completion_loaded = BTreeSet::<String>::new();
    let mut last_activity = Instant::now();
    let mut received_activity = false;
    let mut next_poll_at = Instant::now();
    loop {
        if initialized && Instant::now() >= next_poll_at {
            let request_id = next_request_id;
            next_request_id = next_request_id.saturating_add(1);
            if send_app_server_stream_message(
                &mut stdin,
                json!({
                    "method": "thread/list",
                    "id": request_id,
                    "params": { "cursor": null, "limit": 100, "sortKey": "updated_at", "sortDirection": "desc" }
                }),
            )
            .is_err()
            {
                break;
            }
            pending.insert(request_id, ManagedStreamRequest::ThreadList);
            next_poll_at = Instant::now() + APP_SERVER_STREAM_POLL;
        }
        match receiver.recv_timeout(Duration::from_secs(1)) {
            Ok(line) => {
                last_activity = Instant::now();
                received_activity = true;
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("id").and_then(Value::as_u64) == Some(1) && !initialized {
                    if send_app_server_stream_message(
                        &mut stdin,
                        json!({ "method": "initialized", "params": {} }),
                    )
                    .is_err()
                    {
                        break;
                    }
                    initialized = true;
                    next_poll_at = Instant::now();
                    continue;
                }
                let request = message
                    .get("id")
                    .and_then(Value::as_u64)
                    .and_then(|id| pending.remove(&id));
                let events = managed_stream_events(&message, request.as_ref());
                let transitions = events
                    .iter()
                    .filter_map(managed_stream_runtime)
                    .collect::<Vec<_>>();
                if !events.is_empty() {
                    let _ = manager.ingest_external_queued(events);
                }
                for (thread_id, runtime) in transitions {
                    if runtime == "active" {
                        completion_loaded.remove(&thread_id);
                    } else if runtime == "idle" && completion_loaded.insert(thread_id.clone()) {
                        let request_id = next_request_id;
                        next_request_id = next_request_id.saturating_add(1);
                        if send_app_server_stream_message(
                            &mut stdin,
                            json!({
                                "method": "thread/turns/list",
                                "id": request_id,
                                "params": { "threadId": thread_id, "limit": 1, "sortDirection": "desc", "itemsView": "summary" }
                            }),
                        )
                        .is_ok()
                        {
                            pending.insert(request_id, ManagedStreamRequest::TurnsList { thread_id });
                        }
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout)
                if Instant::now().saturating_duration_since(last_activity)
                    >= APP_SERVER_STREAM_HEARTBEAT =>
            {
                break
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    received_activity
}

#[derive(Clone, Debug)]
enum ManagedStreamRequest {
    ThreadList,
    TurnsList { thread_id: String },
}

fn send_app_server_stream_message(
    stdin: &mut std::process::ChildStdin,
    message: Value,
) -> Result<(), String> {
    send_app_server_proxy_message(stdin, message)
}

fn managed_stream_events(
    message: &Value,
    request: Option<&ManagedStreamRequest>,
) -> Vec<CodexEventEnvelope> {
    if message.get("method").and_then(Value::as_str) == Some("thread/status/changed") {
        let params = message.get("params").unwrap_or(&Value::Null);
        return params
            .get("threadId")
            .and_then(Value::as_str)
            .zip(params.get("status"))
            .and_then(|(id, status)| {
                managed_status_event_from_thread(&json!({ "id": id, "status": status }))
            })
            .into_iter()
            .collect();
    }
    if message.get("method").and_then(Value::as_str) == Some("item/agentMessage/delta") {
        return managed_agent_message_delta_event(message.get("params").unwrap_or(&Value::Null))
            .into_iter()
            .collect();
    }
    if let Some(ManagedStreamRequest::TurnsList { thread_id }) = request {
        return managed_completion_events(thread_id, message);
    }
    message
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(managed_status_event_from_thread)
        .collect()
}

/// The official App Server emits only assistant-visible deltas here. This is
/// deliberately the sole streaming content path: user prompts, reasoning,
/// tool calls and terminal output are never projected into Focus Pet.
fn managed_agent_message_delta_event(params: &Value) -> Option<CodexEventEnvelope> {
    let thread_id = params.get("threadId")?.as_str()?;
    let turn_id = params.get("turnId")?.as_str()?;
    let item_id = params.get("itemId")?.as_str()?;
    let delta = params.get("delta")?.as_str()?;
    (!delta.is_empty()).then_some(())?;
    let sequence = MANAGED_STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = chrono::Utc::now().to_rfc3339();
    Some(CodexEventEnvelope {
        schema_version: 1,
        event_id: format!("local:appserver:{thread_id}:{item_id}:delta:{sequence}"),
        sequence,
        host_id: "local".to_string(),
        session_id: thread_id.to_string(),
        thread_id: Some(thread_id.to_string()),
        turn_id: Some(turn_id.to_string()),
        occurred_at: now.clone(),
        received_at: now,
        kind: "message.updated".to_string(),
        source: "appServer".to_string(),
        confidence: "exact".to_string(),
        payload: json!({
            "itemId": item_id,
            "role": "assistant",
            "phase": "streaming",
            "text": delta,
            "isDelta": true,
            "isFinal": false,
        }),
    })
}

fn managed_status_event_from_thread(thread: &Value) -> Option<CodexEventEnvelope> {
    let id = thread.get("id")?.as_str()?;
    let status = thread.get("status")?;
    let runtime = status.get("type")?.as_str()?;
    (runtime != "notLoaded").then_some(())?;
    let active_flags = status
        .get("activeFlags")
        .and_then(Value::as_array)
        .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let sequence = MANAGED_STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let now = chrono::Utc::now().to_rfc3339();
    Some(CodexEventEnvelope {
        schema_version: 1,
        event_id: format!("local:appserver:{id}:{sequence}"),
        sequence,
        host_id: "local".to_string(),
        session_id: id.to_string(),
        thread_id: Some(id.to_string()),
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

fn managed_stream_runtime(event: &CodexEventEnvelope) -> Option<(String, String)> {
    (event.kind == "turn.statusChanged")
        .then(|| event.payload.get("runtime").and_then(Value::as_str))
        .flatten()
        .map(|runtime| (event.session_id.clone(), runtime.to_string()))
}

fn managed_completion_events(thread_id: &str, message: &Value) -> Vec<CodexEventEnvelope> {
    let now = chrono::Utc::now().to_rfc3339();
    message
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            let turn_id = turn.get("id").and_then(Value::as_str);
            let occurred_at = now.clone();
            turn.get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(move |item| {
                    (item.get("type").and_then(Value::as_str) == Some("agentMessage")).then_some(item)?;
                    let text = item.get("text").and_then(Value::as_str)?.trim();
                    (!text.is_empty()).then_some(())?;
                    let item_id = item.get("id").and_then(Value::as_str).unwrap_or("agent-message");
                    let sequence = MANAGED_STREAM_SEQUENCE.fetch_add(1, Ordering::Relaxed);
                    Some(CodexEventEnvelope {
                        schema_version: 1,
                        event_id: format!("local:appserver:{thread_id}:{item_id}:{sequence}"),
                        sequence,
                        host_id: "local".to_string(),
                        session_id: thread_id.to_string(),
                        thread_id: Some(thread_id.to_string()),
                        turn_id: turn_id.map(ToOwned::to_owned),
                        occurred_at: occurred_at.clone(),
                        received_at: occurred_at.clone(),
                        kind: "message.updated".to_string(),
                        source: "appServer".to_string(),
                        confidence: "exact".to_string(),
                        payload: json!({ "itemId": item_id, "role": "assistant", "phase": "final_answer", "text": text, "isFinal": true }),
                    })
                })
        })
        .collect()
}

pub fn managed_status_events() -> Result<Vec<CodexEventEnvelope>, String> {
    let result = app_server_request(
        "thread/list",
        json!({
            "cursor": null,
            "limit": 100,
            "sortKey": "updated_at",
            "sortDirection": "desc",
        }),
    )?;
    managed_status_events_from_thread_list(&result)
}

fn managed_status_events_from_thread_list(
    result: &Value,
) -> Result<Vec<CodexEventEnvelope>, String> {
    let data = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "App Server returned no thread list".to_string())?;
    let received_at = chrono::Utc::now().to_rfc3339();
    Ok(data
        .iter()
        .filter_map(|thread| {
            let id = thread.get("id")?.as_str()?;
            let status = thread.get("status")?;
            let runtime = status.get("type")?.as_str()?;
            // Persisted history is intentionally excluded. A notLoaded thread
            // has no trustworthy live state in this daemon instance.
            if runtime == "notLoaded" {
                return None;
            }
            let active_flags = status
                .get("activeFlags")
                .and_then(Value::as_array)
                .map(|values| values.iter().filter_map(Value::as_str).collect::<Vec<_>>())
                .unwrap_or_default();
            let cwd = thread.get("cwd").and_then(Value::as_str);
            let name = thread
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| thread.get("preview").and_then(Value::as_str));
            let mut id_hasher = std::collections::hash_map::DefaultHasher::new();
            id.hash(&mut id_hasher);
            runtime.hash(&mut id_hasher);
            active_flags.hash(&mut id_hasher);
            Some(CodexEventEnvelope {
                schema_version: 1,
                event_id: format!("appserver-{id}-{:x}", id_hasher.finish()),
                sequence: event_sequence(),
                host_id: "local".to_string(),
                session_id: id.to_string(),
                thread_id: Some(id.to_string()),
                turn_id: None,
                occurred_at: received_at.clone(),
                received_at: received_at.clone(),
                kind: "turn.statusChanged".to_string(),
                source: "appServer".to_string(),
                confidence: "exact".to_string(),
                payload: json!({
                    "runtime": runtime,
                    "activeFlags": active_flags,
                    "cwd": cwd,
                    "title": name,
                }),
            })
        })
        .collect())
}

pub fn maybe_ingest_hook_from_process_args() -> bool {
    let arguments = env::args().collect::<Vec<_>>();
    let Some(flag_index) = arguments
        .iter()
        .position(|argument| argument == "--codex-hook")
    else {
        return false;
    };
    let inline_payload = arguments
        .iter()
        .skip(flag_index + 1)
        .find(|argument| argument.trim_start().starts_with('{'))
        .cloned();
    let payload_text = inline_payload.unwrap_or_else(|| {
        let mut input = String::new();
        let _ = std::io::stdin().read_to_string(&mut input);
        input
    });
    match ingest_hook_payload(&payload_text) {
        Ok(event) => {
            eprintln!(
                "Focus Pet received Codex {} for {}",
                event.kind, event.session_id
            );
        }
        Err(error) => {
            eprintln!("Focus Pet Codex hook failed: {error}");
        }
    }
    true
}

pub fn ingest_hook_payload(payload_text: &str) -> Result<CodexEventEnvelope, String> {
    let mut event = parse_hook_payload(payload_text)?;
    let _ = apply_content_policy(&mut event, &sync_preferences());
    append_journal_event(&event)?;
    Ok(event)
}

fn parse_hook_payload(payload_text: &str) -> Result<CodexEventEnvelope, String> {
    let payload = serde_json::from_str::<Value>(payload_text.trim())
        .map_err(|error| format!("invalid Codex hook JSON: {error}"))?;
    let hook_name = field_text(&payload, &["hook_event_name", "hookEventName"])
        .ok_or_else(|| "Codex hook payload has no hook_event_name".to_string())?;
    let session_id = field_text(&payload, &["session_id", "sessionId"])
        .ok_or_else(|| "Codex hook payload has no session_id".to_string())?;
    let turn_id = field_text(&payload, &["turn_id", "turnId"]);
    let kind = match hook_name.as_str() {
        "SessionStart" => "session.started",
        "UserPromptSubmit" => "turn.started",
        "Stop" => "turn.completed",
        "SessionEnd" => "session.ended",
        other => return Err(format!("unsupported Codex hook event: {other}")),
    };
    let occurred_at = chrono::Utc::now().to_rfc3339();
    let mut safe_payload = serde_json::Map::new();
    for (source, target) in [
        ("transcript_path", "transcriptPath"),
        ("transcriptPath", "transcriptPath"),
        ("cwd", "cwd"),
        ("model", "model"),
        ("source", "sessionSource"),
        ("reason", "reason"),
    ] {
        if let Some(value) = payload
            .get(source)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            safe_payload.insert(target.to_string(), Value::String(value.to_string()));
        }
    }
    if let Some(message) = field_text(
        &payload,
        &["last_assistant_message", "lastAssistantMessage"],
    ) {
        safe_payload.insert(
            "lastAssistantMessage".to_string(),
            Value::String(compact_visible_text(&message)),
        );
    }
    // User prompts deliberately never enter the Focus Pet event journal. The
    // optional conversation setting can be implemented independently without
    // changing the lifecycle collector's privacy guarantees.
    let sequence = event_sequence();
    let event = CodexEventEnvelope {
        schema_version: 1,
        event_id: format!("hook-{}-{}-{}", session_id, hook_name, sequence),
        sequence,
        host_id: "local".to_string(),
        session_id,
        thread_id: None,
        turn_id,
        occurred_at: occurred_at.clone(),
        received_at: occurred_at,
        kind: kind.to_string(),
        source: "hook".to_string(),
        confidence: "exact".to_string(),
        payload: Value::Object(safe_payload),
    };
    Ok(event)
}

pub fn integration_status() -> CodexIntegrationStatus {
    let home = codex_home();
    let hooks_path = home.join("hooks.json");
    let config_path = home.join("config.toml");
    let has_inline_hooks = config_has_inline_hooks(&config_path);
    let focus_pet_hooks_installed = hooks_file_has_focus_pet_handlers(&hooks_path);
    let control_socket = home.join("app-server-control/app-server-control.sock");
    let standalone = home.join("packages/standalone/current/codex");
    let (managed_daemon_status, managed_daemon_message) = if control_socket.exists() {
        (
            "running".to_string(),
            "检测到官方 App Server control socket；可连接精确状态观察器。".to_string(),
        )
    } else if standalone.is_file() {
        (
            "available".to_string(),
            "已检测到官方 standalone runtime；启用后会启动受管 App Server。".to_string(),
        )
    } else if codex_cli_is_available() {
        (
            "ephemeralAvailable".to_string(),
            "已检测到 Codex CLI；启用后 Focus Pet 会启动官方 App Server，并在应用退出时仅关闭自己启动的进程。安装 standalone runtime 后可改用持久 daemon。".to_string(),
        )
    } else {
        (
            "unavailable".to_string(),
            "未检测到可运行的 Codex CLI；请先安装或将 codex 加入 PATH。".to_string(),
        )
    };
    CodexIntegrationStatus {
        journal_path: journal_path().to_string_lossy().to_string(),
        hooks_path: hooks_path.to_string_lossy().to_string(),
        codex_config_path: config_path.to_string_lossy().to_string(),
        hook_command: hook_command(),
        hook_file_exists: hooks_path.is_file(),
        has_inline_hooks,
        mode: if focus_pet_hooks_installed {
            "configured".to_string()
        } else {
            "notConfigured".to_string()
        },
        content_mode: sync_preferences().content_mode,
        managed_daemon_status,
        managed_daemon_message,
    }
}

fn codex_cli_is_available() -> bool {
    codex_executable().is_some()
}

/// GUI apps launched by Finder/Dock do not inherit the user's interactive
/// shell PATH. Resolve the same common installation locations that the SSH
/// diagnostic uses, then prepend the executable directory so a Node-based
/// launcher can also find `node`.
fn codex_executable() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("codex")];
    if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        candidates.extend([
            home.join(".local/bin/codex"),
            home.join(".npm-global/bin/codex"),
            home.join(".volta/bin/codex"),
            home.join(".asdf/shims/codex"),
        ]);
        if let Ok(versions) = fs::read_dir(home.join(".nvm/versions/node")) {
            for version in versions.flatten() {
                candidates.push(version.path().join("bin/codex"));
            }
        }
    }
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/usr/bin/codex"),
    ]);
    candidates.into_iter().find(|candidate| {
        codex_command(candidate)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    })
}

fn codex_command(executable: &Path) -> Command {
    let mut command = Command::new(executable);
    let executable_dir = executable
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let inherited = env::var_os("PATH").unwrap_or_default();
    let mut search_paths = env::split_paths(&inherited).collect::<Vec<_>>();
    search_paths.insert(0, executable_dir.to_path_buf());
    for fallback in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let fallback = PathBuf::from(fallback);
        if !search_paths.iter().any(|path| path == &fallback) {
            search_paths.push(fallback);
        }
    }
    if let Ok(path) = env::join_paths(search_paths) {
        command.env("PATH", path);
    }
    command
}

pub fn sync_preferences() -> CodexSyncPreferences {
    // The settings UI intentionally exposes a single safe mode: assistant
    // visible output. Ignore the removed `statusOnly` preference left by old
    // builds, otherwise an invisible legacy setting silently blanks every
    // Codex session summary after upgrade.
    CodexSyncPreferences::default()
}

pub fn set_sync_preferences(
    preferences: CodexSyncPreferences,
) -> Result<CodexSyncPreferences, String> {
    if preferences.content_mode != "assistantVisible" {
        return Err("Codex 内容模式固定为 assistantVisible。".to_string());
    }
    write_json_atomically(
        &preferences_path(),
        &serde_json::to_value(&preferences).map_err(|error| error.to_string())?,
    )?;
    Ok(preferences)
}

pub fn install_hooks() -> Result<CodexHookConfigurationResult, String> {
    install_hooks_with_command(hook_command())
}

fn install_hooks_with_command(command: String) -> Result<CodexHookConfigurationResult, String> {
    let home = codex_home();
    let hooks_path = home.join("hooks.json");
    let config_path = home.join("config.toml");
    if config_has_inline_hooks(&config_path) {
        return Err("检测到 ~/.codex/config.toml 内联 [hooks] 配置。为避免 Codex 重复加载 Hook，Focus Pet 不会同时创建 hooks.json；请在现有 hooks 配置中添加设置页给出的命令。".to_string());
    }
    fs::create_dir_all(&home).map_err(|error| error.to_string())?;
    let mut root = if hooks_path.exists() {
        let text = fs::read_to_string(&hooks_path).map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&text)
            .map_err(|error| format!("无法解析现有 hooks.json：{error}"))?
    } else {
        json!({ "description": "Focus Pet Codex lifecycle integration", "hooks": {} })
    };
    let root_object = root
        .as_object_mut()
        .ok_or_else(|| "hooks.json 根节点必须是 JSON object".to_string())?;
    let hooks = root_object
        .entry("hooks".to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()))
        .as_object_mut()
        .ok_or_else(|| "hooks.json 的 hooks 字段必须是 object".to_string())?;
    let event_names = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];
    if focus_pet_hooks_are_installed(hooks) {
        return Ok(CodexHookConfigurationResult {
            message: "Focus Pet 的 Codex Hook 已安装；未修改现有配置。".to_string(),
            hooks_path: hooks_path.to_string_lossy().to_string(),
            backup_path: None,
        });
    }
    for event_name in event_names {
        let groups = hooks
            .entry(event_name.to_string())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or_else(|| format!("hooks.{event_name} 必须是 array"))?;
        let already_installed = groups.iter().any(|group| {
            group
                .get("hooks")
                .and_then(Value::as_array)
                .map(|handlers| handlers.iter().any(is_focus_pet_handler))
                .unwrap_or(false)
        });
        if !already_installed {
            groups.push(json!({
                "hooks": [{
                    "type": "command",
                    "command": command,
                    "timeout": if event_name == "SessionEnd" { 3 } else { 1 },
                    "statusMessage": "Focus Pet session sync"
                }]
            }));
        }
    }
    let backup_path = if hooks_path.exists() {
        Some(backup_file(&hooks_path)?)
    } else {
        None
    };
    write_json_atomically(&hooks_path, &root)?;
    Ok(CodexHookConfigurationResult {
        message: "Focus Pet 已写入 Codex 用户级 hooks.json。请在 Codex 中运行 /hooks，审查并信任 Focus Pet session sync。".to_string(),
        hooks_path: hooks_path.to_string_lossy().to_string(),
        backup_path,
    })
}

pub fn uninstall_hooks() -> Result<CodexHookConfigurationResult, String> {
    let hooks_path = codex_home().join("hooks.json");
    if !hooks_path.exists() {
        return Ok(CodexHookConfigurationResult {
            message: "没有找到 Focus Pet 管理的 hooks.json。".to_string(),
            hooks_path: hooks_path.to_string_lossy().to_string(),
            backup_path: None,
        });
    }
    let text = fs::read_to_string(&hooks_path).map_err(|error| error.to_string())?;
    let mut root = serde_json::from_str::<Value>(&text)
        .map_err(|error| format!("无法解析现有 hooks.json：{error}"))?;
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return Err("hooks.json 的 hooks 字段必须是 object".to_string());
    };
    let mut removed = false;
    for event_name in ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] {
        let Some(groups) = hooks.get_mut(event_name).and_then(Value::as_array_mut) else {
            continue;
        };
        for group in groups.iter_mut() {
            let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                continue;
            };
            let before = handlers.len();
            handlers.retain(|handler| !is_focus_pet_handler(handler));
            removed |= handlers.len() != before;
        }
        groups.retain(|group| {
            group
                .get("hooks")
                .and_then(Value::as_array)
                .map(|handlers| !handlers.is_empty())
                .unwrap_or(true)
        });
    }
    if !removed {
        return Ok(CodexHookConfigurationResult {
            message: "没有找到 Focus Pet 管理的 Hook；未修改现有配置。".to_string(),
            hooks_path: hooks_path.to_string_lossy().to_string(),
            backup_path: None,
        });
    }
    let backup_path = Some(backup_file(&hooks_path)?);
    write_json_atomically(&hooks_path, &root)?;
    Ok(CodexHookConfigurationResult {
        message: "已移除 Focus Pet 的 Codex Hook，保留其他 Hook handler。".to_string(),
        hooks_path: hooks_path.to_string_lossy().to_string(),
        backup_path,
    })
}

fn apply_event(inner: &mut ManagerInner, event: &CodexEventEnvelope) {
    let key = format!("{}:{}", event.host_id, event.session_id);
    let fallback_title = event
        .payload
        .get("cwd")
        .and_then(Value::as_str)
        .and_then(|cwd| Path::new(cwd).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Codex")
        .to_string();
    let session = inner
        .sessions
        .entry(key)
        .or_insert_with(|| CodexSessionSnapshot {
            host_id: event.host_id.clone(),
            host_kind: if event.host_id == "local" {
                "local"
            } else {
                "ssh"
            }
            .to_string(),
            session_id: event.session_id.clone(),
            thread_id: event.thread_id.clone(),
            title: fallback_title,
            cwd: None,
            lifecycle: "unknown".to_string(),
            runtime: "unknown".to_string(),
            active_flags: Vec::new(),
            current_turn: None,
            latest_visible_message: None,
            capability_mode: "legacy".to_string(),
            updated_at: event.occurred_at.clone(),
            transcript_path: None,
            status_source_priority: 0,
            status_received_at: None,
        });
    if let Some(cwd) = event
        .payload
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        session.cwd = Some(cwd.to_string());
        if let Some(name) = Path::new(cwd)
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
        {
            session.title = name.to_string();
        }
    }
    if let Some(title) = event
        .payload
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        session.title = compact_visible_text(title);
    }
    if let Some(path) = event
        .payload
        .get("transcriptPath")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        session.transcript_path = Some(path.to_string());
    }
    if event.source == "hook" || event.source == "rollout" {
        session.capability_mode = "hooks".to_string();
    }
    if let Some(thread_id) = &event.thread_id {
        session.thread_id = Some(thread_id.clone());
    }
    match event.kind.as_str() {
        "session.started" => {
            session.lifecycle = "open".to_string();
            session.runtime = "idle".to_string();
        }
        "session.ended" => {
            session.lifecycle = "closed".to_string();
            session.runtime = "idle".to_string();
            session.active_flags.clear();
        }
        "turn.started" => {
            session.lifecycle = "open".to_string();
            session.runtime = "active".to_string();
            if let Some(turn_id) = &event.turn_id {
                session.current_turn = Some(CodexTurnState {
                    turn_id: turn_id.clone(),
                    status: "inProgress".to_string(),
                    started_at: Some(event.occurred_at.clone()),
                    completed_at: None,
                    error_summary: None,
                });
            }
        }
        "turn.completed" => {
            session.lifecycle = "open".to_string();
            session.runtime = "idle".to_string();
            if let Some(turn_id) = &event.turn_id {
                session.current_turn = Some(CodexTurnState {
                    turn_id: turn_id.clone(),
                    status: "completed".to_string(),
                    started_at: session
                        .current_turn
                        .as_ref()
                        .and_then(|turn| turn.started_at.clone()),
                    completed_at: Some(event.occurred_at.clone()),
                    error_summary: None,
                });
            }
            if let Some(text) = event
                .payload
                .get("lastAssistantMessage")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                session.latest_visible_message = Some(CodexVisibleMessage {
                    item_id: None,
                    role: "assistant".to_string(),
                    phase: Some("final_answer".to_string()),
                    text: compact_visible_text(text),
                    is_final: true,
                    updated_at: event.occurred_at.clone(),
                });
            }
        }
        "turn.statusChanged" => {
            let priority = event_source_priority(&event.source);
            let higher_priority_is_stale = session
                .status_received_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .zip(chrono::DateTime::parse_from_rfc3339(&event.received_at).ok())
                .is_some_and(|(previous, incoming)| {
                    incoming.signed_duration_since(previous).num_milliseconds() >= 10_000
                });
            if priority >= session.status_source_priority || higher_priority_is_stale {
                if let Some(runtime) = event.payload.get("runtime").and_then(Value::as_str) {
                    session.runtime = runtime.to_string();
                    if runtime != "notLoaded" && session.lifecycle == "unknown" {
                        session.lifecycle = "open".to_string();
                    }
                }
                if let Some(lifecycle) = event
                    .payload
                    .get("lifecycle")
                    .and_then(Value::as_str)
                    .filter(|value| matches!(*value, "open" | "closed" | "unknown"))
                {
                    session.lifecycle = lifecycle.to_string();
                }
                if let Some(flags) = event.payload.get("activeFlags").and_then(Value::as_array) {
                    session.active_flags = flags
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect();
                }
                session.status_source_priority = priority;
                session.status_received_at = Some(event.received_at.clone());
            }
            if event.source == "appServer" {
                session.capability_mode = "managed".to_string();
            }
        }
        "message.updated" => {
            let text = event
                .payload
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !text.is_empty() {
                let item_id = event
                    .payload
                    .get("itemId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                let is_delta = event
                    .payload
                    .get("isDelta")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let previous_text = if is_delta
                    && session
                        .latest_visible_message
                        .as_ref()
                        .is_some_and(|message| message.item_id == item_id)
                {
                    session
                        .latest_visible_message
                        .as_ref()
                        .map(|message| message.text.as_str())
                        .unwrap_or_default()
                } else {
                    ""
                };
                session.latest_visible_message = Some(CodexVisibleMessage {
                    item_id,
                    role: event
                        .payload
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("assistant")
                        .to_string(),
                    phase: event
                        .payload
                        .get("phase")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    text: compact_visible_text(&format!("{previous_text}{text}")),
                    is_final: event
                        .payload
                        .get("isFinal")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    updated_at: event.occurred_at.clone(),
                });
            }
        }
        _ => {}
    }
    session.updated_at = event.occurred_at.clone();
}

fn event_source_priority(source: &str) -> u8 {
    match source {
        "appServer" => 5,
        "hook" => 4,
        "rollout" | "rolloutInventory" => 3,
        "legacyNotify" => 2,
        "processProbe" => 1,
        _ => 0,
    }
}

fn collect_transcript_events(inner: &mut ManagerInner) -> Vec<CodexEventEnvelope> {
    let watched = inner
        .sessions
        .values()
        .filter_map(|session| {
            session.transcript_path.as_ref().map(|path| {
                (
                    session.host_id.clone(),
                    session.session_id.clone(),
                    path.clone(),
                )
            })
        })
        .collect::<Vec<_>>();
    watched
        .into_iter()
        .flat_map(|(host_id, session_id, transcript_path)| {
            let cursor = inner
                .transcript_cursors
                .entry(transcript_path.clone())
                .or_default();
            tail_transcript(&host_id, &session_id, &transcript_path, cursor)
        })
        .collect()
}

/// Discover recent standard CLI rollout files without writing to `~/.codex`.
/// Hooks remain useful for older Codex versions, but they are no longer a
/// prerequisite for seeing a normal `codex` terminal session.
fn discover_local_rollout_events(inner: &mut ManagerInner) -> Vec<CodexEventEnvelope> {
    if inner
        .rollout_process_probe_at
        .map_or(true, |last| last.elapsed() >= PROCESS_PROBE_INTERVAL)
    {
        inner.open_rollout_paths = local_open_rollout_paths();
        inner.rollout_process_probe_at = Some(Instant::now());
    }
    let mut files = Vec::new();
    collect_rollout_files(&codex_home().join("sessions"), 0, &mut files);
    files.sort_by(|left, right| right.1.cmp(&left.1));
    files.truncate(MAX_DISCOVERED_ROLLOUTS);

    let now = SystemTime::now();
    let mut events = Vec::new();
    for (path, modified_at) in files {
        let Ok(age) = now.duration_since(modified_at) else {
            continue;
        };
        if age > ROLLOUT_DISCOVERY_WINDOW {
            continue;
        }
        let Some((session_id, cwd)) = rollout_descriptor(&path) else {
            continue;
        };
        let transcript_path = path.to_string_lossy().to_string();
        let key = format!("local:{session_id}");
        if !inner.sessions.contains_key(&key) {
            events.push(CodexEventEnvelope {
                schema_version: 1,
                event_id: format!("rollout-inventory:{session_id}:started"),
                sequence: event_sequence(),
                host_id: "local".to_string(),
                session_id: session_id.clone(),
                thread_id: None,
                turn_id: None,
                occurred_at: system_time_rfc3339(modified_at),
                received_at: chrono::Utc::now().to_rfc3339(),
                kind: "session.started".to_string(),
                source: "rolloutInventory".to_string(),
                confidence: "exact".to_string(),
                payload: json!({
                    "cwd": cwd,
                    "transcriptPath": transcript_path,
                    "title": "Codex CLI",
                }),
            });
        }
        let process_open = inner
            .open_rollout_paths
            .as_ref()
            .is_some_and(|paths| paths.contains(&path));
        let previous = inner.rollout_observations.get(&key);
        let (runtime, lifecycle) = if previous.is_some_and(|observation| {
            observation.modified_at == modified_at && observation.process_open == process_open
        }) {
            let observation = previous.expect("checked observation");
            (observation.runtime.clone(), observation.lifecycle.clone())
        } else {
            let runtime = if process_open {
                rollout_turn_runtime(&path)
            } else {
                "idle".to_string()
            };
            let lifecycle = if inner.open_rollout_paths.is_none() {
                "unknown"
            } else if process_open {
                "open"
            } else {
                "closed"
            };
            (runtime, lifecycle.to_string())
        };
        let changed = inner
            .rollout_observations
            .get(&key)
            .map(|observation| {
                observation.modified_at != modified_at
                    || observation.runtime != runtime
                    || observation.lifecycle != lifecycle
                    || observation.process_open != process_open
            })
            .unwrap_or(true);
        if changed {
            inner.rollout_observations.insert(
                key,
                RolloutObservation {
                    modified_at,
                    runtime: runtime.clone(),
                    lifecycle: lifecycle.clone(),
                    process_open,
                },
            );
            events.push(CodexEventEnvelope {
                schema_version: 1,
                event_id: format!(
                    "rollout-inventory:{session_id}:{}:{}:{}",
                    runtime,
                    lifecycle,
                    system_time_key(modified_at)
                ),
                sequence: event_sequence(),
                host_id: "local".to_string(),
                session_id,
                thread_id: None,
                turn_id: None,
                occurred_at: system_time_rfc3339(modified_at),
                received_at: chrono::Utc::now().to_rfc3339(),
                kind: "turn.statusChanged".to_string(),
                source: if inner.open_rollout_paths.is_some() {
                    "processProbe"
                } else {
                    "rolloutInventory"
                }
                .to_string(),
                confidence: if inner.open_rollout_paths.is_some() {
                    "exact"
                } else {
                    "observed"
                }
                .to_string(),
                payload: json!({
                    "runtime": if inner.open_rollout_paths.is_some() { Value::String(runtime) } else { Value::String("unknown".to_string()) },
                    "lifecycle": lifecycle,
                    "activeFlags": []
                }),
            });
        }
    }
    events
}

fn rollout_turn_runtime(path: &Path) -> String {
    const TAIL_BYTES: u64 = 256 * 1024;
    let Ok(mut file) = File::open(path) else {
        return "idle".to_string();
    };
    let length = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
    if length > TAIL_BYTES {
        let _ = file.seek(SeekFrom::Start(length - TAIL_BYTES));
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return "idle".to_string();
    }
    for line in String::from_utf8_lossy(&bytes).lines().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("event_msg") {
            continue;
        }
        match record
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str)
        {
            Some("task_started") => return "active".to_string(),
            Some("task_complete" | "turn_aborted") => return "idle".to_string(),
            _ => {}
        }
    }
    "idle".to_string()
}

#[cfg(target_os = "macos")]
fn local_open_rollout_paths() -> Option<HashSet<PathBuf>> {
    let output = Command::new("/usr/sbin/lsof")
        .args(["-n", "-P", "-Fn", "-c", "codex"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.strip_prefix('n'))
            .map(PathBuf::from)
            .filter(|path| {
                path.extension().and_then(|value| value.to_str()) == Some("jsonl")
                    && path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .is_some_and(|name| name.starts_with("rollout-"))
                    && path.components().any(|part| part.as_os_str() == "sessions")
            })
            .collect(),
    )
}

#[cfg(target_os = "linux")]
fn local_open_rollout_paths() -> Option<HashSet<PathBuf>> {
    let mut paths = HashSet::new();
    let processes = fs::read_dir("/proc").ok()?;
    for process in processes.flatten() {
        if !process
            .file_name()
            .to_string_lossy()
            .chars()
            .all(|character| character.is_ascii_digit())
        {
            continue;
        }
        let command = fs::read(process.path().join("cmdline")).unwrap_or_default();
        if !String::from_utf8_lossy(&command).contains("codex") {
            continue;
        }
        let Ok(descriptors) = fs::read_dir(process.path().join("fd")) else {
            continue;
        };
        for descriptor in descriptors.flatten() {
            let Ok(path) = fs::read_link(descriptor.path()) else {
                continue;
            };
            if path.extension().and_then(|value| value.to_str()) == Some("jsonl")
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with("rollout-"))
                && path.components().any(|part| part.as_os_str() == "sessions")
            {
                paths.insert(path);
            }
        }
    }
    Some(paths)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn local_open_rollout_paths() -> Option<HashSet<PathBuf>> {
    None
}

fn collect_rollout_files(root: &Path, depth: usize, files: &mut Vec<(PathBuf, SystemTime)>) {
    if depth > 5 || files.len() >= MAX_DISCOVERED_ROLLOUTS.saturating_mul(4) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_rollout_files(&path, depth.saturating_add(1), files);
            continue;
        }
        if !file_type.is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("jsonl")
            || !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-"))
        {
            continue;
        }
        if let Ok(modified_at) = entry.metadata().and_then(|metadata| metadata.modified()) {
            files.push((path, modified_at));
        }
    }
}

fn rollout_descriptor(path: &Path) -> Option<(String, Option<String>)> {
    let mut file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(64 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    let rollout_name = path.file_stem()?.to_str()?.strip_prefix("rollout-")?;
    let fallback_id = rollout_name
        .get(rollout_name.len().saturating_sub(36)..)
        .filter(|value| !value.is_empty())
        .unwrap_or(rollout_name)
        .to_string();
    for line in String::from_utf8_lossy(&bytes).lines() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let payload = record.get("payload").unwrap_or(&Value::Null);
        let session_id = payload
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or(&fallback_id)
            .to_string();
        let cwd = payload
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        return Some((session_id, cwd));
    }
    Some((fallback_id, None))
}

fn system_time_key(value: SystemTime) -> u128 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn system_time_rfc3339(value: SystemTime) -> String {
    let seconds = value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_else(|_| chrono::Utc::now().timestamp());
    chrono::DateTime::<chrono::Utc>::from_timestamp(seconds, 0)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339()
}

fn tail_transcript(
    host_id: &str,
    session_id: &str,
    transcript_path: &str,
    cursor: &mut TranscriptCursor,
) -> Vec<CodexEventEnvelope> {
    let path = Path::new(transcript_path);
    let Ok(metadata) = fs::metadata(path) else {
        return Vec::new();
    };
    if metadata.len() < cursor.offset {
        cursor.offset = 0;
        cursor.remainder.clear();
    }
    let start = if cursor.offset == 0 && metadata.len() > MAX_TRANSCRIPT_READ_BYTES {
        metadata.len() - MAX_TRANSCRIPT_READ_BYTES
    } else {
        cursor.offset
    };
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    cursor.offset = metadata.len();
    let text = String::from_utf8_lossy(&bytes);
    let mut combined = String::new();
    if start == 0 {
        combined.push_str(&cursor.remainder);
    }
    combined.push_str(&text);
    let complete_line_count = combined.matches('\n').count();
    let mut lines = combined
        .lines()
        .take(complete_line_count)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    cursor.remainder = if combined.ends_with('\n') {
        String::new()
    } else {
        combined
            .rsplit_once('\n')
            .map(|(_, tail)| tail.to_string())
            .unwrap_or(combined)
    };
    if start > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    lines
        .into_iter()
        .filter_map(|line| transcript_message_event(host_id, session_id, &line))
        .collect()
}

fn app_server_request(method: &str, params: Value) -> Result<Value, String> {
    let executable = codex_executable()
        .ok_or_else(|| "未找到可运行的 Codex CLI；请确认已完成安装。".to_string())?;
    let mut child = codex_command(&executable)
        .args(["app-server", "proxy"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("unable to launch Codex App Server proxy: {error}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex App Server proxy stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex App Server proxy stdout is unavailable".to_string())?;
    let (mut stdin, stdout) = connect_app_server_proxy(stdin, stdout)?;
    let (sender, receiver) = mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let mut reader = stdout;
        loop {
            match read_app_server_proxy_message(&mut reader) {
                Ok(Some(line)) => {
                    if sender.send(Ok(line)).is_err() {
                        return;
                    }
                }
                Ok(None) => return,
                Err(error) => {
                    let _ = sender.send(Err(error));
                    return;
                }
            }
        }
    });
    let send = |message: Value, input: &mut std::process::ChildStdin| -> Result<(), String> {
        send_app_server_proxy_message(input, message)
    };
    let outcome = (|| {
        send(
            json!({
                "method": "initialize",
                "id": 1,
                "params": {
                    "clientInfo": {
                        "name": "focus_pet",
                        "title": "Focus Pet",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "capabilities": {
                        "optOutNotificationMethods": [
                            "turn/started",
                            "turn/completed",
                            "item/started",
                            "item/completed",
                            "item/agentMessage/delta"
                        ]
                    }
                }
            }),
            &mut stdin,
        )?;
        wait_for_response(&receiver, 1)?;
        send(json!({ "method": "initialized", "params": {} }), &mut stdin)?;
        send(
            json!({ "method": method, "id": 2, "params": params }),
            &mut stdin,
        )?;
        wait_for_response(&receiver, 2)
    })();
    let _ = child.kill();
    let _ = child.wait();
    outcome
}

fn wait_for_response(
    receiver: &mpsc::Receiver<Result<String, String>>,
    expected_id: u64,
) -> Result<Value, String> {
    for _ in 0..64 {
        let line = receiver
            .recv_timeout(Duration::from_secs(3))
            .map_err(|_| "Codex App Server proxy timed out".to_string())??;
        let message = serde_json::from_str::<Value>(&line)
            .map_err(|error| format!("invalid App Server JSON-RPC response: {error}"))?;
        if message.get("id").and_then(Value::as_u64) != Some(expected_id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(format!("Codex App Server error: {error}"));
        }
        return message
            .get("result")
            .cloned()
            .ok_or_else(|| "Codex App Server response has no result".to_string());
    }
    Err("Codex App Server did not return the expected response".to_string())
}

fn transcript_message_event(
    host_id: &str,
    session_id: &str,
    line: &str,
) -> Option<CodexEventEnvelope> {
    let record = serde_json::from_str::<Value>(line).ok()?;
    let payload = record.get("payload")?;
    let record_type = record.get("type")?.as_str()?;
    let (item_id, text, phase) = if record_type == "event_msg"
        && payload.get("type").and_then(Value::as_str) == Some("agent_message")
    {
        (
            format!(
                "event-{}",
                record
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or("message")
            ),
            payload.get("message").and_then(Value::as_str)?.to_string(),
            payload
                .get("phase")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
        )
    } else if record_type == "response_item"
        && payload.get("type")?.as_str()? == "message"
        && payload.get("role")?.as_str()? == "assistant"
    {
        (
            payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("message")
                .to_string(),
            payload
                .get("content")?
                .as_array()?
                .iter()
                .filter(|content| {
                    content.get("type").and_then(Value::as_str) == Some("output_text")
                })
                .filter_map(|content| content.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            None,
        )
    } else {
        return None;
    };
    let text = compact_visible_text(&text);
    if text.is_empty() {
        return None;
    }
    let occurred_at = record
        .get("timestamp")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    item_id.hash(&mut hasher);
    Some(CodexEventEnvelope {
        schema_version: 1,
        event_id: format!("rollout-{session_id}-{item_id}-{:x}", hasher.finish()),
        sequence: event_sequence(),
        host_id: host_id.to_string(),
        session_id: session_id.to_string(),
        thread_id: None,
        turn_id: None,
        occurred_at: occurred_at.clone(),
        received_at: chrono::Utc::now().to_rfc3339(),
        kind: "message.updated".to_string(),
        source: "rollout".to_string(),
        confidence: "exact".to_string(),
        payload: json!({
            "itemId": item_id,
            "role": "assistant",
            "phase": phase,
            "text": text,
            "isFinal": true,
        }),
    })
}

fn read_journal_events(inner: &mut ManagerInner) -> Result<Vec<CodexEventEnvelope>, String> {
    let root = app_data_root();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join(JOURNAL_FILE);
    let Ok(metadata) = fs::metadata(&path) else {
        return Ok(Vec::new());
    };
    if metadata.len() < inner.journal_offset {
        inner.journal_offset = 0;
        inner.journal_remainder.clear();
    }
    let mut file = File::open(&path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(inner.journal_offset))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    inner.journal_offset = metadata.len();
    let mut combined = std::mem::take(&mut inner.journal_remainder);
    combined.push_str(&String::from_utf8_lossy(&bytes));
    let complete_line_count = combined.matches('\n').count();
    let events = combined
        .lines()
        .take(complete_line_count)
        .filter_map(|line| serde_json::from_str::<CodexEventEnvelope>(line).ok())
        .collect::<Vec<_>>();
    inner.journal_remainder = if combined.ends_with('\n') {
        String::new()
    } else {
        combined
            .rsplit_once('\n')
            .map(|(_, tail)| tail.to_string())
            .unwrap_or(combined)
    };
    Ok(events)
}

fn append_journal_event(event: &CodexEventEnvelope) -> Result<(), String> {
    let root = app_data_root();
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join(JOURNAL_FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let line = serde_json::to_string(event).map_err(|error| error.to_string())?;
    writeln!(file, "{line}").map_err(|error| error.to_string())?;
    file.sync_data().map_err(|error| error.to_string())?;
    set_private_file_permissions(&path);
    prune_journal_if_oversized(&path)?;
    Ok(())
}

/// Keep the local and remote replay journals bounded. Retention uses complete
/// JSONL records and keeps the newest records, so a reconnect can continue
/// from its durable cursor without replaying a malformed partial line.
fn prune_journal_if_oversized(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() <= MAX_JOURNAL_BYTES {
        return Ok(());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let output = retained_journal_bytes(&contents, MAX_JOURNAL_BYTES as usize);
    write_bytes_atomically(path, &output)
}

fn retained_journal_bytes(contents: &str, max_bytes: usize) -> Vec<u8> {
    let mut retained = Vec::new();
    let mut total_bytes = 0usize;
    for line in contents.lines().rev() {
        let line_bytes = line.len().saturating_add(1);
        if total_bytes.saturating_add(line_bytes) > max_bytes {
            break;
        }
        if serde_json::from_str::<CodexEventEnvelope>(line).is_ok() {
            retained.push(line);
            total_bytes = total_bytes.saturating_add(line_bytes);
        }
    }
    retained.reverse();
    let mut output = retained.join("\n");
    if !output.is_empty() {
        output.push('\n');
    }
    output.into_bytes()
}

fn event_sequence() -> u64 {
    let micros = chrono::Utc::now().timestamp_micros().max(0) as u64;
    micros
        .saturating_mul(1_000)
        .saturating_add((std::process::id() % 1_000) as u64)
}

fn field_text(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    })
}

fn compact_visible_text(value: &str) -> String {
    let normalized = value.replace('\0', "").trim().to_string();
    if normalized.chars().count() <= MAX_VISIBLE_MESSAGE_CHARS {
        return normalized;
    }
    let mut compact = normalized
        .chars()
        .take(MAX_VISIBLE_MESSAGE_CHARS.saturating_sub(1))
        .collect::<String>();
    compact.push('…');
    compact
}

/// Enforce the data-minimization setting before an event reaches the durable
/// journal, session reducer, or webview. Lifecycle state is retained.
fn apply_content_policy(
    event: &mut CodexEventEnvelope,
    preferences: &CodexSyncPreferences,
) -> bool {
    if preferences.content_mode != "statusOnly" {
        return true;
    }
    if event.kind == "message.updated" {
        return false;
    }
    if let Some(payload) = event.payload.as_object_mut() {
        payload.remove("lastAssistantMessage");
        payload.remove("text");
    }
    true
}

fn config_has_inline_hooks(config_path: &Path) -> bool {
    fs::read_to_string(config_path)
        .map(|contents| {
            contents.lines().any(|line| {
                let trimmed = line.trim_start();
                trimmed == "[hooks]" || trimmed.starts_with("[[hooks.")
            })
        })
        .unwrap_or(false)
}

fn is_focus_pet_handler(handler: &Value) -> bool {
    handler
        .get("command")
        .and_then(Value::as_str)
        .map(|command| {
            command.contains("--codex-hook") && command.to_ascii_lowercase().contains("focus")
        })
        .unwrap_or(false)
        || handler
            .get("statusMessage")
            .and_then(Value::as_str)
            .map(|message| message == "Focus Pet session sync")
            .unwrap_or(false)
}

fn focus_pet_hooks_are_installed(hooks: &serde_json::Map<String, Value>) -> bool {
    ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]
        .iter()
        .all(|event_name| {
            hooks
                .get(*event_name)
                .and_then(Value::as_array)
                .map(|groups| {
                    groups.iter().any(|group| {
                        group
                            .get("hooks")
                            .and_then(Value::as_array)
                            .map(|handlers| handlers.iter().any(is_focus_pet_handler))
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false)
        })
}

fn hooks_file_has_focus_pet_handlers(path: &Path) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str::<Value>(&contents).ok())
        .and_then(|root| root.get("hooks").and_then(Value::as_object).cloned())
        .map(|hooks| focus_pet_hooks_are_installed(&hooks))
        .unwrap_or(false)
}

fn backup_file(path: &Path) -> Result<String, String> {
    let backup = path.with_extension(format!(
        "json.focus-pet-backup-{}",
        chrono::Utc::now().timestamp_micros()
    ));
    fs::copy(path, &backup).map_err(|error| error.to_string())?;
    set_private_file_permissions(&backup);
    Ok(backup.to_string_lossy().to_string())
}

fn write_json_atomically(path: &Path, value: &Value) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let mut output = serialized;
    output.push(b'\n');
    write_bytes_atomically(path, &output)
}

fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "configuration path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".focus-pet-{}-{}.tmp",
        std::process::id(),
        event_sequence()
    ));
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
    }
    set_private_file_permissions(&temporary);
    fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    set_private_file_permissions(path);
    Ok(())
}

fn app_data_root() -> PathBuf {
    if let Some(path) = env::var_os("FOCUS_PET_DATA_DIR").map(PathBuf::from) {
        return path;
    }
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support/Focus Pet")
    }
    #[cfg(target_os = "windows")]
    {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home)
            .join("Focus Pet")
    }
    #[cfg(target_os = "linux")]
    {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("Focus Pet")
    }
}

fn codex_home() -> PathBuf {
    env::var_os("FOCUS_PET_CODEX_HOME")
        .or_else(|| env::var_os("CODEX_HOME"))
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("HOME")
                .or_else(|| env::var_os("USERPROFILE"))
                .map(|home| PathBuf::from(home).join(".codex"))
        })
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn journal_path() -> PathBuf {
    app_data_root().join(JOURNAL_FILE)
}

fn preferences_path() -> PathBuf {
    app_data_root().join(PREFERENCES_FILE)
}

fn hook_command() -> String {
    let executable = env::current_exe().unwrap_or_else(|_| PathBuf::from("focus-pet"));
    let path = executable.to_string_lossy().replace('\'', "'\\\"'\\\"'");
    format!("'{path}' --codex-hook")
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::{
        apply_content_policy, compact_visible_text, focus_pet_hooks_are_installed,
        hooks_file_has_focus_pet_handlers, managed_completion_events,
        managed_status_events_from_thread_list, managed_stream_events, parse_hook_payload,
        retained_journal_bytes, rollout_descriptor, run_managed_event_stream_once_with_command,
        transcript_message_event, websocket_client_key, CodexEventEnvelope, CodexSessionManager,
        CodexSyncPreferences, APP_SERVER_STREAM_POLL,
    };
    use base64::Engine as _;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn hook_payload_preserves_lifecycle_without_storing_user_prompt() {
        let event = parse_hook_payload(r#"{"session_id":"s-1","turn_id":"t-1","hook_event_name":"UserPromptSubmit","prompt":"secret"}"#).unwrap();
        assert_eq!(event.kind, "turn.started");
        assert_eq!(event.session_id, "s-1");
        assert!(event.payload.get("prompt").is_none());
    }

    #[test]
    fn managed_observer_inventory_fallback_is_realtime_bounded() {
        assert_eq!(APP_SERVER_STREAM_POLL, std::time::Duration::from_secs(2));
    }

    #[test]
    fn status_only_remote_inventory_opens_an_active_session() {
        let manager = CodexSessionManager::new();
        manager
            .ingest_external(vec![CodexEventEnvelope {
                schema_version: 1,
                event_id: "ssh-5080-active".to_string(),
                sequence: 1,
                host_id: "ssh:5080".to_string(),
                session_id: "remote-session-1".to_string(),
                thread_id: None,
                turn_id: None,
                occurred_at: "2026-07-30T08:00:00Z".to_string(),
                received_at: "2026-07-30T08:00:00Z".to_string(),
                kind: "turn.statusChanged".to_string(),
                source: "rolloutInventory".to_string(),
                confidence: "inferred".to_string(),
                payload: serde_json::json!({ "runtime": "active", "activeFlags": [] }),
            }])
            .expect("ingest remote rollout inventory");
        let inner = manager.inner.lock().expect("lock session manager");
        let session = inner
            .sessions
            .get("ssh:5080:remote-session-1")
            .expect("remote session");
        assert_eq!(session.lifecycle, "open");
        assert_eq!(session.runtime, "active");
    }

    #[test]
    fn websocket_nonce_is_random_and_has_the_required_size() {
        let first = websocket_client_key().expect("generate first nonce");
        let second = websocket_client_key().expect("generate second nonce");
        assert_ne!(first, second);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(first)
            .expect("decode nonce");
        assert_eq!(decoded.len(), 16);
    }

    #[test]
    fn sanitized_hook_fixtures_cover_all_primary_lifecycle_payloads() {
        let started =
            parse_hook_payload(include_str!("../fixtures/codex/hook-session-start.json")).unwrap();
        assert_eq!(started.kind, "session.started");
        assert_eq!(started.payload["cwd"], "/work/fixture-project");

        let prompted =
            parse_hook_payload(include_str!("../fixtures/codex/hook-user-prompt.json")).unwrap();
        assert_eq!(prompted.kind, "turn.started");
        assert!(prompted.payload.get("prompt").is_none());

        let stopped = parse_hook_payload(include_str!("../fixtures/codex/hook-stop.json")).unwrap();
        assert_eq!(stopped.kind, "turn.completed");
        assert_eq!(
            stopped.payload["lastAssistantMessage"],
            "Fixture assistant final answer."
        );
    }

    #[test]
    fn transcript_parser_only_returns_assistant_output_text() {
        let assistant = r#"{"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"id":"item-1","type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}"#;
        let event = transcript_message_event("local", "s-1", assistant).unwrap();
        assert_eq!(event.kind, "message.updated");
        assert_eq!(event.payload["text"], "Hello");
        let reasoning = r#"{"timestamp":"2026-01-01T00:00:00Z","type":"response_item","payload":{"id":"reasoning","type":"reasoning"}}"#;
        assert!(transcript_message_event("local", "s-1", reasoning).is_none());
    }

    #[test]
    fn rollout_agent_message_is_visible_before_the_final_response_item() {
        let event = transcript_message_event(
            "local",
            "s-1",
            r#"{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"agent_message","message":"Streaming assistant text","phase":"commentary"}}"#,
        )
        .unwrap();
        assert_eq!(event.payload["role"], "assistant");
        assert_eq!(event.payload["text"], "Streaming assistant text");
        assert_eq!(event.payload["phase"], "commentary");
    }

    #[cfg(unix)]
    #[test]
    fn standard_rollout_descriptor_discovers_session_without_a_hook() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "rollout-2026-01-01T00-00-00-019fa884-01f9-7c81-b158-{unique:012x}.jsonl"
        ));
        fs::write(
            &path,
            r#"{"type":"session_meta","payload":{"id":"session-from-rollout","cwd":"/work/focus-pet"}}"#,
        )
        .expect("write rollout fixture");
        let descriptor = rollout_descriptor(&path).expect("parse rollout descriptor");
        assert_eq!(descriptor.0, "session-from-rollout");
        assert_eq!(descriptor.1.as_deref(), Some("/work/focus-pet"));
        fs::remove_file(path).expect("remove rollout fixture");
    }

    #[test]
    fn rollout_fixture_only_surfaces_assistant_visible_output() {
        let events = include_str!("../fixtures/codex/rollout-records.jsonl")
            .lines()
            .filter_map(|line| transcript_message_event("local", "fixture-session", line))
            .collect::<Vec<_>>();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["text"], "Fixture assistant output.");
    }

    #[test]
    fn app_server_fixture_ignores_not_loaded_history() {
        let result = serde_json::from_str(include_str!(
            "../fixtures/codex/app-server-thread-list.json"
        ))
        .unwrap();
        let events = managed_status_events_from_thread_list(&result).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "fixture-active");
        assert_eq!(events[0].payload["runtime"], "active");
        assert_eq!(events[0].payload["activeFlags"][0], "waitingOnApproval");
    }

    #[test]
    fn managed_app_server_history_only_projects_assistant_message() {
        let response = serde_json::json!({
            "result": { "data": [{
                "id": "turn-1",
                "items": [
                    { "id": "user-1", "type": "userMessage", "content": [{ "type": "text", "text": "private prompt" }] },
                    { "id": "tool-1", "type": "commandExecution", "command": "private command" },
                    { "id": "assistant-1", "type": "agentMessage", "text": "Visible final answer" }
                ]
            }] }
        });
        let events = managed_completion_events("thread-1", &response);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].payload["role"], "assistant");
        assert_eq!(events[0].payload["text"], "Visible final answer");
        assert!(events[0].payload.get("command").is_none());
    }

    #[test]
    fn managed_stream_projects_only_official_assistant_deltas() {
        let notification = serde_json::json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "assistant-1",
                "delta": "正在输出"
            }
        });
        let events = managed_stream_events(&notification, None);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "message.updated");
        assert_eq!(events[0].payload["role"], "assistant");
        assert_eq!(events[0].payload["text"], "正在输出");
        assert_eq!(events[0].payload["isDelta"], true);
        assert!(events[0].payload.get("prompt").is_none());
    }

    #[test]
    fn installed_hooks_are_detected_without_rewriting_existing_groups() {
        let handler = serde_json::json!({
            "type": "command",
            "command": "'/Applications/Focus Pet.app/Contents/MacOS/focus-pet' --codex-hook"
        });
        let hooks = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]
            .into_iter()
            .map(|event| {
                (
                    event.to_string(),
                    serde_json::json!([{ "hooks": [handler.clone()] }]),
                )
            })
            .collect();
        assert!(focus_pet_hooks_are_installed(&hooks));
    }

    #[cfg(unix)]
    #[test]
    fn unrelated_hooks_file_is_not_reported_as_focus_pet_configured() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("focus-pet-other-hooks-{unique}.json"));
        fs::write(
            &path,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other-tool"}]}]}}"#,
        )
        .expect("write unrelated hooks fixture");
        assert!(!hooks_file_has_focus_pet_handlers(&path));
        fs::remove_file(path).expect("remove unrelated hooks fixture");
    }

    #[cfg(unix)]
    #[test]
    fn managed_stream_performs_read_only_handshake_and_projects_final_message() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock before epoch")
            .as_nanos();
        let executable = std::env::temp_dir().join(format!("focus-pet-fake-codex-{unique}"));
        // This fake proxy acts like `codex app-server proxy`: the raw stream
        // performs a WebSocket upgrade and then exchanges JSON-RPC text
        // frames. It deliberately supports only initialize, thread/list and
        // thread/turns/list: the production observer must not send a resume,
        // turn, approval or input request for the test to reach completion.
        fs::write(
            &executable,
            r#"#!/usr/bin/env node
let buffer = Buffer.alloc(0);
let upgraded = false;
const send = (message) => {
  const payload = Buffer.from(JSON.stringify(message));
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  process.stdout.write(Buffer.concat([header, payload]));
};
const handle = (message) => {
  if (message.method === 'initialize') send({ id: 1, result: {} });
  if (message.method === 'thread/list') send({ id: 2, result: { data: [{ id: 'thread-fake', status: { type: 'idle' }, name: 'Fake thread' }] } });
  if (message.method === 'thread/turns/list') {
    send({ id: 3, result: { data: [{ id: 'turn-fake', items: [{ id: 'assistant-fake', type: 'agentMessage', text: 'Final from managed stream' }] }] } });
    // Give stdout a tick to flush the final WebSocket frame before closing.
    // An immediate exit makes the fixture race the Rust reader and tests the
    // fake process's buffering rather than the observer contract.
    setTimeout(() => process.exit(0), 20);
  }
};
const parse = () => {
  if (!upgraded) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    buffer = buffer.subarray(end + 4);
    process.stdout.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    upgraded = true;
  }
  while (buffer.length >= 2) {
    let offset = 2;
    let length = buffer[1] & 0x7f;
    if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
    if (buffer.length < offset + 4 + length) return;
    const mask = buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
    buffer = buffer.subarray(offset + 4 + length);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    handle(JSON.parse(payload.toString('utf8')));
  }
};
process.stdin.on('data', (chunk) => { buffer = Buffer.concat([buffer, chunk]); parse(); });
"#,
        )
        .expect("write fake Codex proxy");
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))
            .expect("make fake Codex proxy executable");

        let manager = CodexSessionManager::new();
        assert!(run_managed_event_stream_once_with_command(
            &manager,
            &executable
        ));
        let snapshots = manager.snapshot().expect("read managed stream snapshot");
        let session = snapshots
            .iter()
            .find(|session| session.session_id == "thread-fake")
            .expect("managed stream must create the thread snapshot");
        assert_eq!(session.runtime, "idle");
        assert_eq!(session.title, "Fake thread");
        assert_eq!(
            session
                .latest_visible_message
                .as_ref()
                .map(|message| message.text.as_str()),
            Some("Final from managed stream")
        );
        fs::remove_file(executable).expect("remove fake Codex proxy");
    }

    #[test]
    fn visible_text_is_bounded() {
        assert_eq!(compact_visible_text("  hello\0  "), "hello");
        assert!(compact_visible_text(&"x".repeat(2_100)).ends_with('…'));
    }

    #[test]
    fn status_only_policy_keeps_lifecycle_but_never_passes_assistant_text() {
        let preferences = CodexSyncPreferences {
            content_mode: "statusOnly".to_string(),
        };
        let mut completed = parse_hook_payload(r#"{"session_id":"s-1","turn_id":"t-1","hook_event_name":"Stop","last_assistant_message":"private answer"}"#).unwrap();
        assert!(apply_content_policy(&mut completed, &preferences));
        assert_eq!(completed.kind, "turn.completed");
        assert!(completed.payload.get("lastAssistantMessage").is_none());

        let mut message = transcript_message_event("local", "s-1", r#"{"type":"response_item","payload":{"id":"item","type":"message","role":"assistant","content":[{"type":"output_text","text":"private answer"}]}}"#).unwrap();
        assert!(!apply_content_policy(&mut message, &preferences));
    }

    #[test]
    fn bounded_journal_retention_keeps_newest_complete_events() {
        let first =
            parse_hook_payload(r#"{"session_id":"first","hook_event_name":"SessionStart"}"#)
                .unwrap();
        let second =
            parse_hook_payload(r#"{"session_id":"second","hook_event_name":"SessionStart"}"#)
                .unwrap();
        let first = serde_json::to_string(&first).unwrap();
        let second = serde_json::to_string(&second).unwrap();
        let contents = format!("{first}\nnot-json\n{second}\n");
        let retained = retained_journal_bytes(&contents, second.len().saturating_add(1));
        let retained = String::from_utf8(retained).unwrap();
        assert!(retained.contains("\"sessionId\":\"second\""));
        assert!(!retained.contains("\"sessionId\":\"first\""));
        assert!(!retained.contains("not-json"));
    }

    #[test]
    fn manager_starts_empty() {
        let manager = CodexSessionManager::new();
        assert!(manager.inner.lock().unwrap().sessions.is_empty());
    }
}
