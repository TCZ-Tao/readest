# Testing

Readest uses several test tiers. Unit, browser, Tauri integration, and Android
device tests use [Vitest](https://vitest.dev/); full Tauri UI E2E uses
WebDriverIO with Mocha.

## Unit Tests (`pnpm test`)

Runs tests in a **jsdom** environment. No browser or Tauri runtime required.

```bash
pnpm test                                       # Run all unit tests
pnpm test -- src/__tests__/utils/misc.test.ts   # Run a single file
pnpm test -- --watch                            # Watch mode
```

- **Config:** `vitest.config.mts`
- **Pattern:** `src/**/*.test.ts` (excludes `*.browser.test.ts` and `*.tauri.test.ts`)
- **Environment:** jsdom
- **Use for:** Pure logic, utilities, services that don't need real browser APIs or Tauri IPC.

## Browser Tests (`pnpm test:browser`)

Runs tests in a **real Chromium** browser via Playwright. Required for code that depends on Web Workers, SharedArrayBuffer, OPFS, or other browser-only APIs.

```bash
pnpm test:browser
```

- **Config:** `vitest.browser.config.mts`
- **Pattern:** `src/**/*.browser.test.ts`
- **Browser:** Chromium (headless, via `@vitest/browser-playwright`)
- **Use for:** WASM modules (e.g. `@tursodatabase/database-wasm`), Web Worker integration such as bundled dictionary plugins, and browser-specific storage APIs.

## Tauri Integration Tests (`pnpm test:tauri`)

Runs Vitest tests **inside the Tauri WebView**, with access to Tauri IPC and native plugin commands. Tests execute in the actual app environment.

### Step 1: Start the Tauri App

In one terminal, start the app with the `webdriver` feature enabled:

```bash
pnpm tauri:dev:test     # Dev mode (uses tauri dev server, faster iteration)
pnpm tauri:build:test   # Debug release build (closer to production)
```

These commands compile the Rust backend with `--features webdriver`, which:

- Includes `tauri-plugin-webdriver` (embeds a W3C WebDriver server on port 4445)
- Adds a runtime capability granting plugin permissions to remote URLs (`http://127.0.0.1:*`), so Vitest's browser-mode iframe can call Tauri IPC

Keep this running while you run tests.

### Step 2: Run Tests

In another terminal:

```bash
pnpm test:tauri
```

Vitest connects directly to the embedded WebDriver server (port 4445) in the running Tauri app and executes tests inside its WebView.

- **Config:** `vitest.tauri.config.mts`
- **Pattern:** `src/**/*.tauri.test.ts`
- **Browser provider:** `@vitest/browser-webdriverio` (connects to port 4445)
- **Use for:** Tauri plugin commands (turso, native-tts, etc.), native filesystem, Tauri IPC.

### Writing Tauri Tests

Tests access Tauri IPC via a shared helper:

```typescript
import { invoke } from '../tauri/tauri-invoke';

it('calls a plugin command', async () => {
  const result = await invoke('plugin:turso|load', { options: { path: 'sqlite::memory:' } });
  expect(result).toBeDefined();
});
```

The `invoke()` helper accesses `window.top.__TAURI_INTERNALS__` (Vitest runs in an iframe, Tauri injects IPC into the main frame).

**Limitations:** Only custom invoke commands and plugin commands listed in the webdriver capability work. Standard Tauri JS APIs (e.g. `@tauri-apps/api`) that rely on `URL: local` may not work from the Vitest iframe.

## Android Device E2E (`pnpm test:android`)

Drives the **installed Readest app** on an adb-connected Android device or
emulator: gestures are injected with `adb shell input`, and the app's state is
probed through the WebView's **Chrome DevTools Protocol** (forwarded from the
`webview_devtools_remote_<pid>` abstract socket). This is the only lane that
exercises real Android touch selection, native handle behavior, and page-turn
gestures (e.g. the issue #1553 hyphen-selection fixes).

```bash
# One-time: install a dev build on the device/emulator
pnpm dev-android

# Start an emulator if no device is attached (see `emulator -list-avds`)
emulator -avd Pixel_9_Pro &

# Run the lane (soft-skips when no adb/device/app is available)
pnpm test:android

# With several devices attached, pick one:
ANDROID_SERIAL=emulator-5554 pnpm test:android
```

- **Config:** `vitest.android.config.mts` (node environment, serial execution, `retry: 1`)
- **Pattern:** `src/**/*.android.test.ts`
- **Helpers:** `src/__tests__/android/helpers/` — `adb.ts` (gestures), `cdp.ts` (DevTools client), `reader.ts` (app-level probes)
- **Fixtures:** plain EPUBs from `src/__tests__/fixtures/data/` (e.g. `sample-alice.epub`), opened transiently via a `VIEW` intent so the device library is never modified
- **Use for:** native text selection, touch gestures, selection handles, anything that only reproduces in the Android WebView compositor.

### Conventions

- **Probe, don't hardcode:** locate words/handles at runtime via CDP and derive
  device pixels from `devicePixelRatio` — never bake in coordinates.
- **Poll, don't sleep:** use `waitFor()` on an observable condition (selection
  state, handle count, frame position); reserve fixed pauses for gesture
  pacing (long-press hold, corner dwell).
