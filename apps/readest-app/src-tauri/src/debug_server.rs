//! Dev-only MCP debug server, hosted *inside* the app: an HTTP server on
//! 127.0.0.1 serving both the plain JSON endpoints (/health, /state, /logs,
//! /events) and an MCP Streamable HTTP endpoint at /mcp, so any MCP client can
//! attach with just a URL and a bearer token — no per-client stdio wrapper.
//!
//! The tools are read-only state readers plus a small set of *actions* (open a
//! book, jump to a location, reload a window, screenshot it) so an AI can close
//! the edit → reload → look loop itself. Actions reach the webviews over a Tauri
//! event and report back through `debug_action_result`; screenshots are taken by
//! the platform webview (see `capture_png`). All of it is deliberately limited
//! to operations that lose nothing: no file, setting, or library mutation.
//!
//! Compiled into desktop debug builds only (`debug_assertions`), never into
//! release, and off until the user flips Developer → "MCP Debug Server" in
//! settings (persisted as `debugMcpEnabled`, re-applied from the main window at
//! boot). The bearer token is persisted in the app config dir so a client's
//! header survives app restarts.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewWindow, WindowEvent};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const DEFAULT_PORT: u16 = 9339;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const SOCKET_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
const CONSOLE_CAPACITY: usize = 1000;
const EVENT_CAPACITY: usize = 500;
const TOKEN_FILE: &str = "debug-mcp-token";
/// Event name carrying an action into a webview (listened to in
/// services/debugReport.ts). Only `[A-Za-z0-9_-/]` and `:` are legal in a Tauri
/// event name.
const ACTION_EVENT: &str = "debug://action";
/// Actions run in a webview the AI also drives by hand; a window that never
/// answers must not hang the tool call, so both waits are bounded.
const ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(10);
/// Protocol revisions this server speaks, newest first. `initialize` echoes the
/// client's own revision when it is supported, else offers the newest.
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PROTOCOL_VERSION: &str = "2025-03-26";

pub struct DebugState {
    started_at: std::time::Instant,
    // Latest JS state snapshot per window label (see services/debugReport.ts).
    snapshots: Mutex<HashMap<String, Value>>,
    console: Mutex<VecDeque<Value>>,
    events: Mutex<VecDeque<Value>>,
    event_seq: AtomicU64,
    /// Live MCP sessions (`Mcp-Session-Id` -> negotiated protocol revision).
    sessions: Mutex<HashMap<String, String>>,
    /// In-flight actions, keyed by the id sent to the webview: the frontend's
    /// report lands here (see `debug_action_result`).
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Value>>>,
    /// Set while the listener runs; the toggle command owns its lifecycle.
    control: Mutex<Control>,
}

