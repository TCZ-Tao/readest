import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

const navigateToReaderMock = vi.fn();
const getCurrentMock = vi.fn(async () => [] as string[]);
const getAllWindowsMock = vi.fn(async () => [{ label: 'main' }]);
const setFocusMock = vi.fn();
const showReaderWindowMock = vi.fn();
const focusExistingReaderWindowMock = vi.fn();
const mockFlags = { openBookInNewWindow: false };
const mockWindowLabel = { value: 'main' };
const appServiceState: { hasWindow: boolean } = { hasWindow: false };

const libraryState = {
  libraryLoaded: true,
  getBookByHash: (hash: string) => (hash.startsWith('book') ? { hash } : undefined),
};

type ViewLike = { goTo: (cfi: string) => void };
type ReaderState = {
  bookKeys: string[];
  viewStates: Record<string, { view: ViewLike; inited: boolean }>;
  setPreviewMode: ReturnType<typeof vi.fn>;
};
// A reader is mounted; bookKeys lists only the currently-displayed book(s).
// viewStates may carry stale entries for books switched away from.
const readerState: ReaderState = {
  bookKeys: ['bookA-1'],
  viewStates: {},
  setPreviewMode: vi.fn(),
};

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: () => getCurrentMock(),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getAllWindows: () => getAllWindowsMock(),
  getCurrentWindow: () => ({ setFocus: setFocusMock, label: mockWindowLabel.value }),
}));
vi.mock('@/services/environment', async (orig) => {
  const actual = await orig<typeof import('@/services/environment')>();
  return { ...actual, isTauriAppPlatform: () => true };
});
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: appServiceState }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (k: string) => k }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: (
    selector: (state: { settings: { openBookInNewWindow: boolean } }) => unknown,
  ) => selector({ settings: { openBookInNewWindow: mockFlags.openBookInNewWindow } }),
}));
vi.mock('@/utils/nav', () => ({
  navigateToReader: (...a: unknown[]) => navigateToReaderMock(...a),
  showReaderWindow: (...a: unknown[]) => showReaderWindowMock(...a),
  focusExistingReaderWindow: (...a: unknown[]) => focusExistingReaderWindowMock(...a),
}));
vi.mock('@/store/libraryStore', () => {
  const useLibraryStore = ((selector: (s: typeof libraryState) => unknown) =>
    selector(libraryState)) as unknown as {
    (selector: (s: typeof libraryState) => unknown): unknown;
    getState: () => typeof libraryState;
  };
  useLibraryStore.getState = () => libraryState;
  return { useLibraryStore };
});
vi.mock('@/store/readerStore', () => {
  const useReaderStore = (() => readerState) as unknown as {
    (): ReaderState;
    getState: () => ReaderState;
  };
  useReaderStore.getState = () => readerState;
  return { useReaderStore };
});

import { useOpenAnnotationLink } from '@/hooks/useOpenAnnotationLink';
import { eventDispatcher } from '@/utils/event';

const CFI = 'epubcfi(/6/4!/4/2)';
const urlFor = (hash: string) =>
  `readest://book/${hash}/annotation/note1?cfi=${encodeURIComponent(CFI)}`;

const collectSwitch = () => {
  const switched = vi.fn();
  const handler = (e: Event) => switched((e as CustomEvent).detail);
  eventDispatcher.on('open-book-in-reader', handler);
  return {
    switched,
    stop: () => eventDispatcher.off('open-book-in-reader', handler),
  };
};