- **Discover, don't assume:** the harness finds a hyphenated on-screen
  paragraph at runtime and derives every gesture target from live layout, so
  any English fixture works regardless of fonts or screen size (hyphenation
  is on by default in the app).
- **Serial only:** one device, one app — the config disables parallelism.

### CI

`.github/workflows/android-e2e.yml` runs the lane on an x86_64 emulator
(ubuntu runner with KVM): it builds a **debug** APK for `x86_64` (no signing
secrets needed), boots a cached AVD via `reactivecircus/android-emulator-runner`,
installs the APK, and runs `pnpm test:android`. It is intentionally not
PR-blocking — it runs nightly, on `workflow_dispatch`, or when a PR gets the
`e2e-android` label.

## E2E Tests (WDIO)

Full end-to-end tests using WebDriverIO, for UI-level testing against the running Tauri app. Same two-step workflow as Tauri integration tests.

```bash
# Terminal 1: start the app (same as for Tauri integration tests)
pnpm tauri:dev:test

# Terminal 2: run E2E tests
pnpm test:e2e
```

- **Config:** `wdio.conf.ts`
- **Pattern:** `e2e/**/*.e2e.ts`
- **Framework:** Mocha (via `@wdio/mocha-framework`)
- **Connects to:** port 4445 (embedded WebDriver server)
- **Use for:** UI interaction tests, window management, navigation flows.

## Debugging the Linux CEF Build (CDP)

The Linux CEF runtime is Chromium, so the app window is a normal Chrome DevTools
Protocol target — the same interface Chrome, Playwright and Puppeteer speak. This
is the only way to inspect the running desktop app on Linux (WebKitWebDriver, used
by `pnpm tauri:dev:test`, drives the wry runtime instead).

```bash
# Terminal 1: dev build with the CDP endpoint on 127.0.0.1:9222
pnpm tauri:dev:cdp

# Terminal 2
pnpm cdp targets                                     # list debuggable targets
pnpm cdp eval 'document.title'                       # run JS in the app window
pnpm cdp eval 'window.__TAURI_INTERNALS__.invoke("plugin:app|version")'
pnpm cdp click 'button[aria-label="Import Books"]'   # real pointer events
pnpm cdp screenshot /tmp/library.png
pnpm cdp logs 30                                     # tail the app console
```

`pnpm tauri:dev:cdp` is `pnpm tauri dev` with `READEST_CDP_PORT=9222`. Any CEF
build honours that variable — a packaged `.deb`, the Flatpak, or `tauri build`
output — so the same tooling works against release binaries:

```bash
READEST_CDP_PORT=9222 readest
CDP_PORT=9222 pnpm cdp targets
```