#[derive(Default)]
struct Control {
    enabled: bool,
    port: Option<u16>,
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl DebugState {
    pub fn new() -> Self {
        Self {
            started_at: std::time::Instant::now(),
            snapshots: Mutex::new(HashMap::new()),
            console: Mutex::new(VecDeque::new()),
            events: Mutex::new(VecDeque::new()),
            event_seq: AtomicU64::new(0),
            sessions: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            control: Mutex::new(Control::default()),
        }
    }
}

fn push_capped<T>(deque: &mut VecDeque<T>, value: T, cap: usize) {
    if deque.len() >= cap {
        deque.pop_front();
    }
    deque.push_back(value);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Latest per-window state snapshot, pushed by each webview's debug reporter.
#[tauri::command]
pub fn debug_report_state(window: WebviewWindow, state: State<'_, DebugState>, payload: Value) {
    state
        .snapshots
        .lock()
        .unwrap()
        .insert(window.label().to_string(), payload);
}

/// Browser-console entries from a webview (batched and throttled in JS).
#[tauri::command]
pub fn debug_console_log(window: WebviewWindow, state: State<'_, DebugState>, entries: Vec<Value>) {
    let mut console = state.console.lock().unwrap();
    for mut entry in entries {
        if let Some(map) = entry.as_object_mut() {
            map.entry("label").or_insert_with(|| json!(window.label()));
        }
        push_capped(&mut console, entry, CONSOLE_CAPACITY);
    }
}

/// Result of an action dispatched to this webview (`ACTION_EVENT`). Returns
/// whether a caller was still waiting: a report that arrives after
/// `ACTION_TIMEOUT` is dropped, which is expected when a window is wedged.
#[tauri::command]
pub fn debug_action_result(state: State<'_, DebugState>, id: String, result: Value) -> bool {
    state
        .pending
        .lock()
        .unwrap()
        .remove(&id)
        .is_some_and(|reply| reply.send(result).is_ok())
}

/// Start/stop the listener at runtime. The frontend calls this once per boot
/// with the persisted `debugMcpEnabled`, then on every toggle of the setting.
#[tauri::command]
pub fn debug_server_set_enabled(
    app: AppHandle,
    state: State<'_, DebugState>,
    enabled: bool,
) -> Result<Value, String> {
    let port = debug_port();
    let mut control = state.control.lock().unwrap();
    if enabled == control.enabled {
        return Ok(json!({"enabled": enabled, "port": control.port}));
    }
    if enabled {
        let token = load_or_create_token(&app);
        let listener = tauri::async_runtime::block_on(TcpListener::bind(("127.0.0.1", port)))
            .map_err(|e| format!("failed to bind 127.0.0.1:{port}: {e}"))?;
        write_discovery_file(&app, port, &token);
        control.handle = Some(tauri::async_runtime::spawn(serve(
            listener,
            app.clone(),
            token,
        )));
        control.enabled = true;
        control.port = Some(port);
        log::info!("debug-mcp: listening on http://127.0.0.1:{port}/mcp");
    } else {
        control.enabled = false;
        control.port = None;
        // The accept loop holds its own Arc of the listener, so the port is
        // released as soon as the aborted task unwinds.
        if let Some(handle) = control.handle.take() {
            handle.abort();
        }
        state.sessions.lock().unwrap().clear();
        log::info!("debug-mcp: stopped");
    }
    Ok(json!({"enabled": control.enabled, "port": control.port}))
}

/// Status + connection details for the settings UI. A *rejected* invoke (the
/// command is absent from release builds) is how the frontend detects that this
/// build has no debug server at all — same self-gating trick as
/// `services/debugReport.ts`.
#[tauri::command]
pub fn debug_server_status(app: AppHandle, state: State<'_, DebugState>) -> Value {
    let control = state.control.lock().unwrap();
    json!({
        "enabled": control.enabled,
        "port": control.port,
        "url": control.port.map(|port| format!("http://127.0.0.1:{port}/mcp")),
        "token": load_or_create_token(&app),
        "token_path": token_path(&app).map(|p| p.display().to_string()),
    })
}

/// Window lifecycle taps for /events. Called from the RunEvent handler in
/// lib.rs, which sees destroys the JS side may never report.
pub fn record_window_event(app: &AppHandle, label: &str, event: &WindowEvent) {
    let kind = match event {
        WindowEvent::CloseRequested { .. } => "close_requested",
        WindowEvent::Destroyed => "destroyed",
        WindowEvent::Focused(true) => "focused",
        WindowEvent::Focused(false) => "blurred",
        _ => return,
    };
    let state: State<'_, DebugState> = app.state();
    let id = state.event_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let mut events = state.events.lock().unwrap();
    push_capped(
        &mut events,
        json!({"id": id, "ts": now_ms(), "label": label, "event": kind}),
        EVENT_CAPACITY,
    );
}

fn debug_port() -> u16 {
    std::env::var("READEST_DEBUG_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn token_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(TOKEN_FILE))
}

/// Stable per-install token: generated once, then reused so the header a client
/// was configured with keeps working across app restarts.
fn load_or_create_token(app: &AppHandle) -> String {
    let Some(path) = token_path(app) else {
        return uuid::Uuid::new_v4().simple().to_string();
    };
    if let Ok(token) = std::fs::read_to_string(&path) {
        let token = token.trim().to_string();
        if !token.is_empty() {
            return token;
        }
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(&path, &token) {
        log::warn!("debug-mcp: cannot persist token to {}: {e}", path.display());
    }
    token
}

/// Discovery file so out-of-process tools can find the port and token without
/// scraping logs or settings.
fn write_discovery_file(app: &AppHandle, port: u16, token: &str) {
    let Ok(log_dir) = app.path().app_log_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&log_dir);
    let path = log_dir.join("debug-mcp.json");
    let discovery = json!({"port": port, "token": token, "pid": std::process::id()});
    let _ = std::fs::write(&path, discovery.to_string());
    log::info!("debug-mcp: discovery file {}", path.display());
}

async fn serve(listener: TcpListener, app: AppHandle, token: String) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            break;
        };
        let app = app.clone();
        let token = token.clone();
        // One task per connection: a hanging SSE stream must not block others.
        tauri::async_runtime::spawn(async move {
            let _ = handle_one(&mut stream, &app, &token).await;
        });
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    for line in headers.lines().skip(1) {
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case(name) {
                return Some(value.trim());
            }
        }
    }
    None
}

fn bearer_token(headers: &str) -> Option<&str> {
    header_value(headers, "authorization")?.strip_prefix("Bearer ")
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        pair.split_once('=')
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v)
    })
}

