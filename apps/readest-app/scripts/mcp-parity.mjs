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
      'readest_click',
      'readest_close_window',
      'readest_events',
      'readest_focus',
      'readest_goto',
      'readest_logs',
      'readest_open_book',
      'readest_press',
      'readest_reload',
      'readest_screenshot',
      'readest_search',
      'readest_settings',
      'readest_state',
      'readest_toc',
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
  ['readest_close_window', {}, 'missing window'],
  ['readest_focus', {}, 'missing window'],
  ['readest_focus', { window: 'no-such-window' }, 'unknown window'],
  ['readest_click', { window: 'main' }, 'missing selector'],
  ['readest_press', { window: 'main' }, 'missing key'],
  ['readest_press', { window: 'main', key: 'b', modifiers: ['ctl'] }, 'unknown modifier'],
  ['readest_toc', {}, 'missing window'],
  ['readest_search', { window: 'main' }, 'missing query'],
  ['readest_settings', { window: 'no-such-window' }, 'unknown window'],
  // `main` is the library window: not a reader route, so the frontend rejects it
  // immediately instead of spending the readiness budget.
  ['readest_toc', { window: 'main' }, 'not a reader route'],
  ['readest_search', { window: 'main', query: 'zzz' }, 'not a reader route'],
]) {
  const call_ = JSON.parse((await call('tools/call', { name, arguments: args })).body);
  check(call_.result?.isError === true, `${name} rejects ${why}`, JSON.stringify(call_.result).slice(0, 120));
}

// A click that matches nothing has to come back with something to aim at.
const missed = JSON.parse((await call('tools/call', { name: 'readest_click', arguments: { window: 'main', selector: '#no-such-thing' } })).body);
const missReport = JSON.parse(missed.result.content[0].text).results[0].report;
check(
  missed.result?.isError === true && Array.isArray(missReport?.candidates),
  'readest_click lists candidates when nothing matches',
  JSON.stringify(missReport).slice(0, 120),
);

// A press the shortcut layer does not claim reports `handled: false` rather than
// pretending to have done something.
const pressed = JSON.parse((await call('tools/call', { name: 'readest_press', arguments: { window: 'main', key: 'UnidentifiedKey' } })).body);
const pressReport = JSON.parse(pressed.result.content[0].text).results[0].report;
check(
  pressReport?.ok === true && pressReport?.handled === false,
  'readest_press reports an unclaimed key',
  JSON.stringify(pressReport).slice(0, 120),
);

// until=ready resolves against the library window immediately, and reports the
// document's boot so a caller can tell one document from the next.
const waited = JSON.parse((await call('tools/call', { name: 'readest_wait', arguments: { window: 'main', until: 'ready', timeout_ms: 2000 } })).body);
const ready = JSON.parse(waited.result.content[0].text).results[0].report;
check(
  typeof ready?.boot === 'number' && ready.boot > 0,
  'readest_wait until=ready answers on main',
  JSON.stringify(ready).slice(0, 120),
);

// A screenshot of a live window is PNG image content plus a metadata text part
// (sha256/bytes/size), not plain text.
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
  const meta = shot.result?.content?.[1]?.type === 'text' ? JSON.parse(shot.result.content[1].text) : null;
  check(
    !!meta && typeof meta.sha256 === 'string' && meta.sha256.length === 64 && meta.bytes > 1000 && meta.width > 0,
    `readest_screenshot ${window} -> frame metadata`,
    JSON.stringify(meta).slice(0, 160),
  );
  const focusCall = JSON.parse((await call('tools/call', { name: 'readest_focus', arguments: { window } })).body);
  const focusReport = JSON.parse(focusCall.result.content[0].text);
  check(
    focusReport?.ok === true && focusReport?.focused === window,
    `readest_focus ${window} reports the focused window`,
    JSON.stringify(focusReport).slice(0, 120),
  );
} else {
  console.log('skip readest_screenshot: no window open');
}

// TOC / search / settings read the window itself, so they need a book open in it:
// otherwise they are the not-a-reader-route rejections checked above.
const report = async (name, args) =>
  JSON.parse(
    JSON.parse((await call('tools/call', { name, arguments: args })).body).result.content[0]
      .text,
  ).results[0].report;
const readers = (state.windows ?? [])
  .filter((entry) => entry.snapshot?.books?.length)
  .map((entry) => entry.label);
const tocs = [];
for (const label of readers) tocs.push({ label, report: await report('readest_toc', { window: label }) });
check(
  tocs.length > 0 && tocs.every((entry) => entry.report?.ok === true && Array.isArray(entry.report.entries)),
  'readest_toc answers for every reader window',
  tocs.map((entry) => `${entry.label}: ${entry.report?.entries?.length ?? 'error'} entries`).join('; ') ||
    'no reader window with an open book',
);
// A book without a document outline (some PDFs) legitimately answers with page
// or section fallback anchors, so take the deepest *real* TOC any open book has,
// and its own chapter name as the search query — otherwise a zero-match reply
// would be a real failure.
const outlined =
  tocs.find((entry) => entry.report?.source === 'toc' && entry.report?.entries?.length) ??
  tocs.find((entry) => entry.report?.entries?.length);
const reader = outlined?.label;
const query =
  outlined?.report?.source === 'toc'
    ? /[A-Za-z]{4,}/.exec(outlined?.report?.entries?.[0]?.label ?? '')?.[0]
    : undefined;
if (reader && query) {
  const found = await report('readest_search', { window: reader, query, limit: 5 });
  check(
    found?.ok === true &&
      (found.matches?.length ?? 0) > 0 &&
      !!found.matches[0]?.cfi &&
      found.total >= found.matches.length,
    `readest_search ${reader} for "${query}" returns CFIs and a total`,
    `${found?.matches?.length ?? 0} of ${found?.total ?? '?'} matches${
      found?.matches?.[0]?.cfi ? `, first ${found.matches[0].cfi}` : ''
    }`,
  );
} else {
  console.log('skip readest_search: no open book has a chapter label to search for');
}
if (reader) {
  const settings = await report('readest_settings', { window: reader });
  const view = settings?.books?.[0]?.settings;
  check(
    settings?.ok === true && typeof view?.theme === 'string' && !!settings.global?.theme,
    `readest_settings ${reader} reports the effective view settings`,
    JSON.stringify({ theme: view?.theme, isEink: view?.isEink, fontSize: view?.defaultFontSize }),
  );
} else {
  console.log('skip readest_settings: no reader window with an open book');
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