describe('useOpenAnnotationLink — reader already mounted', () => {
  beforeEach(() => {
    navigateToReaderMock.mockReset();
    showReaderWindowMock.mockReset();
    focusExistingReaderWindowMock.mockReset();
    focusExistingReaderWindowMock.mockResolvedValue(false);
    setFocusMock.mockReset();
    mockFlags.openBookInNewWindow = false;
    mockWindowLabel.value = 'main';
    appServiceState.hasWindow = false;
    readerState.setPreviewMode.mockReset();
    readerState.bookKeys = ['bookA-1'];
    readerState.viewStates = { 'bookA-1': { view: { goTo: vi.fn() }, inited: true } };
    window.history.replaceState({}, '', '/reader?ids=bookA');
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('switches the book in place instead of calling the no-op navigateToReader', async () => {
    const { switched, stop } = collectSwitch();
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await Promise.resolve();
    stop();

    // navigateToReader('/reader?ids=bookB&cfi=...') does not re-init an
    // already-mounted reader, so the reader would stay on bookA. The fix routes
    // through the in-place switch event carrying the target cfi.
    expect(navigateToReaderMock).not.toHaveBeenCalled();
    expect(switched).toHaveBeenCalledWith(expect.objectContaining({ bookHash: 'bookB', cfi: CFI }));
  });

  it('jumps in place when the target book is the currently displayed one', async () => {
    const goTo = vi.fn();
    readerState.bookKeys = ['bookB-1'];
    readerState.viewStates = { 'bookB-1': { view: { goTo }, inited: true } };

    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await Promise.resolve();

    expect(goTo).toHaveBeenCalledWith(CFI);
    expect(readerState.setPreviewMode).toHaveBeenCalledWith('bookB-1', true);
    expect(navigateToReaderMock).not.toHaveBeenCalled();
    // The window that honoured the link focuses itself so the user lands on
    // the annotation instead of on the library the Rust callback focused.
    expect(setFocusMock).toHaveBeenCalled();
  });

  it('switches back to a book that was opened before but is no longer displayed (#4887)', async () => {
    // Simulates opening A -> B -> A all by deep link. After A -> B, bookA-1 is
    // still in viewStates with a now-detached view (never cleared on switch),
    // while bookKeys reflects only bookB-2. A deep link back to book A must
    // switch in place, NOT goTo the stale detached bookA view.
    const staleGoTo = vi.fn();
    readerState.bookKeys = ['bookB-2'];
    readerState.viewStates = {
      'bookA-1': { view: { goTo: staleGoTo }, inited: true },
      'bookB-2': { view: { goTo: vi.fn() }, inited: true },
    };

    const { switched, stop } = collectSwitch();
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookA')] });
    await Promise.resolve();
    stop();

    expect(staleGoTo).not.toHaveBeenCalled();
    expect(navigateToReaderMock).not.toHaveBeenCalled();
    expect(switched).toHaveBeenCalledWith(expect.objectContaining({ bookHash: 'bookA', cfi: CFI }));
  });
});

describe('useOpenAnnotationLink — library window defers to reader windows', () => {
  beforeEach(() => {
    navigateToReaderMock.mockReset();
    showReaderWindowMock.mockReset();
    focusExistingReaderWindowMock.mockReset();
    focusExistingReaderWindowMock.mockResolvedValue(false);
    setFocusMock.mockReset();
    mockWindowLabel.value = 'main';
    appServiceState.hasWindow = true;
    readerState.bookKeys = [];
    readerState.viewStates = {};
    window.history.replaceState({}, '', '/library');
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('defers to the reader window that already holds the book', async () => {
    // The single-instance event is broadcast to every window, so the reader
    // window holding the book handles the jump itself; the library window
    // must stay the library.
    mockFlags.openBookInNewWindow = true;
    focusExistingReaderWindowMock.mockResolvedValue(true);
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await flush();

    expect(focusExistingReaderWindowMock).toHaveBeenCalledWith('bookB');
    expect(navigateToReaderMock).not.toHaveBeenCalled();
    expect(showReaderWindowMock).not.toHaveBeenCalled();
  });

  it('opens a dedicated reader window when no window holds the book', async () => {
    mockFlags.openBookInNewWindow = true;
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await flush();

    expect(showReaderWindowMock).toHaveBeenCalledWith(
      expect.anything(),
      ['bookB'],
      `cfi=${encodeURIComponent(CFI)}`,
    );
    expect(navigateToReaderMock).not.toHaveBeenCalled();
  });

  it('single-window mode still navigates the library itself into the reader', async () => {
    // openBookInNewWindow off: books always open inside the main window, so
    // navigating the library to /reader is the intended behaviour.
    mockFlags.openBookInNewWindow = false;
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await flush();

    expect(navigateToReaderMock).toHaveBeenCalledWith(
      expect.anything(),
      ['bookB'],
      `cfi=${encodeURIComponent(CFI)}`,
    );
    expect(showReaderWindowMock).not.toHaveBeenCalled();
  });
});

describe('useOpenAnnotationLink — reader window holding a different book', () => {
  beforeEach(() => {
    navigateToReaderMock.mockReset();
    showReaderWindowMock.mockReset();
    focusExistingReaderWindowMock.mockReset();
    focusExistingReaderWindowMock.mockResolvedValue(false);
    setFocusMock.mockReset();
    mockFlags.openBookInNewWindow = true;
    mockWindowLabel.value = 'reader-0-abc';
    appServiceState.hasWindow = true;
    readerState.bookKeys = ['bookA-1'];
    readerState.viewStates = { 'bookA-1': { view: { goTo: vi.fn() }, inited: true } };
    window.history.replaceState({}, '', '/reader?ids=bookA');
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('keeps its own book and lets the library open the target in a new window', async () => {
    // This window shows bookA; the link targets bookB which no window holds.
    // The main library window (which got the same event) opens bookB's own
    // reader window — this window must not switch its content.
    const { switched, stop } = collectSwitch();
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await flush();
    stop();

    expect(focusExistingReaderWindowMock).toHaveBeenCalledWith('bookB');
    expect(switched).not.toHaveBeenCalled();
    expect(showReaderWindowMock).not.toHaveBeenCalled();
    expect(navigateToReaderMock).not.toHaveBeenCalled();
  });

  it('stays put when another reader window already holds the target book', async () => {
    focusExistingReaderWindowMock.mockResolvedValue(true);
    const { switched, stop } = collectSwitch();
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await flush();
    stop();

    expect(switched).not.toHaveBeenCalled();
    expect(showReaderWindowMock).not.toHaveBeenCalled();
    expect(navigateToReaderMock).not.toHaveBeenCalled();
  });

  it('falls back to opening the window itself when the library is gone', async () => {
    getAllWindowsMock.mockResolvedValue([{ label: 'reader-0-abc' }]);
    renderHook(() => useOpenAnnotationLink());
    await eventDispatcher.dispatch('app-incoming-url', { urls: [urlFor('bookB')] });
    await flush();

    expect(showReaderWindowMock).toHaveBeenCalledWith(
      expect.anything(),
      ['bookB'],
      `cfi=${encodeURIComponent(CFI)}`,
    );
  });
});
