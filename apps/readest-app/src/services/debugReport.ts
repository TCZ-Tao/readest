// Dev-only debug reporting for the in-app debug server
// (src-tauri/src/debug_server.rs). The pushes below are what the /state and
// /logs endpoints serve. Self-gating: the probe invoke only resolves when the
// debug server is compiled in (desktop debug builds), so normal builds turn
// this into a no-op without any injected flag — which matters because
// JS-created windows (reader-*) don't receive the main window's initialization
// script. `initDebugServer` additionally mirrors the `debugMcpEnabled` setting
// onto the Rust listener, so the MCP endpoint follows that setting in both
// directions (boot restore and every later toggle).

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriAppPlatform } from '@/services/environment';
import { useReaderStore } from '@/store/readerStore';
import { useReaderProgressStore } from '@/store/readerProgressStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

const CONSOLE_FLUSH_INTERVAL_MS = 500;
const STATE_INTERVAL_MS = 2000;
const CONSOLE_BUFFER_LIMIT = 500;

let initialized = false;
let debugServerWired = false;

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
    libraryBooks: library.length,
    ts: Date.now(),
  };
};

export const initDebugReporting = async () => {
  if (initialized || !isTauriAppPlatform()) return;
  // Probe doubles as the first push; rejection = debug server not compiled in.
  try {
    await invoke('debug_report_state', { payload: buildSnapshot() });
  } catch {
    return;
  }
  initialized = true;

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
};
