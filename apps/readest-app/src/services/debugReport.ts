// Dev-only debug reporting for the in-app debug server
// (src-tauri/src/debug_server.rs). The pushes below are what the /state and
// /logs endpoints serve, and the action listener at the bottom is the other
// direction: the `readest_open_book` / `readest_goto` / `readest_reload` MCP
// tools arrive as an event for the window they name, run here, and report back.
// Self-gating: the probe invoke only resolves when the debug server is compiled
// in (desktop debug builds), so normal builds turn this into a no-op without any
// injected flag — which matters because JS-created windows (reader-*) don't
// receive the main window's initialization script. `initDebugServer`
// additionally mirrors the `debugMcpEnabled` setting onto the Rust listener, so
// the MCP endpoint follows that setting in both directions (boot restore and
// every later toggle).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import envConfig, { isTauriAppPlatform } from '@/services/environment';
import { useReaderStore } from '@/store/readerStore';
import { getBookProgress, useReaderProgressStore } from '@/store/readerProgressStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { focusExistingReaderWindow, showReaderWindow } from '@/utils/nav';
import { clampPage, fractionForPage } from '@/app/reader/components/footerbar/pageJump';

const CONSOLE_FLUSH_INTERVAL_MS = 500;
const STATE_INTERVAL_MS = 2000;
const CONSOLE_BUFFER_LIMIT = 500;
/// Matches ACTION_EVENT in src-tauri/src/debug_server.rs.
const ACTION_EVENT = 'debug://action';

let initialized = false;
let debugServerWired = false;

declare global {
  interface Window {
    /// Set by `listenForActions`: Fast Refresh re-evaluates this module (and
    /// re-runs the effects that call `initDebugReporting`), so the one-listener
    /// guard has to live on the document, not in module state.
    __readestDebugActionListener?: boolean;
  }
}

export interface DebugServerStatus {
  enabled: boolean;
  port: number | null;
  url: string | null;
  token: string;
  token_path: string | null;
}

/// Status of the in-app MCP debug server, or null when this build has none
/// (release builds omit the command entirely).
export const getDebugServerStatus = async (): Promise<DebugServerStatus | null> => {
  try {
    return await invoke<DebugServerStatus>('debug_server_status');
  } catch {
    return null;
  }
};

export const setDebugServerEnabled = async (enabled: boolean): Promise<void> => {
  await invoke('debug_server_set_enabled', { enabled });
};

/**
 * Follows `settings.debugMcpEnabled` into the Rust listener. Subscribing (rather
 * than a one-shot read) keeps boot restore and the settings toggle on one code
 * path, and the subscription's immediate first fire makes the boot case free.
 * Never rejects: a build without the command simply leaves the server off.
 */
export const initDebugServer = (): void => {
  if (debugServerWired || !isTauriAppPlatform()) return;
  debugServerWired = true;
  useSettingsStore.subscribe(({ settings }) => {
    void setDebugServerEnabled(!!settings.debugMcpEnabled).catch(() => {});
  });
};

const formatArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
};

const buildSnapshot = () => {
  const { bookKeys } = useReaderStore.getState();
  const { progresses } = useReaderProgressStore.getState();
  const { library, getBookByHash } = useLibraryStore.getState();
  const books = bookKeys.map((key) => {
    const hash = key.split('-')[0]!;
    const progress = progresses[key] ?? null;
    return {
      hash,
      title: getBookByHash(hash)?.title ?? null,
      fraction: progress?.fraction ?? null,
      location: progress?.location ?? null,
      section: progress?.sectionLabel ?? null,
      page: progress?.pageinfo
        ? `${progress.pageinfo.current + 1}/${progress.pageinfo.total}`
        : null,
    };
  });
  return {
    label: getCurrentWindow().label,
    path: window.location.pathname + window.location.search,
    title: document.title,
    books,
    // Hashes for `readest_open_book` to name: without them the tool is only
    // usable for books that are already open somewhere.
    library: library.map(({ hash, title }) => ({ hash, title })),
    // When this document was loaded: comparing it across snapshots is how a
    // `readest_reload` is seen to have actually taken effect.
    boot: Math.round(performance.timeOrigin),
    ts: Date.now(),
  };
};