fn request_line(headers: &str) -> (&str, &str, &str) {
    let mut parts = headers.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    match target.find('?') {
        Some(i) => (method, &target[..i], &target[i + 1..]),
        None => (method, target, ""),
    }
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &str,
    session_id: Option<&str>,
) -> std::io::Result<()> {
    let session = session_id
        .map(|id| format!("Mcp-Session-Id: {id}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{session}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    let _ = stream.shutdown().await;
    Ok(())
}

async fn write_error(stream: &mut TcpStream, status: u16, reason: &str) -> std::io::Result<()> {
    let body = json!({"error": reason}).to_string();
    write_response(stream, status, reason, "application/json", &body, None).await
}

/// MCP clients may legally open GET /mcp for the server->client SSE stream.
/// Nothing here pushes server-initiated messages (every tool is a read), so the
/// stream exists only to keep such clients alive: an initial comment, then a
/// keepalive every 20s, on a socket that never carries a body.
async fn serve_event_stream(stream: &mut TcpStream, session: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nMcp-Session-Id: {session}\r\nConnection: keep-alive\r\n\r\n: connected\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).await?;
    stream.flush().await?;
    let mut probe = [0u8; 1];
    loop {
        // A timeout means the client is still quietly attached: keepalive.
        match tokio::time::timeout(KEEPALIVE_INTERVAL, stream.read(&mut probe)).await {
            Ok(_) => break,
            Err(_) => {
                if stream.write_all(b": keepalive\r\n\r\n").await.is_err() {
                    break;
                }
            }
        }
    }
    let _ = stream.shutdown().await;
    Ok(())
}

async fn handle_one(stream: &mut TcpStream, app: &AppHandle, token: &str) -> std::io::Result<()> {
    // Read until the header block ends, then however many body bytes the
    // headers announce. Same skeleton as clip_url.rs.
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if buf.len() > MAX_REQUEST_BYTES {
            return write_error(stream, 413, "request too large").await;
        }
        let n = match tokio::time::timeout(SOCKET_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => return Ok(()),
        };
        buf.extend_from_slice(&chunk[..n]);
        if let Some(idx) = find_header_end(&buf) {
            break idx;
        }
    };

    let headers = std::str::from_utf8(&buf[..header_end]).unwrap_or("");
    let (method, path, query) = request_line(headers);
    let body_len = header_value(headers, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0)
        .min(MAX_REQUEST_BYTES);
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < body_len {
        let n = match tokio::time::timeout(SOCKET_TIMEOUT, stream.read(&mut chunk)).await {
            Ok(Ok(n)) if n > 0 => n,
            _ => break,
        };
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(body_len);

    if bearer_token(headers) != Some(token) {
        return write_error(stream, 401, "invalid or missing bearer token").await;
    }

    match (method, path) {
        ("GET", "/health") => write_json(stream, health_body(app)).await,
        ("GET", "/state") => write_json(stream, state_body(app)).await,
        ("GET", "/logs") => {
            let n = query_param(query, "n")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(200)
                .clamp(1, CONSOLE_CAPACITY);
            write_json(stream, logs_body(app, n)).await
        }
        ("GET", "/events") => {
            let since = query_param(query, "since")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            write_json(stream, events_body(app, since)).await
        }
        ("POST", "/mcp") => {
            let session = header_value(headers, "mcp-session-id")
                .map(str::to_string)
                .or_else(|| query_param(query, "session").map(str::to_string));
            handle_mcp_post(stream, app, session.as_deref(), &body).await
        }
        ("GET", "/mcp") => {
            let session = header_value(headers, "mcp-session-id");
            let known = session.is_some_and(|id| {
                app.state::<DebugState>()
                    .sessions
                    .lock()
                    .unwrap()
                    .contains_key(id)
            });
            match session {
                Some(session) if known => serve_event_stream(stream, session).await,
                Some(_) => write_error(stream, 404, "unknown Mcp-Session-Id").await,
                None => write_error(stream, 400, "missing Mcp-Session-Id").await,
            }
        }
        ("DELETE", "/mcp") => {
            let session = header_value(headers, "mcp-session-id").unwrap_or("");
            let removed = app
                .state::<DebugState>()
                .sessions
                .lock()
                .unwrap()
                .remove(session)
                .is_some();
            if removed {
                write_response(stream, 204, "No Content", "application/json", "", None).await
            } else {
                write_error(stream, 404, "unknown Mcp-Session-Id").await
            }
        }
        _ => write_error(stream, 404, "not found").await,
    }
}

async fn write_json(stream: &mut TcpStream, response: Value) -> std::io::Result<()> {
    write_response(
        stream,
        200,
        "OK",
        "application/json",
        &response.to_string(),
        None,
    )
    .await
}

async fn handle_mcp_post(
    stream: &mut TcpStream,
    app: &AppHandle,
    session: Option<&str>,
    body: &[u8],
) -> std::io::Result<()> {
    let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return write_response(
            stream,
            400,
            "Bad Request",
            "application/json",
            &json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "parse error"}})
                .to_string(),
            None,
        )
        .await;
    };
    let is_initialize = message.get("method").and_then(Value::as_str) == Some("initialize");
    match session {
        // Sessions are mandatory: a request without one, or with one this
        // server never minted (closed via DELETE, or from a previous run), is
        // 404 so the client knows to re-initialize. WebView2 aside, nothing
        // else may reach the tools.
        Some(_) if is_initialize => {}
        Some(session) => {
            let known = app
                .state::<DebugState>()
                .sessions
                .lock()
                .unwrap()
                .contains_key(session);
            if !known {
                return write_error(stream, 404, "unknown Mcp-Session-Id").await;
            }
        }
        None if is_initialize => {}
        None => return write_error(stream, 404, "missing Mcp-Session-Id").await,
    }
    // `initialize` mints the session every later request must echo back.
    let session_id = if is_initialize {
        let id = uuid::Uuid::new_v4().simple().to_string();
        app.state::<DebugState>()
            .sessions
            .lock()
            .unwrap()
            .insert(id.clone(), DEFAULT_PROTOCOL_VERSION.to_string());
        Some(id)
    } else {
        session.map(str::to_string)
    };
    let mut reply = mcp_message(
        &|name, args| tool_outcome(app, name, args),
        message,
        session_id.as_deref(),
    );
    // A deferred tool call only got as far as picking its target: run it here,
    // where the request is already async, and overwrite the placeholder reply.
    if let Some(deferred) = reply.deferred.take() {
        let result = match deferred.plan {
            Plan::Frontend { labels, action } => run_frontend_action(app, &labels, &action).await,
            Plan::Screenshot { label } => screenshot_result(app, &label).await,
        };
        reply = McpReply::json(rpc_ok(&deferred.id, result));
    }
    write_response(
        stream,
        reply.status,
        reply.reason,
        reply.content_type,
        &reply.body,
        if reply.emit_session {
            session_id.as_deref()
        } else {
            None
        },
    )
    .await
}