`scripts/cdp.mjs` is dependency-free (node's global `fetch` and `WebSocket`); the
endpoint listens on loopback only. For anything richer, connect a real client to
the same port — `chrome://inspect` in a local Chrome, or
`chromium.connectOverCDP('http://127.0.0.1:9222')`.

### Limits

- **The IPC bridge cannot be stubbed.** `window.__TAURI_INTERNALS__.invoke` is
  defined non-writable and non-configurable, so assigning over it from `eval`
  fails silently and the real command still runs. You can *call* it, not fake it.
- **Native dialogs are outside the page.** The file picker is an XDG portal
  window (`org.gnome.Nautilus` on GNOME), not a CEF surface, so CDP cannot see or
  click it. Driving an import end-to-end needs X11 input (XTEST via python-xlib:
  focus the chooser, `Ctrl+L`, type the path, `Return` to select, `Return` to
  open) — or skip the picker and dispatch the app's own `import-book-files` event.
- **Passing `--remote-debugging-port` on argv works too**, but `tauri-plugin-cli`
  parses the same argv for open-with paths and warns on every launch. Prefer the
  env var.

## crengine XPointer Oracle (KOReader sync)

KOReader stores positions as crengine XPointers; `src/utils/xcfi.ts` converts them to and from
CFIs. The only trustworthy reference for what crengine emits is crengine itself, so
`apps/readest.koplugin/scripts/xpointer-oracle.lua` runs headlessly inside a KOReader emulator
build and dumps crengine's XPointer pair and text for every visible word of an EPUB:

```bash
cd <koreader-emulator>/koreader
KO_HOME=/tmp/ko-oracle ./luajit /path/to/readest/apps/readest.koplugin/scripts/xpointer-oracle.lua \
  /path/to/book.epub /path/to/book.crengine.json 40   # keep one word in 40
```

`src/__tests__/utils/xcfi.crengine-oracle.test.ts` then checks both sync directions for every
sampled word: crengine's pointers must resolve to exactly that word, and a highlight on that word
must convert back to exactly crengine's pointers. Committed fixtures live in
`src/__tests__/fixtures/crengine/` (generated from EPUBs under `fixtures/data/`). To validate a
local book that cannot be committed:

```bash
XPOINTER_ORACLE=/path/to/book.crengine.json pnpm test src/__tests__/utils/xcfi.crengine-oracle.test.ts
```

The JSON's `epub` field is an absolute path or a file next to the JSON. The emulator is a local
build (`kodev` in a KOReader checkout); nothing in CI needs it.

## Debug MCP (in-app, dev builds)

Desktop debug builds compile a debug HTTP server into the app
(`src-tauri/src/debug_server.rs`); release builds never contain it (the module is
gated on `debug_assertions`, not on a cargo feature). It exposes state invisible
from outside a running Tauri app, both as plain JSON endpoints and as an MCP
server any MCP client can attach to, plus a few *actions* so an AI can close the
edit → reload → screenshot loop without a human in it.

Turn it on in **Settings → Misc → Developer → "MCP Debug Server"** (persisted as
`debugMcpEnabled` in `settings.json`; off by default, so normal dev runs open no
port). The section shows the client config to paste — no wrapper process, no
per-client registration script:

```json
{
  "type": "http",
  "url": "http://127.0.0.1:9339/mcp",
  "headers": { "Authorization": "Bearer <token>" }
}
```

- Binds `127.0.0.1:9339` (override with `READEST_DEBUG_PORT`); every request needs
  `Authorization: Bearer <token>`
- The token is generated once and persisted to
  `%APPDATA%\com.bilingify.readest\debug-mcp-token`, so a client configured once
  keeps working across app restarts
- Enabling also writes `{port, token, pid}` to
  `%LOCALAPPDATA%\com.bilingify.readest\logs\debug-mcp.json` for out-of-process tools
- Closing an EPUB window must still flush probes: the reader window reports on
  `pagehide` / `visibilitychange`, so `readest_state` reflects the last frame even
  for a window that is gone

| Endpoint              | Returns                                                                    |
| --------------------- | -------------------------------------------------------------------------- |
| `GET /health`         | pid, uptime, app version (also verifies the bearer token)                   |
| `GET /state`          | window list (label/title/URL), books per reader window (`?ids=`), per-window JS snapshots (open books + live progress, the library's `{hash,title}` list, and `boot` — `performance.timeOrigin`, so a reload is visible as a boot change) |
| `GET /logs?n=200`     | browser-console tail across all windows (labelled); narrow it with `since=&window=&level=&grep=` (the same filters as `readest_logs`, taken verbatim from the query string) |
| `GET /events?since=0` | window lifecycle events (close_requested/destroyed/focused/blurred), incremental ids |
| `POST /mcp`           | MCP Streamable HTTP: `initialize`, `notifications/initialized`, `tools/list`, `tools/call` (JSON-RPC 2.0; sessions via `Mcp-Session-Id`, `GET /mcp` keepalive stream, `DELETE /mcp` closes a session) |
| `GET /mcp`            | `text/event-stream` keepalive for clients that open the server→client stream |

The state tools are `readest_state`, `readest_logs {n, since?, window?, level?,
grep?}` (the filters AND together; `level` is a minimum severity, `grep` a
case-insensitive substring), and `readest_events {since}` — the same three
payloads as the JSON endpoints. Three more readers answer from the window rather
than from Rust, so they ride the action channel below without changing anything:
`readest_settings {window}` (the effective view settings: the global defaults plus
each open book's merged overrides — deliberately only `ViewSettings`, never
`SystemSettings`, which holds credentials), `readest_toc {window, hash?}` (the
parsed TOC: `label`/`href`/`cfi` per entry, plus the 1-based `page` on
fixed-layout books, truncated at 300 entries) and `readest_search {window, hash?,
query, limit?}` (literal case-insensitive matches over the live book DOM, each with
its CFI and an excerpt — no search index, so a long book takes seconds and Rust
allows 30s; it clears the previous search highlights the way the in-app search
does, and its own before returning).

### Action tools

| Tool                          | Does                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| `readest_open_book {hashes}`  | Focus the reader window that already holds a single hash, else open one. Waits for the new window to appear and returns its label as `window` |
| `readest_goto {window, hash?, cfi?, page?}` | Move that reader window's view to a CFI/href or a 1-based page (the footer's own page-input path — `pageinfo` is section-local on reflowable books, so pass `cfi` when the exact spot matters). Waits inside the window for the book to load (and for its page count when jumping by page); a window that is not a reader route, does not hold the book, or whose load reported an error is rejected immediately |
| `readest_reload {window?}`    | Reload that window, or every window when `window` is omitted    |
| `readest_wait {window, until, hash?, timeout_ms?}` | Block until the window is usable: `until: 'ready'` means its JS answers (after a reload, the fresh document; returns its `boot`), `until: 'book-loaded'` means the book has loaded — the same readiness `readest_goto` waits for, which is what lets a caller give a slow book a longer budget than the actions' own 8s |
| `readest_close_window {window}` | Close that window through its own close path (the title-bar ✕: `tauriHandleClose`, which saves the reading position and tells the library window). Closing the last window can end the process |
| `readest_click {window, selector?}` / `readest_click {window, x, y}` | Focus and click the way a user click reaches the app: `selector` is searched in the window's own document and then in the open book's own document(s) (so footnote links and paragraphs are reachable); `x`/`y` are pixel coordinates in the window's most recent `readest_screenshot`, converted back to CSS pixels on the Rust side (undoing an iframe's transform inside the book). The reply names what was clicked and which document it was found in; a selector that matches nothing comes back with the window's visible interactive elements to pick from |
| `readest_press {window, key, modifiers?}` | Press one key through the app's own shortcut layer (`useShortcuts`, the same one real key presses reach). `handled` says whether a shortcut claimed it. Modifiers are `ctrl`/`alt`/`shift`/`meta`; a misspelt one is rejected rather than silently dropping to the bare key |
| `readest_screenshot {window, wait_for_stable?}` | PNG of the window's rendered content, as MCP image content, plus a text part with the frame's `sha256`, byte count, and pixel/CSS size — equal hashes mean "nothing changed on screen". `wait_for_stable` waits for the window's JS, then keeps capturing until two consecutive frames are identical (~8s cap), so a post-reload shot is not a half-loaded frame |
| `readest_settings {window}`   | Read-only: the view settings actually in effect (global defaults + each open book's merged overrides) |
| `readest_toc {window, hash?}` | Read-only: the parsed TOC with `label`/`href`/`cfi` (and `page` on fixed-layout books), both of which `readest_goto` accepts |
| `readest_search {window, hash?, query, limit?}` | Read-only: literal, case-insensitive text search over the open book, returning each match's CFI and excerpt |

Rust sends each action to the named webview as a `debug://action` event
(served by `src/services/debugReport.ts`), the window runs it and reports back
through `debug_action_result`; a window that never answers times out instead of
hanging the tool call. `readest_open_book` / `readest_goto` bound their own waits
in the frontend (8s, under the default 10s transport timeout) so a book that
never loads reports *why* rather than making the caller retry; `readest_wait`
instead carries a per-dispatch deadline (`Plan::Frontend.timeout`) taken from the
caller's `timeout_ms`, and the frontend's share of it is 1s less (the transport
keeps a further 5s of slack, since a window mid-reload may only see the action
seconds after the call started), so the reason still comes from the frontend. `readest_click` and `readest_press` drive the real
UI — a click goes in as a focus plus a `click` event (by selector, in the
window's or the book's document; by x/y, via `elementFromPoint`), a press as a
`keydown` on
whichever element a real keystroke would target, both synthetic
(`isTrusted: false`; nothing in the app checks that flag). Reload goes through
the app's own `beforereload` chain so reading positions are saved first, and
`readest_open_book` / `readest_goto` reuse `showReaderWindow` /
`focusExistingReaderWindow` and the reader's own `view.goTo`
— the UI's code paths, not a parallel implementation of them.

Three traps worth remembering when touching this wiring:

- Tauri's `emit_to(label, …)` only narrows JS listeners that registered a label;
  a default `listen()` targets `Any` and therefore receives events aimed at *any*
  window, so `listenForActions` passes `{ target: getCurrentWindow().label }`.
  Without it one `readest_open_book` runs in every open window.
- Registration is guarded both in module state and on `window`, because a
  StrictMode double effect or a Fast Refresh re-run otherwise adds a second
  action listener — and one dispatch would then open a window per listener.
- Tauri events are fire-and-forget: an action sent to a window whose listener is
  not registered yet (still mounting, or just started reloading) is dropped. So
  `dispatch_action` re-sends the same id every second until it is answered, and
  the frontend claims the id before its first `await` so a repeat cannot run an
  action twice.

`readest_screenshot` is Windows-only: it calls WebView2's
`ICoreWebView2::CapturePreview` through `with_webview`, because WebView2 renders
through DirectComposition and OS-level window capture returns a blank client
area. On other platforms the tool reports that it is unsupported.

Verified against the official SDK client (`pnpm exec node scripts/mcp-parity.mjs
<token>` while the app runs with the server on): initialize/tools-list/three
state tool calls, the action tools' argument errors (including the three readers'
parameter and non-reader-route rejections), one PNG screenshot, plus a
wrong-token rejection; with a book open it also reads that book's TOC, searches
its first chapter's label, and reads the window's effective settings. The mutating
action tools were driven live once:
`readest_open_book` added exactly one reader window, `readest_goto` moved the
view (fraction and CFI both changed), `readest_reload` changed the window's
`boot`, and a one-line style edit plus reload produced a different screenshot
byte-for-byte.

