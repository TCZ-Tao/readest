//! Dev-only MCP debug server, hosted *inside* the app: a read-only HTTP server
//! on 127.0.0.1 serving both the plain JSON endpoints (/health, /state, /logs,
//! /events) and an MCP Streamable HTTP endpoint at /mcp, so any MCP client can
//! attach with just a URL and a bearer token — no per-client stdio wrapper.
//!
//! Compiled into desktop debug builds only (`debug_assertions`), never into
//! release, and off until the user flips Developer → "MCP Debug Server" in
//! settings (persisted as `debugMcpEnabled`, re-applied from the main window at
//! boot). The bearer token is persisted in the app config dir so a client's
//! header survives app restarts.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Url, WebviewWindow, WindowEvent};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const DEFAULT_PORT: u16 = 9339;
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const SOCKET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);
const CONSOLE_CAPACITY: usize = 1000;
const EVENT_CAPACITY: usize = 500;
const TOKEN_FILE: &str = "debug-mcp-token";
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
    let reply = mcp_message(
        &|name, args| call_tool(app, name, args),
        message,
        session_id.as_deref(),
    );
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
}

impl McpReply {
    fn json(payload: Value) -> Self {
        Self {
            status: 200,
            reason: "OK",
            content_type: "application/json",
            body: payload.to_string(),
            emit_session: false,
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
/// `initialize` is answered with the session the transport just minted.
fn mcp_message(
    read_tool: &dyn Fn(&str, &Value) -> Option<Value>,
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
                    "instructions": "Readest in-app debug tools (read-only): window/reader state, browser-console tail, window lifecycle events. The app must be running with the MCP debug server enabled in Settings → Misc → Developer.",
                }),
            ))
        }
        "ping" => McpReply::json(rpc_ok(&id, json!({}))),
        "tools/list" => McpReply::json(rpc_ok(&id, json!({"tools": tool_catalog()}))),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match read_tool(name, &args) {
                Some(value) => McpReply::json(rpc_ok(
                    &id,
                    json!({"content": [{"type": "text", "text": value.to_string()}]}),
                )),
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
        }
    ])
}

fn call_tool(app: &AppHandle, name: &str, args: &Value) -> Option<Value> {
    match name {
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

// The JSON-RPC envelope and the tool catalog are the testable surface of /mcp;
// the listener and the tool readers need a live Tauri app, so these drive
// `mcp_message` with a stub reader over the protocol-level arms.
#[cfg(test)]
mod tests {
    use super::*;

    fn request(method: &str, params: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    }

    fn no_tools(_name: &str, _args: &Value) -> Option<Value> {
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
    fn tools_list_exposes_the_three_debug_tools() {
        let reply = mcp_message(&no_tools, request("tools/list", json!({})), None);
        let body: Value = serde_json::from_str(&reply.body).unwrap();
        let names: Vec<&str> = body["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["readest_state", "readest_logs", "readest_events"]);
    }

    #[test]
    fn tools_call_wraps_the_read_result_as_text_content() {
        let reader = |name: &str, args: &Value| match name {
            "readest_logs" => Some(json!({"entries": [], "n": args["n"]})),
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