// ---------------------------------------------------------------------------
// Action tools: Rust -> webview -> Rust
//
// Read tools are answered from the in-process buffers, but an action has to run
// inside a window (the library window owns book opening, a reader window owns
// its view) or inside the platform webview. Those calls are *deferred*: the
// protocol layer picks the target and `handle_mcp_post` awaits the result.
// ---------------------------------------------------------------------------

/// What a deferred tool call needs before it can be answered.
enum Plan {
    /// Run `action` in every listed window and collect their reports. A list
    /// (not a single label) so `readest_reload` can mean "all windows".
    Frontend {
        labels: Vec<String>,
        action: Value,
    },
    Screenshot {
        label: String,
    },
}

/// A tool call's answer, or the plan that has to run before there is one.
enum ToolOutcome {
    Ready(Value),
    Deferred(Plan),
}

/// A tool reply that has to wait for a webview (or for the platform capture).
struct Deferred {
    id: Value,
    plan: Plan,
}

fn text_result(text: impl std::fmt::Display) -> Value {
    json!({"content": [{"type": "text", "text": text.to_string()}]})
}

/// MCP reports tool failures in the result (`isError`), not as JSON-RPC errors:
/// the call was well formed, the world said no.
fn error_result(text: impl std::fmt::Display) -> Value {
    json!({"content": [{"type": "text", "text": text.to_string()}], "isError": true})
}

fn window_labels(app: &AppHandle) -> Vec<String> {
    let mut labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    labels.sort();
    labels
}

