// Protocol check for the in-app MCP server (/mcp, Streamable HTTP), driven with
// plain fetch so the repo needs no MCP dependency: it speaks the same wire
// protocol an SDK client does (JSON-RPC 2.0 over POST + Mcp-Session-Id).
//
//   node scripts/mcp-parity.mjs <token> [port]
//
// Expects Readest running with Settings → Misc → Developer → "MCP Debug Server"
// on; the token is shown in that section (and written to
// `%APPDATA%\com.bilingify.readest\debug-mcp-token`).

const token = process.argv[2];
const port = process.argv[3] ?? '9339';
if (!token) {
  console.error('usage: node scripts/mcp-parity.mjs <token> [port]');
  process.exit(2);
}

const url = `http://127.0.0.1:${port}/mcp`;
let sessionId = null;
let nextId = 0;
const failures = [];

const post = async (message, bearer = token) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });
  const session = res.headers.get('mcp-session-id');
  if (session && !sessionId) sessionId = session;
  return { status: res.status, body: (await res.text()).trim() };
};

const call = (method, params, bearer) => post({ id: ++nextId, method, params }, bearer);

const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

// initialize
const init = await call('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'readest-parity', version: '1.0.0' },
});
const initBody = JSON.parse(init.body);
check(init.status === 200, 'initialize status 200', String(init.status));
check(!!sessionId, 'initialize returned Mcp-Session-Id', sessionId ?? 'none');
check(
  initBody.result?.serverInfo?.name === 'readest-debug',
  'initialize serverInfo',
  JSON.stringify(initBody.result?.serverInfo),
);
check(
  initBody.result?.protocolVersion === '2025-06-18',
  'initialize echoes requested protocol version',
  initBody.result?.protocolVersion,
);

// initialized notification: no id, so it must be accepted with an empty body
const note = await post({ method: 'notifications/initialized' });
check(note.status === 202 && note.body === '', 'notifications/initialized -> 202 empty', String(note.status));

// tools/list
const list = JSON.parse((await call('tools/list', {})).body);
const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
check(
  names.join(',') ===
    [
      'readest_events',
      'readest_goto',
      'readest_logs',
      'readest_open_book',
      'readest_reload',
      'readest_screenshot',
      'readest_state',
      'readest_wait',
    ].join(','),
  'tools/list',
  names.join(', '),
);

// tools/call
for (const [name, args] of [
  ['readest_state', {}],
  ['readest_logs', { n: 5 }],
  ['readest_events', { since: 0 }],
]) {
  const call_ = JSON.parse((await call('tools/call', { name, arguments: args })).body);
  const text = call_.result?.content?.[0]?.text;
  check(
    typeof text === 'string' && text.startsWith('{'),
    `tools/call ${name}`,
    typeof text === 'string' ? `${text.slice(0, 80).replace(/\s+/g, ' ')}…` : JSON.stringify(call_).slice(0, 120),
  );
}

// readest_logs filters: every entry must clear the requested level, and an
// impossible grep must come back empty rather than unfiltered.
const logsText = async (args) =>
  JSON.parse(
    JSON.parse((await call('tools/call', { name: 'readest_logs', arguments: args })).body).result
      .content[0].text,
  );
const errors = await logsText({ n: 50, level: 'error' });
check(
  errors.entries.every((entry) => entry.level === 'error'),
  'readest_logs level filter',
  `${errors.entries.length} of ${errors.matched} error entries`,
);
const quiet = await logsText({ n: 5, level: 'error', grep: 'no-such-log-line-zzz' });
check(
  quiet.entries.length === 0 && quiet.matched === 0,
  'readest_logs grep filter',
  JSON.stringify(quiet).slice(0, 120),
);

// Action tools: argument validation and targeting happen before anything runs,
// so these two need no reader window and touch nothing.
for (const [name, args, why] of [
  ['readest_goto', { cfi: 'epubcfi(/6/4)' }, 'missing window'],
  ['readest_screenshot', { window: 'no-such-window' }, 'unknown window'],
  ['readest_wait', { window: 'no-such-window', until: 'ready' }, 'unknown window'],
  ['readest_wait', { window: 'main' }, "until missing"],
  ['readest_wait', { window: 'main', until: 'whenever' }, 'unknown until'],
]) {
  const call_ = JSON.parse((await call('tools/call', { name, arguments: args })).body);
  check(call_.result?.isError === true, `${name} rejects ${why}`, JSON.stringify(call_.result).slice(0, 120));
}

// until=ready resolves against the library window immediately, and reports the
// document's boot so a caller can tell one document from the next.
const waited = JSON.parse((await call('tools/call', { name: 'readest_wait', arguments: { window: 'main', until: 'ready', timeout_ms: 2000 } })).body);
const ready = JSON.parse(waited.result.content[0].text).results[0].report;
check(
  typeof ready?.boot === 'number' && ready.boot > 0,
  'readest_wait until=ready answers on main',
  JSON.stringify(ready).slice(0, 120),
);

// A screenshot of a live window is PNG image content, not text.
const state = JSON.parse(JSON.parse((await call('tools/call', { name: 'readest_state' })).body).result.content[0].text);
const window = state.windows?.[0]?.label;
if (window) {
  const shot = JSON.parse((await call('tools/call', { name: 'readest_screenshot', arguments: { window } })).body);
  const image = shot.result?.content?.[0];
  check(
    image?.type === 'image' && image.mimeType === 'image/png' && (image.data?.length ?? 0) > 1000,
    `readest_screenshot ${window} -> PNG image content`,
    image?.type === 'image' ? `${image.data.length} base64 chars` : JSON.stringify(shot.result).slice(0, 160),
  );
} else {
  console.log('skip readest_screenshot: no window open');
}

// unknown method and unknown tool are JSON-RPC errors, not crashes
check(!!JSON.parse((await call('resources/list', {})).body).error, 'unknown method -> JSON-RPC error');
check(!!JSON.parse((await call('tools/call', { name: 'nope' })).body).error, 'unknown tool -> JSON-RPC error');

// auth
check((await call('tools/list', {}, 'wrong-token')).status === 401, 'wrong bearer token -> 401');

// session lifecycle: GET stream needs a session, DELETE drops it
const stream = await fetch(url, {
  headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
  signal: AbortSignal.timeout(1500),
});
check(stream.status === 200, 'GET /mcp opens event stream', String(stream.status));
await stream.body?.cancel().catch(() => {});
const del = await fetch(url, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionId },
});
check(del.status === 204, 'DELETE /mcp closes session', String(del.status));
check((await call('tools/list', {})).status === 404, 'closed session -> 404');

console.log(failures.length ? `parity check FAILED (${failures.join('; ')})` : 'parity check passed');
process.exitCode = failures.length ? 1 : 0;
