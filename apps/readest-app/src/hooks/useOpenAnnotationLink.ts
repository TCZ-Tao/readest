import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getCurrent } from '@tauri-apps/plugin-deep-link';
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useReaderStore } from '@/store/readerStore';
import { useSettingsStore } from '@/store/settingsStore';
import { isTauriAppPlatform } from '@/services/environment';
import { navigateToReader, showReaderWindow, focusExistingReaderWindow } from '@/utils/nav';
import { eventDispatcher } from '@/utils/event';
import { parseAnnotationDeepLink, AnnotationDeepLink } from '@/utils/deeplink';
import { isMainAppWindow } from '@/utils/window';
import { markLaunchUrl } from '@/utils/deeplinkConsume';
import { useTranslation } from './useTranslation';

// Module-scoped — survives hook remounts (library → reader → library on
// book close). Tauri's getCurrent() keeps returning the launch URL for the
// lifetime of the app session, so without this flag every remount would
// re-process the cold-start URL and navigate back to the deep-link target
// in a loop.
let coldStartConsumed = false;

/**
 * Receive annotation deep links and navigate the reader accordingly.
 *
 * Architecture:
 *   - useOpenWithBooks owns the Tauri URL channels (onOpenUrl,
 *     single-instance, shared-intent, open-files) and re-broadcasts every
 *     URL as the 'app-incoming-url' event. This hook subscribes to that
 *     event for the warm-start / live path.
 *   - For cold-start (app launched FROM the URL), getCurrent() is read
 *     once at module scope. useOpenWithBooks doesn't do this — its
 *     channels only fire for live deliveries.
 *   - Library-load deferral: on cold-start the URL may arrive before the
 *     library store has hydrated. Stash and replay once libraryLoaded.
 *
 * Supported URL shapes (see src/utils/deeplink.ts):
 *   readest://book/{hash}/annotation/{id}?cfi=...
 *   https://web.readest.com/o/book/{hash}/annotation/{id}?cfi=...
 *   readest://annotation/{hash}/{id}            (legacy Readwise sync)
 *
 * Already-open shortcut: if the target book has a mounted view, jump in
 * place via view.goTo(cfi). router.push to the same /reader path with a
 * different cfi query does NOT re-run the reader's init effect, so
 * navigation alone wouldn't move the view in that case.
 */
export function useOpenAnnotationLink() {
  const _ = useTranslation();
  const router = useRouter();
  const { appService } = useEnv();
  const openBookInNewWindow = useSettingsStore((s) => s.settings.openBookInNewWindow);
  const getBookByHash = useLibraryStore((s) => s.getBookByHash);
  const libraryLoaded = useLibraryStore((s) => s.libraryLoaded);
  const pending = useRef<AnnotationDeepLink | null>(null);

  const resolveAndNavigate = useCallback(
    async (parsed: AnnotationDeepLink) => {
      const { bookHash, cfi } = parsed;
      const book = getBookByHash(bookHash);
      if (!book) {
        eventDispatcher.dispatch('toast', {
          type: 'warning',
          message: _('Book not in your library'),
          timeout: 2500,
        });
        return;
      }

      // Only books in the current bookKeys are actually displayed. viewStates
      // accumulates stale entries for books switched away from in place (their
      // views are detached from the DOM, never cleared on switch), so matching
      // against all viewStates would goTo a dead view and the reader would stay
      // stuck on the current book when switching back to a previously-open one
      // (#4887). Scope the "already open" check to the displayed bookKeys.
      const { viewStates, bookKeys, setPreviewMode } = useReaderStore.getState();
      const openKey = bookKeys.find((key) => key.startsWith(bookHash) && viewStates[key]?.view);
      if (openKey) {
        if (cfi) {
          viewStates[openKey]!.view!.goTo(cfi);
          setPreviewMode(openKey, true);
        }
        // The Rust single-instance callback focuses the "main" window before
        // the URL reaches us; the window that actually honours the link should
        // be the one left on top, so the user lands on the annotation.
        void getCurrentWindow().setFocus();
        return;
      }

      // Desktop multi-window mode: the book either lives in another reader
      // window — which received the same URL event and jumps itself, so just
      // bring it to the front — or in no window at all, in which case it gets
      // its own new reader window at the annotation. Never repurpose another
      // window's content for it.
      if (isTauriAppPlatform() && appService?.hasWindow && openBookInNewWindow) {
        if (await focusExistingReaderWindow(bookHash)) return;
        // Every window received the same URL event; let the main library
        // window be the one that opens a not-yet-open book so several reader
        // windows don't race to open duplicates of it. (If main was closed,
        // fail open: each window opening its own copy beats losing the link.)
        const isMain = getCurrentWindow().label === 'main';
        if (!isMain && (await getAllWindows()).some((window) => window.label === 'main')) return;
        showReaderWindow(
          appService,
          [bookHash],
          cfi ? `cfi=${encodeURIComponent(cfi)}` : undefined,
        );
        return;
      }

      // Single-window mode (books open inside the main window) / mobile: a
      // mounted reader switches its book in place. router.push to the same
      // /reader route does NOT re-run the reader's one-shot init effect, so
      // navigation alone wouldn't move the view in that case (#4887).
      if (window.location.pathname.startsWith('/reader')) {
        eventDispatcher.dispatch('open-book-in-reader', { bookHash, cfi });
        return;
      }

      // No reader mounted (library / cold start) - navigate fresh; FoliateViewer
      // reads ?cfi= at init.
      const queryParams = cfi ? `cfi=${encodeURIComponent(cfi)}` : undefined;
      navigateToReader(router, [bookHash], queryParams);
    },
    [_, getBookByHash, router, appService, openBookInNewWindow],
  );

  useEffect(() => {
    if (!isTauriAppPlatform() || !appService) return;

    const handle = async (url: string, coldStart = false) => {
      const parsed = parseAnnotationDeepLink(url);
      if (!parsed) return;
      // See useOpenBookLink: getCurrent() re-reports the launch URL to every
      // fresh document, so a cold-start read is acted on once per app run;
      // live deliveries are only recorded (#6104).
      const fresh = markLaunchUrl('launchAnnotationUrls', url);
      if (coldStart && !fresh) return;
      if (!useLibraryStore.getState().libraryLoaded) {
        pending.current = parsed;
        return;
      }
      await resolveAndNavigate(parsed);
    };

    // Only the launch window reads the cold-start URL: the deep-link plugin
    // keeps it in process-global state for the whole session, so a window the
    // app spawns later would treat it as its own cold start and navigate away
    // from what the user just opened (#6104).
    if (!coldStartConsumed && isMainAppWindow()) {
      coldStartConsumed = true;
      getCurrent()
        .then((urls) => urls?.forEach((u) => handle(u, true)))
        .catch(() => {
          // Plugin not available on this platform — live channel still works.
        });
    }

    const onIncoming = (event: CustomEvent) => {
      const { urls } = event.detail as { urls: string[] };
      urls.forEach((u) => handle(u));
    };
    eventDispatcher.on('app-incoming-url', onIncoming);

    return () => {
      eventDispatcher.off('app-incoming-url', onIncoming);
    };
  }, [appService, resolveAndNavigate]);

  // Replay any deferred deep link once the library hydrates.
  useEffect(() => {
    if (!libraryLoaded || !pending.current) return;
    const parsed = pending.current;
    pending.current = null;
    void resolveAndNavigate(parsed);
  }, [libraryLoaded, resolveAndNavigate]);
}