/// A tool that names a window gets a useful error instead of a silent no-op.
fn require_window(app: &AppHandle, label: &str) -> Result<(), String> {
    if app.get_webview_window(label).is_some() {
        return Ok(());
    }
    Err(format!(
        "no window labelled '{label}'; open windows: {}",
        window_labels(app).join(", ")
    ))
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Relays one action to one window and waits for its report. A closed or wedged
/// window is an error for the caller — never a hang.
async fn dispatch_action(app: &AppHandle, label: &str, action: &Value) -> Result<Value, String> {
    let (reply, answer) = tokio::sync::oneshot::channel();
    let id = uuid::Uuid::new_v4().simple().to_string();
    app.state::<DebugState>()
        .pending
        .lock()
        .unwrap()
        .insert(id.clone(), reply);
    let drop_pending = |id: &str| {
        app.state::<DebugState>().pending.lock().unwrap().remove(id);
    };
    if let Err(e) = app.emit_to(label, ACTION_EVENT, json!({"id": id, "action": action})) {
        drop_pending(&id);
        return Err(format!("cannot reach window '{label}': {e}"));
    }
    match tokio::time::timeout(ACTION_TIMEOUT, answer).await {
        Ok(Ok(report)) => Ok(report),
        Ok(Err(_)) => Err(format!("window '{label}' closed before reporting")),
        Err(_) => {
            drop_pending(&id);
            Err(format!(
                "window '{label}' did not report within {}s",
                ACTION_TIMEOUT.as_secs()
            ))
        }
    }
}

/// Runs the action in every target window and relays what each reported. The
/// whole call is only an error when *some* window failed, so a reload-all still
/// shows the windows that did reload.
async fn run_frontend_action(app: &AppHandle, labels: &[String], action: &Value) -> Value {
    let mut results = Vec::new();
    for label in labels {
        results.push(match dispatch_action(app, label, action).await {
            Ok(report) => json!({"window": label, "report": report}),
            Err(error) => json!({"window": label, "error": error}),
        });
    }
    let failed = results.iter().any(|entry| {
        entry.get("error").is_some() || entry["report"]["ok"].as_bool() == Some(false)
    });
    let payload = json!({"results": results});
    if failed {
        error_result(payload)
    } else {
        text_result(payload)
    }
}

// ---------------------------------------------------------------------------
// MCP Streamable HTTP (JSON-RPC 2.0 over POST). Hand-rolled on purpose: the
// transport is small, the tool surface is fixed, and the crate carries no MCP
// dependency — the schemas below are the contract, and the tests cover them.
// ---------------------------------------------------------------------------

struct McpReply {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    body: String,
    /// Send `Mcp-Session-Id` back: only `initialize` does, per spec.
    emit_session: bool,
    /// Set when the tool call has to run before the reply body exists;
    /// `handle_mcp_post` overwrites the (empty) placeholder.
    deferred: Option<Deferred>,
}

impl McpReply {
    fn json(payload: Value) -> Self {
        Self {
            status: 200,
            reason: "OK",
            content_type: "application/json",
            body: payload.to_string(),
            emit_session: false,
            deferred: None,
        }
    }

    fn deferred(id: Value, plan: Plan) -> Self {
        Self {
            deferred: Some(Deferred { id, plan }),
            ..Self::json(Value::Null)
        }
    }

    fn initialize(payload: Value) -> Self {
        Self {
            emit_session: true,
            ..Self::json(payload)
        }
    }

    fn accepted() -> Self {
        Self {
            status: 202,
            reason: "Accepted",
            content_type: "application/json",
            body: String::new(),
            emit_session: false,
            deferred: None,
        }
    }
}

fn rpc_ok(id: &Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn rpc_err(id: &Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

/// Handles one JSON-RPC message. Notifications (no `id`) get 202 with no body;
/// `initialize` is answered with the session the transport just minted. The
/// injected `tool_call` keeps the tool surface out of the protocol layer, so
/// the protocol arms below are testable without a live app.
fn mcp_message(
    tool_call: &dyn Fn(&str, &Value) -> Option<ToolOutcome>,
    message: Value,
    session: Option<&str>,
) -> McpReply {
    let method = message
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let Some(id) = message.get("id").filter(|id| !id.is_null()).cloned() else {
        return McpReply::accepted();
    };
    if let Some(session) = session {
        log::debug!("debug-mcp: {method} on session {session}");
    }

    match method.as_str() {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("");
            let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
                requested
            } else {
                DEFAULT_PROTOCOL_VERSION
            };
            McpReply::initialize(rpc_ok(
                &id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "readest-debug", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": "Readest in-app debug tools: window/reader state, browser-console tail, window lifecycle events, plus actions (open a book, jump to a location, reload a window, screenshot it). The app must be running with the MCP debug server enabled in Settings → Misc → Developer.",
                }),
            ))
        }
        "ping" => McpReply::json(rpc_ok(&id, json!({}))),
        "tools/list" => McpReply::json(rpc_ok(&id, json!({"tools": tool_catalog()}))),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match tool_call(name, &args) {
                Some(ToolOutcome::Ready(result)) => McpReply::json(rpc_ok(&id, result)),
                Some(ToolOutcome::Deferred(plan)) => McpReply::deferred(id.clone(), plan),
                None => McpReply::json(rpc_err(&id, -32602, &format!("unknown tool: {name}"))),
            }
        }
        other => McpReply::json(rpc_err(&id, -32601, &format!("method not found: {other}"))),
    }
}

fn tool_catalog() -> Value {
    json!([
        {
            "name": "readest_state",
            "description": "Readest windows, open books with live reading progress, and the latest per-window UI state snapshots.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": false}
        },
        {
            "name": "readest_logs",
            "description": "Tail of the browser console across all Readest windows (log/info/warn/error), newest last.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer", "minimum": 1, "maximum": 1000, "description": "How many trailing entries to return (default 200)."}
                },
                "additionalProperties": false
            }
        },
        {
            "name": "readest_events",
            "description": "Window lifecycle events (close_requested/destroyed/focused/blurred) with incremental ids; pass the last id seen as `since` to poll.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "since": {"type": "integer", "minimum": 0, "description": "Return only events with id greater than this."}
                },
                "additionalProperties": false
            }
        },
        {
            "name": "readest_open_book",
            "description": "Open books in Readest by hash. A single hash focuses the reader window that already has it open, otherwise a reader window is created. The window appears asynchronously: poll readest_state for it.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hashes": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "description": "Book hashes to open together, as reported by readest_state."
                    }
                },
                "required": ["hashes"],
                "additionalProperties": false
            }
        },
        {
            "name": "readest_goto",
            "description": "Move a reader window's view to a location: a CFI (or an href/landmark) via `cfi`, or a 1-based page number via `page`. Rejects when the book has no page count yet.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "window": {"type": "string", "description": "Reader window label from readest_state."},
                    "hash": {"type": "string", "description": "Which book to move, when the window has several open (default: the first one)."},
                    "cfi": {"type": "string", "description": "Target CFI, href, or landmark."},
                    "page": {"type": "integer", "minimum": 1, "description": "Target page number, 1-based: use `section` for fixed-layout books (the number the footer shows) and `pageinfo` for reflowable ones."}
                },
                "required": ["window"],
                "additionalProperties": false
            }
        },
        {
            "name": "readest_reload",
            "description": "Reload a window (or every window) like Ctrl+R, going through the app's own before-reload save chain so no reading position is lost. Use it to pick up frontend edits when HMR is unreliable.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "window": {"type": "string", "description": "Window label from readest_state (default: every open window)."}
                },
                "additionalProperties": false
            }
        },
        {
            "name": "readest_screenshot",
            "description": "PNG screenshot of one window's rendered content, returned as MCP image content so it can be looked at directly. Works while the window is occluded. Windows only.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "window": {"type": "string", "description": "Window label from readest_state."}
                },
                "required": ["window"],
                "additionalProperties": false
            }
        }
    ])
}

