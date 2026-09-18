// Dev-only debug reporting for the in-app debug server
// (src-tauri/src/debug_server.rs). The pushes below are what the /state and
// /logs endpoints serve, and the action listener at the bottom is the other
// direction: the action MCP tools (readest_open_book, readest_goto, readest_click,
// readest_press, ...) arrive as an event for the window they name, run here, and
// report back.
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
import type { TOCItem } from '@/libs/document';
import type { SearchExcerpt } from '@/types/book';
import envConfig, { isTauriAppPlatform } from '@/services/environment';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { getBookProgress, useReaderProgressStore } from '@/store/readerProgressStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { focusExistingReaderWindow, showReaderWindow } from '@/utils/nav';
import { tauriHandleClose } from '@/utils/window';
import { clampPage, fractionForPage } from '@/app/reader/components/footerbar/pageJump';

const CONSOLE_FLUSH_INTERVAL_MS = 500;
const STATE_INTERVAL_MS = 2000;
const CONSOLE_BUFFER_LIMIT = 500;
/// An action that needs the window to catch up (a reader window the app is
/// still creating, a book still loading) waits here instead of failing, so the
/// caller does not have to retry. Kept under ACTION_TIMEOUT in
/// src-tauri/src/debug_server.rs, so a window that never gets there reports its
/// own reason instead of the transport timing out first.
const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 200;
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
    /// Action ids this window has already taken. Rust re-sends an action until
    /// it hears back (see `dispatch_action`), so the same id can arrive twice.
    __readestDebugHandledActions?: Set<string>;
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
  const { getBookData } = useBookDataStore.getState();
  const books = bookKeys.map((key) => {
    const hash = key.split('-')[0]!;
    const progress = progresses[key] ?? null;
    // The page number the footer shows, which is also what `readest_goto`'s
    // `page` means: fixed-layout books count the book's own pages (`section`),
    // reflowable ones `pageinfo`. Same choice setProgress makes (readerStore).
    const pageInfo = getBookData(key)?.isFixedLayout ? progress?.section : progress?.pageinfo;
    return {
      hash,
      title: getBookByHash(hash)?.title ?? null,
      fraction: progress?.fraction ?? null,
      location: progress?.location ?? null,
      section: progress?.sectionLabel ?? null,
      page: pageInfo ? `${pageInfo.current + 1}/${pageInfo.total}` : null,
    };
  });
  return {
    label: getCurrentWindow().label,
    path: window.location.pathname + window.location.search,
    title: document.title,
    books,
    // CSS viewport, the denominator when a screenshot's pixel size is turned
    // into a scale for coordinate clicks (the Rust side keeps the pair).
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
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
  kind:
    | 'open-book'
    | 'goto'
    | 'reload'
    | 'wait'
    | 'close'
    | 'click'
    | 'press'
    | 'settings'
    | 'toc'
    | 'search';
  hashes?: string[];
  hash?: string;
  cfi?: string;
  page?: number;
  until?: 'ready' | 'book-loaded';
  /// The frontend's own deadline for a `wait`, already reduced by the Rust
  /// side's WAIT_MARGIN_MS (the transport waits for the full budget).
  timeoutMs?: number;
  selector?: string;
  key?: string;
  modifiers?: string[];
  query?: string;
  limit?: number;
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

/// Polls `probe` until it reports something, or throws. Probes are in-process
/// reads (stores, one Rust lookup), so a plain interval is enough; the point is
/// that the caller gets one answer instead of a "not ready yet" to retry.
const waitFor = async <T>(
  probe: () => T | null | Promise<T | null>,
  what: string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
};

/// The key of the book an action targets in this window, once the window can
/// have one. Two ways it never will, both worth failing immediately instead of
/// spending the whole wait budget: the window is not on a reader route at all,
/// or its book set — seeded whole from the route's `?ids=` before anything loads
/// — does not include ours.
const waitForBookKey = (hash: string | undefined, timeoutMs?: number) =>
  waitFor(
    () => {
      const { bookKeys } = useReaderStore.getState();
      if (!window.location.pathname.startsWith('/reader')) {
        throw new Error(
          `no book is open in this window: ${window.location.pathname} is not a reader route`,
        );
      }
      if (hash && bookKeys.length && !findBookKey(hash)) {
        throw new Error(`book ${hash} is not open in this window`);
      }
      return findBookKey(hash);
    },
    'a book to be open in this window',
    timeoutMs,
  );

/// The loaded view of `key`. The view only registers once its document is open,
/// and reports `inited` once it has loaded and been placed — the point a `goTo`
/// lands. Same readiness the app's own waits use (see `goToCfiWhenReady` in
/// useBooksManager): a load that failed is over, not "not yet".
const waitForView = (key: string, timeoutMs?: number) =>
  waitFor(
    () => {
      const viewState = useReaderStore.getState().getViewState(key);
      if (viewState?.error) {
        throw new Error(`book ${key.split('-')[0]} failed to load: ${viewState.error}`);
      }
      return viewState?.inited ? viewState.view : null;
    },
    `book ${key.split('-')[0]} to finish loading in this window`,
    timeoutMs,
  );
/// What was hit by a click, or what a failed click could have aimed at.
const describeElement = (element: HTMLElement) => ({
  tag: element.tagName.toLowerCase(),
  text: element.textContent?.trim().slice(0, 60) || undefined,
  testid: element.dataset['testid'],
  ariaLabel: element.getAttribute('aria-label') ?? undefined,
});

/// The window's visible interactive elements, in document order. Without a DOM
/// viewer this is what turns "nothing matches that selector" into a selector the
/// caller can actually use.
const interactiveElements = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      'button,a,[role],summary,input,select,textarea,[data-testid]',
    ),
  )
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    })
    .slice(0, 25)
    .map(describeElement);

