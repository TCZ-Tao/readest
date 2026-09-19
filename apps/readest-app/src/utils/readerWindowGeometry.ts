import { TauriEvent } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isTauriAppPlatform } from '@/services/environment';

// Per-book geometry for dedicated reader windows. The window-state plugin
// keys its store by window label, and every reader window carries a unique
// per-open label, so the per-book state lives in localStorage instead (shared
// across all app windows), keyed by the `ids` the window was opened with.

const GEOMETRY_KEY_PREFIX = 'reader-window-geometry:';

// Windows parks minimized windows at (-32000, -32000); geometry recorded
// there is never a real position (same cutoff as window_state.rs).
const MIN_VALID_COORD = -16000;

export interface ReaderWindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

const geometryKey = (ids: string) => `${GEOMETRY_KEY_PREFIX}${ids}`;

export const loadReaderWindowGeometry = (ids: string): ReaderWindowGeometry | null => {
  try {
    const raw = localStorage.getItem(geometryKey(ids));
    if (!raw) return null;
    const g = JSON.parse(raw);
    if (
      typeof g?.x !== 'number' ||
      typeof g?.y !== 'number' ||
      typeof g?.width !== 'number' ||
      typeof g?.height !== 'number' ||
      g.width <= 0 ||
      g.height <= 0 ||
      g.x <= MIN_VALID_COORD ||
      g.y <= MIN_VALID_COORD
    ) {
      return null;
    }
    return { x: g.x, y: g.y, width: g.width, height: g.height, maximized: g.maximized === true };
  } catch {
    return null;
  }
};

// Called once in every dedicated reader window: persists the window geometry
// as the user moves and resizes it. A maximized window only records the flag
// so the saved bounds stay the pre-maximize ones — what un-maximizing should
// restore.
export const trackReaderWindowGeometry = (ids: string) => {
  if (!ids || !isTauriAppPlatform()) return;
  const currentWindow = getCurrentWindow();
  if (!currentWindow.label.startsWith('reader')) return;

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const save = async () => {
    try {
      if (await currentWindow.isMinimized()) return;
      const maximized = await currentWindow.isMaximized();
      const factor = await currentWindow.scaleFactor();
      const [position, size] = await Promise.all([
        currentWindow.outerPosition(),
        currentWindow.innerSize(),
      ]);
      const previous = maximized ? loadReaderWindowGeometry(ids) : null;
      localStorage.setItem(
        geometryKey(ids),
        JSON.stringify({
          x: previous?.x ?? Math.round(position.x / factor),
          y: previous?.y ?? Math.round(position.y / factor),
          width: previous?.width ?? Math.round(size.width / factor),
          height: previous?.height ?? Math.round(size.height / factor),
          maximized,
        }),
      );
    } catch {
      // The window may already be gone; nothing left to persist then.
    }
  };
  const saveDebounced = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  };
  currentWindow.onMoved(saveDebounced);
  currentWindow.onResized(saveDebounced);
  // Raw event rather than onCloseRequested, whose wrapper destroys the window
  // unless its own handler calls preventDefault — this window's close is
  // already managed by tauriHandleOnCloseWindow.
  currentWindow.listen(TauriEvent.WINDOW_CLOSE_REQUESTED, () => {
    clearTimeout(saveTimer);
    return save();
  });
};