/// Answers a tool call: read tools immediately, actions as a plan the caller
/// runs. `None` means no such tool (the protocol layer turns that into -32602).
fn tool_outcome(app: &AppHandle, name: &str, args: &Value) -> Option<ToolOutcome> {
    // Read tools answer from the in-process buffers.
    let ready = match name {
        "readest_state" => Some(state_body(app)),
        "readest_logs" => {
            let n = args
                .get("n")
                .and_then(Value::as_u64)
                .unwrap_or(200)
                .clamp(1, CONSOLE_CAPACITY as u64) as usize;
            Some(logs_body(app, n))
        }
        "readest_events" => {
            let since = args.get("since").and_then(Value::as_u64).unwrap_or(0);
            Some(events_body(app, since))
        }
        _ => None,
    };
    if let Some(body) = ready {
        return Some(ToolOutcome::Ready(text_result(body)));
    }

    let window = args.get("window").and_then(Value::as_str);
    let check = |label: &str| match require_window(app, label) {
        Ok(()) => None,
        Err(e) => Some(ToolOutcome::Ready(error_result(e))),
    };
    match name {
        // The library window owns book opening (services/debugReport.ts runs
        // showReaderWindow/focusExistingReaderWindow there).
        "readest_open_book" => {
            let hashes = string_array(args.get("hashes"));
            if hashes.is_empty() {
                return Some(ToolOutcome::Ready(error_result(
                    "hashes must name at least one book hash",
                )));
            }
            if let Some(error) = check("main") {
                return Some(error);
            }
            Some(ToolOutcome::Deferred(Plan::Frontend {
                labels: vec!["main".to_string()],
                action: json!({"kind": "open-book", "hashes": hashes}),
            }))
        }
        "readest_goto" => {
            let Some(label) = window else {
                return Some(ToolOutcome::Ready(error_result(
                    "window is required: pass a label from readest_state",
                )));
            };
            let cfi = args.get("cfi").and_then(Value::as_str);
            let page = args.get("page").and_then(Value::as_i64);
            if cfi.is_none() && page.is_none() {
                return Some(ToolOutcome::Ready(error_result(
                    "pass cfi or page for the target location",
                )));
            }
            if let Some(error) = check(label) {
                return Some(error);
            }
            Some(ToolOutcome::Deferred(Plan::Frontend {
                labels: vec![label.to_string()],
                action: json!({
                    "kind": "goto",
                    "hash": args.get("hash"),
                    "cfi": cfi,
                    "page": page,
                }),
            }))
        }
        "readest_reload" => {
            let labels = match window {
                Some(label) => {
                    if let Some(error) = check(label) {
                        return Some(error);
                    }
                    vec![label.to_string()]
                }
                None => window_labels(app),
            };
            if labels.is_empty() {
                return Some(ToolOutcome::Ready(error_result("no windows are open")));
            }
            Some(ToolOutcome::Deferred(Plan::Frontend {
                labels,
                action: json!({"kind": "reload"}),
            }))
        }
        "readest_screenshot" => {
            let Some(label) = window else {
                return Some(ToolOutcome::Ready(error_result(
                    "window is required: pass a label from readest_state",
                )));
            };
            if let Some(error) = check(label) {
                return Some(error);
            }
            Some(ToolOutcome::Deferred(Plan::Screenshot {
                label: label.to_string(),
            }))
        }
        _ => None,
    }
}

fn health_body(app: &AppHandle) -> Value {
    let state: State<'_, DebugState> = app.state();
    json!({
        "ok": true,
        "pid": std::process::id(),
        "uptime_ms": state.started_at.elapsed().as_millis() as u64,
        "app_version": app.package_info().version.to_string(),
    })
}