/// Entries a `readest_toc` reply may carry across all nesting levels. Some books
/// have thousands and every one of them is paid for by the caller's context.
const MAX_TOC_ITEMS = 300;

interface TocEntry {
  label: string;
  href: string;
  cfi?: string;
  /// 1-based page number, fixed-layout books only: their TOC items carry the
  /// page index (`TOCItem.index` is documented for PDF). Reflowable books have
  /// no page identity to attach, so the field is absent there.
  page?: number;
  subitems?: TocEntry[];
}

/// Depth-first copy of the TOC, keeping only what a caller can act on, and
/// stopping once `budget` is spent (`dropped` then says so).
const tocEntries = (
  items: TOCItem[],
  isFixedLayout: boolean,
  budget: { left: number; dropped: boolean },
): TocEntry[] => {
  const entries: TocEntry[] = [];
  for (const item of items) {
    if (budget.left <= 0) {
      budget.dropped = true;
      break;
    }
    budget.left -= 1;
    entries.push({
      label: item.label,
      href: item.href,
      cfi: item.cfi,
      // A fixed-layout item only has a page when the book's own outline pointed
      // at one (pdf.js leaves `index` undefined for a destination it could not
      // resolve), so do not turn that into a `null` page.
      page: isFixedLayout && typeof item.index === 'number' ? item.index + 1 : undefined,
      subitems: item.subitems ? tocEntries(item.subitems, isFixedLayout, budget) : undefined,
    });
  }
  return entries;
};