The Chinese companion doc — mechanism, how to add a tool, troubleshooting, and the
boundaries this channel deliberately keeps — is [docs/debug-mcp.zh-CN.md](../../docs/debug-mcp.zh-CN.md).

### Driving the UI on Windows

`pnpm tauri:dev:cdp` (CDP) only exists on the Linux CEF build, and on Windows a WebView2
`--remote-debugging-port` cannot be applied uniformly — browser-process arguments are fixed by
the first webview and JS-created reader windows would fail with mismatched args. To drive the
UI on Windows use the WebDriver lane (`--features webdriver`, port 4445, see E2E above), or the
OS itself: launching the exe with a book path as argv opens it in the running instance
(single-instance forwarding), and PowerShell `(Get-Process Readest).MainWindowHandle` +
`CloseMainWindow()` delivers a real WM_CLOSE.

## Test File Naming

| Suffix              | Runner              | Environment           |
| ------------------- | ------------------- | --------------------- |
| `*.test.ts`         | `pnpm test`         | jsdom                 |
| `*.browser.test.ts` | `pnpm test:browser` | Chromium (Playwright) |
| `*.tauri.test.ts`   | `pnpm test:tauri`   | Tauri WebView         |
| `*.e2e.ts`          | `pnpm test:e2e`     | Tauri app (WDIO)      |
| `*.android.test.ts` | `pnpm test:android` | Android device (CDP)  |