fn state_body(app: &AppHandle) -> Value {
    let debug: State<'_, DebugState> = app.state();
    let snapshots = debug.snapshots.lock().unwrap();
    let mut windows = Vec::new();
    for (label, webview) in app.webview_windows() {
        let url = webview.url().map(|u| u.as_str().to_string()).ok();
        let title = webview.title().ok();
        // Reader windows carry their books in the URL (`?ids=hash1+hash2`),
        // same source as find_reader_window_with_book.
        let books = url
            .as_deref()
            .and_then(|u| Url::parse(u).ok())
            .and_then(|parsed| {
                parsed
                    .query_pairs()
                    .into_owned()
                    .find(|(key, _)| key == "ids")
                    .map(|(_, ids)| ids.split('+').map(str::to_string).collect::<Vec<_>>())
            })
            .unwrap_or_default();
        windows.push(json!({
            "label": label,
            "title": title,
            "url": url,
            "books": books,
            "snapshot": snapshots.get(&label),
        }));
    }
    json!({"windows": windows})
}

fn logs_body(app: &AppHandle, n: usize) -> Value {
    let debug: State<'_, DebugState> = app.state();
    let console = debug.console.lock().unwrap();
    let skip = console.len().saturating_sub(n);
    let entries: Vec<&Value> = console.iter().skip(skip).collect();
    json!({"entries": entries, "total": console.len()})
}

fn events_body(app: &AppHandle, since: u64) -> Value {
    let debug: State<'_, DebugState> = app.state();
    let events = debug.events.lock().unwrap();
    let matched: Vec<&Value> = events
        .iter()
        .filter(|e| e["id"].as_u64().is_some_and(|id| id > since))
        .collect();
    let last_id = events.back().and_then(|e| e["id"].as_u64()).unwrap_or(0);
    json!({"events": matched, "last_id": last_id})
}

/// Screenshot as MCP image content, or the reason it could not be taken.
async fn screenshot_result(app: &AppHandle, label: &str) -> Value {
    let Some(window) = app.get_webview_window(label) else {
        return error_result(format!("no window labelled '{label}'"));
    };
    match capture_png(&window).await {
        Ok(png) => {
            use base64::Engine;
            let data = base64::engine::general_purpose::STANDARD.encode(png);
            json!({"content": [{"type": "image", "data": data, "mimeType": "image/png"}]})
        }
        Err(e) => error_result(e),
    }
}

/// WebView2 renders through DirectComposition, so OS-level window capture
/// (PrintWindow/BitBlt) returns the frame with a blank client area;
/// `ICoreWebView2::CapturePreview` is the call that actually renders the page,
/// and it works while the window is occluded or behind others.
#[cfg(windows)]
async fn capture_png(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

    // `mpsc` (not `oneshot`) only because a synchronous `CapturePreview`
    // failure has to report through the same channel the callback uses.
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    window
        .with_webview(move |platform| {
            // A null HGLOBAL asks for a stream that grows as the PNG is written.
            let stream = match unsafe { CreateStreamOnHGlobal(HGLOBAL::default(), true) } {
                Ok(stream) => stream,
                Err(e) => {
                    let _ = tx.try_send(Err(format!("cannot create the capture stream: {e}")));
                    return;
                }
            };
            let webview = match unsafe { platform.controller().CoreWebView2() } {
                Ok(webview) => webview,
                Err(e) => {
                    let _ = tx.try_send(Err(format!("cannot reach the WebView2: {e}")));
                    return;
                }
            };
            // The completion arrives on the message loop the main thread is
            // already pumping, and the bytes are read there too — the stream is
            // read on the thread that created it, so no COM marshalling. A
            // callback that never fires is the caller's timeout, not a hang.
            let readback = stream.clone();
            let handler_tx = tx.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                let outcome = match result {
                    Ok(()) => read_stream(&readback),
                    Err(e) => Err(format!("CapturePreview failed: {e}")),
                };
                let _ = handler_tx.try_send(outcome);
                Ok(())
            }));
            if let Err(e) = unsafe {
                webview.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &handler,
                )
            } {
                let _ = tx.try_send(Err(format!("CapturePreview was rejected: {e}")));
            }
        })
        .map_err(|e| format!("cannot reach the window's webview: {e}"))?;

    match tokio::time::timeout(SCREENSHOT_TIMEOUT, rx.recv()).await {
        Ok(Some(result)) => result,
        Ok(None) => Err("the capture channel closed".to_string()),
        Err(_) => Err(format!(
            "the webview did not finish capturing within {}s",
            SCREENSHOT_TIMEOUT.as_secs()
        )),
    }
}

#[cfg(windows)]
fn read_stream(stream: &windows::Win32::System::Com::IStream) -> Result<Vec<u8>, String> {
    use windows::Win32::System::Com::{ISequentialStream, STREAM_SEEK_SET};
    unsafe {
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|e| format!("cannot rewind the capture stream: {e}"))?;
        let reader: &ISequentialStream = stream.into();
        let mut png = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            reader
                .Read(
                    chunk.as_mut_ptr().cast(),
                    chunk.len() as u32,
                    Some(&mut read),
                )
                .ok()
                .map_err(|e| format!("cannot read the capture stream: {e}"))?;
            if read == 0 {
                break;
            }
            png.extend_from_slice(&chunk[..read as usize]);
        }
        Ok(png)
    }
}