const runDebugAction = async (action: DebugAction): Promise<ActionOutcome> => {
  const fail = (error: string, extra?: Record<string, unknown>): ActionOutcome => ({
    result: { ok: false, error, ...extra },
  });
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
      // The window is created by the Rust side, and only then does it carry the
      // `?ids=` that names its book. Waiting for it here is what lets the reply
      // name the window, so the caller can go straight on to goto/screenshot.
      const window = await waitFor(
        () => invoke<string | null>('find_reader_window_with_book', { hash: hashes[0]! }),
        `the reader window for ${hashes[0]} to appear`,
      );
      return { result: { ok: true, opened: hashes, window } };
    }
    case 'goto': {
      const key = await waitForBookKey(action.hash);
      const view = await waitForView(key);
      // The published `FoliateView` type calls goTo void-returning, but the
      // wrapped view returns the navigation promise (see types/view.ts).
      if (action.cfi) {
        await Promise.resolve(view.goTo(action.cfi));
        return { result: { ok: true, book: key, cfi: action.cfi } };
      }
      if (typeof action.page !== 'number') return fail('goto needs cfi or page');
      // The page count lands after the load: on a reflowable book from
      // `pageinfo`, on a fixed-layout one from `section`.
      const pageInfo = await waitFor(
        () => {
          const progress = getBookProgress(key);
          const info = view.isFixedLayout ? progress?.section : progress?.pageinfo;
          return info?.total ? info : null;
        },
        `book ${key.split('-')[0]} to report a page count`,
      );
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
    case 'wait': {
      // Reaching this line at all means the dispatch found a live listener —
      // Rust re-sends until one answers — so `ready` is answered by the fact
      // that we are running. `boot` is reported so a caller can tell this
      // document apart from the one it reloaded.
      const label = getCurrentWindow().label;
      const boot = Math.round(performance.timeOrigin);
      if (action.until !== 'book-loaded') return { result: { ok: true, window: label, boot } };
      // Same readiness `goto` waits for, so the two cannot disagree about what
      // "loaded" means — only the budget differs.
      const key = await waitForBookKey(action.hash, action.timeoutMs);
      await waitForView(key, action.timeoutMs);
      return { result: { ok: true, window: label, book: key, loaded: true } };
    }
    case 'close': {
      // The title-bar ✕ path, so the reading position is saved on the way out
      // (`handleCloseBooks` in ReaderContent); a bare Tauri close skips that.
      // Report first — closing takes the JS context with it.
      return { result: { ok: true, closing: true }, after: () => void tauriHandleClose() };
    }
    case 'settings': {
      // The settings the reader is actually rendering with: `getViewSettings`
      // is the global defaults merged with the book's own overrides, built by
      // readerStore when the book opens. Nothing here comes from
      // `SystemSettings`, which holds credentials.
      const { bookKeys, getViewSettings } = useReaderStore.getState();
      return {
        result: {
          ok: true,
          window: getCurrentWindow().label,
          global: useSettingsStore.getState().settings.globalViewSettings ?? null,
          books: bookKeys.map((key) => ({
            hash: key.split('-')[0],
            settings: getViewSettings(key),
          })),
        },
      };
    }
    case 'toc': {
      const key = await waitForBookKey(action.hash);
      await waitForView(key);
      // bookDoc.toc is the nav the reader itself navigates by: each item's cfi
      // is baked there (hydrateBookNav), and href is what the sidebar passes on.
      const bookData = useBookDataStore.getState().getBookData(key);
      const budget = { left: MAX_TOC_ITEMS, dropped: false };
      const entries = tocEntries(bookData?.bookDoc?.toc ?? [], !!bookData?.isFixedLayout, budget);
      return { result: { ok: true, book: key, entries, truncated: budget.dropped } };
    }
    case 'search': {
      const key = await waitForBookKey(action.hash);
      const view = await waitForView(key);
      const limit = action.limit ?? 20;
      const matches: { cfi: string; chapter: string; excerpt: SearchExcerpt }[] = [];
      try {
        // Book scope over the live DOM: no index, no worker, but each match
        // comes back as a CFI already (`#toSearchMatch`), which is the point.
        for await (const item of view.search({
          scope: 'book',
          mode: 'contains',
          matchCase: false,
          matchDiacritics: false,
          query: action.query!,
        })) {
          // The only string this generator yields is 'done'.
          if (typeof item === 'string') break;
          for (const match of item.subitems ?? []) {
            if (matches.length >= limit) break;
            matches.push({ cfi: match.cfi, chapter: item.label, excerpt: match.excerpt });
          }
          if (matches.length >= limit) break;
        }
      } finally {
        // `view.search` paints its matches into the book as highlights. A read
        // must leave the window as it found it — the CFIs survive the clear.
        view.clearSearch();
      }
      return {
        result: {
          ok: true,
          book: key,
          query: action.query,
          matches,
          truncated: matches.length >= limit,
        },
      };
    }
    case 'click': {
      const element = document.querySelector<HTMLElement>(action.selector!);
      if (!element) {
        return fail(`nothing matches ${action.selector} in this window`, {
          candidates: interactiveElements(),
        });
      }
      const rect = element.getBoundingClientRect();
      // Focus first: a real click focuses what it hits, and the shortcut layer
      // reads `document.activeElement` to decide whether the user is typing.
      element.focus({ preventScroll: true });
      element.click();
      return {
        result: {
          ok: true,
          clicked: describeElement(element),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        },
      };
    }
    case 'press': {
      const modifiers = new Set(action.modifiers ?? []);
      // Dispatched on whatever a real keystroke would target, so the event
      // travels the same path: focus check, then the app's shortcut layer on
      // the window (`useShortcuts`). `handled` comes from that layer calling
      // preventDefault, which is how it reports having claimed the key.
      const event = new KeyboardEvent('keydown', {
        key: action.key!,
        bubbles: true,
        cancelable: true,
        ctrlKey: modifiers.has('ctrl'),
        altKey: modifiers.has('alt'),
        shiftKey: modifiers.has('shift'),
        metaKey: modifiers.has('meta'),
      });
      const target = document.activeElement ?? document.body;
      const handled = !target.dispatchEvent(event);
      return { result: { ok: true, key: action.key, handled } };
    }
  }
};

const listenForActions = (): void => {
  if (window.__readestDebugActionListener) return;
  window.__readestDebugActionListener = true;
  // On the document, not in module state: Fast Refresh re-evaluates this module
  // while the listener registered below stays live.
  const handled = (window.__readestDebugHandledActions ??= new Set<string>());
  // Scope the listener to this window: an event emitted to one label still
  // reaches every window whose listener targets `Any` (Tauri's `emit_to` only
  // narrows listeners that name a label), which would run each action in every
  // open window.
  const target = getCurrentWindow().label;
  void listen<{ id: string; action: DebugAction }>(
    ACTION_EVENT,
    async ({ payload }) => {
      // Claimed synchronously, before the first await, so Rust's re-send of an
      // action still in flight cannot run it a second time.
      if (handled.has(payload.id)) return;
      handled.add(payload.id);
      const outcome = await runDebugAction(payload.action).catch(
        (error: unknown): ActionOutcome => ({
          result: { ok: false, error: error instanceof Error ? error.message : String(error) },
        }),
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