export const initDebugReporting = async () => {
  if (initialized || !isTauriAppPlatform()) return;
  // Claimed before the probe: callers run concurrently (a StrictMode double
  // effect, a Fast Refresh re-run) and a second pass would register a second
  // action listener — one `readest_open_book` would then open several windows.
  initialized = true;
  // Probe doubles as the first push; rejection = debug server not compiled in.
  try {
    await invoke('debug_report_state', { payload: buildSnapshot() });
  } catch {
    initialized = false;
    return;
  }

  // The console tail rides through an invoke batch so a chatty page doesn't
  // spam the IPC channel; entries beyond the local cap are dropped oldest-first.
  const pending: { ts: number; level: string; text: string }[] = [];
  const flushConsole = () => {
    if (!pending.length) return;
    const entries = pending.splice(0, pending.length);
    invoke('debug_console_log', { entries }).catch(() => {});
  };
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      pending.push({ ts: Date.now(), level, text: args.map(formatArg).join(' ') });
      if (pending.length > CONSOLE_BUFFER_LIMIT) {
        pending.splice(0, pending.length - CONSOLE_BUFFER_LIMIT);
      }
      original(...args);
    };
  }
  setInterval(flushConsole, CONSOLE_FLUSH_INTERVAL_MS);

  const pushState = () => {
    invoke('debug_report_state', { payload: buildSnapshot() }).catch(() => {});
  };
  setInterval(pushState, STATE_INTERVAL_MS);
  window.addEventListener('pagehide', pushState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      pushState();
      flushConsole();
    }
  });

  listenForActions();
};

// ── Actions (Rust → this window) ────────────────────────────────────────────

interface DebugAction {
  kind: 'open-book' | 'goto' | 'reload';
  hashes?: string[];
  hash?: string;
  cfi?: string;
  page?: number;
}

/// An action's report, plus work that must not start until Rust has it: a
/// reload tears the page down, so it can only run after the result is delivered.
interface ActionOutcome {
  result: Record<string, unknown>;
  after?: () => void;
}

const findBookKey = (hash?: string): string | null => {
  const { bookKeys } = useReaderStore.getState();
  if (!hash) return bookKeys[0] ?? null;
  return bookKeys.find((key) => key.split('-')[0] === hash) ?? null;
};

const runDebugAction = async (action: DebugAction): Promise<ActionOutcome> => {
  const fail = (error: string): ActionOutcome => ({ result: { ok: false, error } });
  switch (action.kind) {
    case 'open-book': {
      // Same entry points the library uses, so an already-open book is focused
      // instead of duplicated in a second window.
      const hashes = action.hashes ?? [];
      if (!hashes.length) return fail('open-book needs at least one book hash');
      if (hashes.length === 1 && (await focusExistingReaderWindow(hashes[0]!))) {
        return { result: { ok: true, focused: hashes[0] } };
      }
      showReaderWindow(await envConfig.getAppService(), hashes);
      return { result: { ok: true, opened: hashes } };
    }
    case 'goto': {
      const key = findBookKey(action.hash);
      if (!key) return fail('no book is open in this window');
      const view = useReaderStore.getState().getView(key);
      // The view only registers once the book has loaded, while a freshly
      // opened window already reports the book it is about to show.
      if (!view) return fail(`book ${key.split('-')[0]} is still loading in this window`);
      // The published `FoliateView` type calls goTo void-returning, but the
      // wrapped view returns the navigation promise (see types/view.ts).
      if (action.cfi) {
        await Promise.resolve(view.goTo(action.cfi));
        return { result: { ok: true, book: key, cfi: action.cfi } };
      }
      if (typeof action.page !== 'number') return fail('goto needs cfi or page');
      const progress = getBookProgress(key);
      const pageInfo = view.isFixedLayout ? progress?.section : progress?.pageinfo;
      if (!pageInfo?.total) return fail('this book has no page count yet');
      const page = clampPage(action.page, pageInfo.total);
      if (view.isFixedLayout) await Promise.resolve(view.goTo(page - 1));
      else await Promise.resolve(view.goToFraction(fractionForPage(page, pageInfo.total)));
      return { result: { ok: true, book: key, page } };
    }
    case 'reload': {
      // The app's own reload chain (ReaderContent listens for `beforereload`),
      // so books are saved and closed before the page goes away.
      await eventDispatcher.dispatch('beforereload');
      return { result: { ok: true, reloading: true }, after: () => window.location.reload() };
    }
  }
};

const listenForActions = (): void => {
  if (window.__readestDebugActionListener) return;
  window.__readestDebugActionListener = true;
  // Scope the listener to this window: an event emitted to one label still
  // reaches every window whose listener targets `Any` (Tauri's `emit_to` only
  // narrows listeners that name a label), which would run each action in every
  // open window.
  const target = getCurrentWindow().label;
  void listen<{ id: string; action: DebugAction }>(
    ACTION_EVENT,
    async ({ payload }) => {
      const outcome = await runDebugAction(payload.action).catch(
        (error: unknown): ActionOutcome => ({ result: { ok: false, error: String(error) } }),
      );
      // Report before running `after`: a reload drops the in-flight call.
      await invoke('debug_action_result', { id: payload.id, result: outcome.result }).catch(
        () => {},
      );
      outcome.after?.();
    },
    { target },
  );
};