/// macOS/Linux are outside this fork's targets; the Linux CEF build does not
/// even compile `with_webview`.
#[cfg(not(windows))]
async fn capture_png(_window: &WebviewWindow) -> Result<Vec<u8>, String> {
    Err("screenshots are implemented for Windows (WebView2) only".to_string())
}

// The JSON-RPC envelope and the tool catalog are the testable surface of /mcp;
// the listener and the tool readers need a live Tauri app, so these drive
// `mcp_message` with a stub reader over the protocol-level arms.
#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, params: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    }

    fn no_tools(_name: &str, _args: &Value) -> Option<ToolOutcome> {
        None
    }

    #[test]
    fn initialize_echoes_a_supported_protocol_version() {
        let reply = mcp_message(
            &no_tools,
            request("initialize", json!({"protocolVersion": "2024-11-05"})),
            None,
        );
        assert_eq!(reply.status, 200);
        assert!(reply.emit_session);
        let body: Value = serde_json::from_str(&reply.body).unwrap();
        assert_eq!(body["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(body["result"]["serverInfo"]["name"], "readest-debug");
        assert_eq!(body["id"], 1);
    }

    #[test]
    fn initialize_offers_the_newest_version_when_the_client_asks_for_an_unknown_one() {
        let reply = mcp_message(
            &no_tools,
            request("initialize", json!({"protocolVersion": "1999-01-01"})),
            None,
        );
        let body: Value = serde_json::from_str(&reply.body).unwrap();
        assert_eq!(body["result"]["protocolVersion"], DEFAULT_PROTOCOL_VERSION);
    }

    #[test]
    fn tools_list_exposes_the_read_and_action_tools() {
        let reply = mcp_message(&no_tools, request("tools/list", json!({})), None);
        let body: Value = serde_json::from_str(&reply.body).unwrap();
        let names: Vec<&str> = body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "readest_state",
                "readest_logs",
                "readest_events",
                "readest_open_book",
                "readest_goto",
                "readest_reload",
                "readest_screenshot",
            ]
        );
    }

    #[test]
    fn tools_call_passes_the_tool_result_through() {
        let reader = |name: &str, args: &Value| match name {
            "readest_logs" => Some(ToolOutcome::Ready(text_result(
                json!({"entries": [], "n": args["n"]}),
            ))),
            _ => None,
        };
        let reply = mcp_message(
            &reader,
            request(
                "tools/call",
                json!({"name": "readest_logs", "arguments": {"n": 5}}),
            ),
            None,
        );
        let body: Value = serde_json::from_str(&reply.body).unwrap();
        assert_eq!(body["result"]["content"][0]["type"], "text");
        assert_eq!(
            body["result"]["content"][0]["text"],
            r#"{"entries":[],"n":5}"#
        );
        assert!(reply.deferred.is_none());
    }

    #[test]
    fn a_deferred_tool_call_hands_the_plan_to_the_caller() {
        let reader = |name: &str, _args: &Value| match name {
            "readest_goto" => Some(ToolOutcome::Deferred(Plan::Frontend {
                labels: vec!["reader-1".to_string()],
                action: json!({"kind": "goto", "cfi": "epubcfi(/6/4)"}),
            })),
            _ => None,
        };
        let reply = mcp_message(
            &reader,
            request("tools/call", json!({"name": "readest_goto"})),
            None,
        );
        let deferred = reply.deferred.expect("deferred plan");
        assert_eq!(deferred.id, 1);
        match deferred.plan {
            Plan::Frontend { labels, action } => {
                assert_eq!(labels, ["reader-1"]);
                assert_eq!(action["kind"], "goto");
            }
            Plan::Screenshot { .. } => panic!("wrong plan"),
        }
    }

    #[test]
    fn tools_call_rejects_an_unknown_tool() {
        let reply = mcp_message(
            &no_tools,
            request("tools/call", json!({"name": "readest_write"})),
            None,
        );
        let body: Value = serde_json::from_str(&reply.body).unwrap();
        assert_eq!(body["error"]["code"], -32602);
    }

    #[test]
    fn unknown_method_is_method_not_found() {
        let reply = mcp_message(&no_tools, request("resources/list", json!({})), None);
        let body: Value = serde_json::from_str(&reply.body).unwrap();
        assert_eq!(body["error"]["code"], -32601);
    }

    #[test]
    fn notifications_get_no_response_body() {
        let reply = mcp_message(
            &no_tools,
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            None,
        );
        assert_eq!(reply.status, 202);
        assert!(reply.body.is_empty());
        assert!(!reply.emit_session);
    }
}
