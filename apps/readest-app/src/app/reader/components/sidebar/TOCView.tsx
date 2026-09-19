import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useOverlayScrollbars } from 'overlayscrollbars-react';
import { FiEdit2 } from 'react-icons/fi';
import 'overlayscrollbars/overlayscrollbars.css';

import { TOCItem } from '@/libs/document';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { useSidebarStore } from '@/store/sidebarStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { useTextTranslation } from '../../hooks/useTextTranslation';
import TOCEditView from './TOCEditView';
import BookContextMenuPopup from '@/app/library/components/BookContextMenuPopup';
import {
  buildTOCDisplayItems,
  CurrentPositionRow,
  FlatTOCItem,
  isCurrentPositionItem,
  StaticListRow,
} from './TOCItem';
import { computeExpandedSet, getItemIdentifier } from './tocTree';
import { ensureTocIds, flattenTocForEdit, renameTocItem } from './tocEditTree';

const flattenTOC = (items: TOCItem[], expandedItems: Set<string>, depth = 0): FlatTOCItem[] => {
  const result: FlatTOCItem[] = [];
  items.forEach((item, index) => {
    const isExpanded = expandedItems.has(getItemIdentifier(item));
    result.push({ item, depth, index, isExpanded });
    if (item.subitems && isExpanded) {
      result.push(...flattenTOC(item.subitems, expandedItems, depth + 1));
    }
  });
  return result;
};

const setsHaveSameContents = (a: Set<string>, b: Set<string>): boolean => {
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
};

// In-place rename row rendered inside the read-only (non-edit-mode) list when
// the user picks "Rename" from a TOC item's context menu. Commit on blur or
// Enter, cancel on Escape — same contract as the edit-mode rename input.
const TocRenameRow: React.FC<{
  item: TOCItem;
  depth: number;
  onSubmit: (label: string) => void;
}> = ({ item, depth, onSubmit }) => {
  const cancelledRef = useRef(false);

  const commitRename = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      if (cancelledRef.current) {
        cancelledRef.current = false;
        return;
      }
      const label = event.target.value.trim();
      if (label && label !== item.label) onSubmit(label);
    },
    [item.label, onSubmit],
  );

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      cancelledRef.current = true;
      event.currentTarget.blur();
    }
  }, []);

  return (
    <div className='border-base-300 w-full border-b pe-4 ps-2 pt-[1px] sm:border-none'>
      <div
        className='flex w-full items-center rounded-md py-4 sm:py-2'
        style={{ paddingInlineStart: `${(depth + 1) * 12}px` }}
      >
        <input
          autoFocus
          defaultValue={item.label}
          onBlur={commitRename}
          onKeyDown={handleKeyDown}
          className='input input-sm ms-2 min-w-0 flex-1'
          aria-label={item.label}
        />
      </div>
    </div>
  );
};

const getInitialScrollTarget = (
  toc: TOCItem[],
  href: string | undefined,
): { index: number; expanded: Set<string> } => {
  const expanded = computeExpandedSet(toc, href);
  if (!href) return { index: 0, expanded };
  const flat = flattenTOC(toc, expanded);
  const idx = flat.findIndex((f) => f.item.href === href);
  return { index: idx > 0 ? idx : 0, expanded };
};

const TOCView: React.FC<{
  bookKey: string;
  toc: TOCItem[];
}> = ({ bookKey, toc }) => {
  const { getView, getViewSettings, getProgress } = useReaderStore();
  const { sideBarBookKey, isSideBarVisible } = useSidebarStore();
  const { appService } = useEnv();
  const _ = useTranslation();
  const progress = getProgress(bookKey);
  const isEink = !!getViewSettings(bookKey)?.isEink;
  const bookData = useBookDataStore((state) => state.booksData[bookKey.split('-')[0]!]);
  const isPdf = bookData?.book?.format === 'PDF';
  const book = bookData?.book ?? null;

  const [initialScrollTarget] = useState(() => getInitialScrollTarget(toc, progress?.sectionHref));
  const [expandedItems, setExpandedItems] = useState<Set<string>>(initialScrollTarget.expanded);
  const [containerHeight, setContainerHeight] = useState(400);
  const [editing, setEditing] = useState(false);
  const [editToc, setEditToc] = useState<TOCItem[] | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: TOCItem } | null>(
    null,
  );
  const [renamingId, setRenamingId] = useState<TOCItem['id'] | null>(null);

  // Persist an edited tree: refresh bookDoc.toc (drives this panel and the
  // annotation/bookmark section labels) and write the override file that
  // readerStore reapplies on the next open.
  const commitToc = useCallback(
    (newToc: TOCItem[]) => {
      setEditToc(newToc);
      const id = bookKey.split('-')[0]!;
      useBookDataStore.setState((state) => {
        const existing = state.booksData[id];
        if (!existing?.bookDoc) return state;
        return {
          booksData: {
            ...state.booksData,
            [id]: { ...existing, bookDoc: { ...existing.bookDoc, toc: newToc } },
          },
        };
      });
      if (book) {
        appService
          ?.saveTocOverride(book, newToc)
          .catch((e) => console.warn('Failed to save TOC override:', e));
      }
    },
    [bookKey, book, appService],
  );

  const startEditing = useCallback(() => {
    setEditToc(ensureTocIds(toc));
    setEditing(true);
  }, [toc]);

  // Context-menu rename. The read-only tree may carry no ids yet (the book was
  // never edited), so stamp them first — persisting that id-only change — and
  // address the node by its flat position, which ensureTocIds preserves.
  const startRename = useCallback(
    (item: TOCItem) => {
      const rows = flattenTocForEdit(toc);
      const idx = rows.findIndex((row) => row.item === item);
      if (idx === -1) return;
      let target = toc;
      if (!rows.every((row) => typeof row.item.id === 'number')) {
        target = ensureTocIds(toc);
        commitToc(target);
      }
      setRenamingId(flattenTocForEdit(target)[idx]!.item.id);
    },
    [toc, commitToc],
  );

  const handleRenamed = useCallback(
    (label: string) => {
      if (renamingId !== null) commitToc(renameTocItem(toc, renamingId, label));
      setRenamingId(null);
    },
    [renamingId, toc, commitToc],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const userScrolledRef = useRef(false);
  const scrollCooldownRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollRef = useRef(false);
  const visibleCenterRef = useRef(0);
  const initialScrollHandledRef = useRef(initialScrollTarget.index > 0);
  // Don't honor userScrolledRef before the first post-mount progress arrives.
  // With a pinned sidebar, TOCView mounts before FoliateViewer emits its
  // first relocate; if any programmatic scroll (e.g. OverlayScrollbars'
  // viewport-wrap scrollTop reset) flips userScrolledRef in that window it
  // would otherwise suppress the auto-scroll once progress finally arrives.
  const initialAutoScrollProcessedRef = useRef(false);
  // Mirror the latest active item + flat list so the OverlayScrollbars
  // `initialized` callback (created at mount but fired after a deferred,
  // timing-dependent delay) can re-center on the *current* reading position.
  const activeHrefRef = useRef<string | null>(null);
  const flatItemsRef = useRef<FlatTOCItem[]>([]);
  // True once the reader has genuinely driven the list (wheel/touch/pointer/
  // key). Auto-expanding the current volume on open grows the list and fires a
  // synthetic scroll event; without a real gesture behind it, that scroll must
  // not be mistaken for the user taking over and cancel the queued auto-scroll.
  const userInputRef = useRef(false);

  // OverlayScrollbars + Virtuoso integration (same pattern as Bookshelf)
  const osRootRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [initialize, osInstance] = useOverlayScrollbars({
    defer: true,
    options: { scrollbars: { autoHide: 'scroll' } },
    events: {
      initialized(instance) {
        const { viewport } = instance.elements();
        viewport.style.overflowX = 'var(--os-viewport-overflow-x)';
        viewport.style.overflowY = 'var(--os-viewport-overflow-y)';
        // OverlayScrollbars resets the wrapped viewport's scrollTop to 0 as it
        // initializes. On a fresh refresh the auto-scroll to the reading
        // position may already have run by now, so re-apply it here — using the
        // *current* active item, since initialScrollTarget was captured at mount
        // when progress was usually not yet available (index 0). Without this
        // the TOC rewinds to the very top on ~1 in 10 refreshes, depending on
        // whether this deferred init lands before or after the auto-scroll.
        const activeIdx = activeHrefRef.current
          ? flatItemsRef.current.findIndex((f) => f.item.href === activeHrefRef.current)
          : -1;
        const target = activeIdx > 0 ? activeIdx : initialScrollTarget.index;
        if (target > 0) {
          requestAnimationFrame(() => {
            virtuosoRef.current?.scrollToIndex({
              index: target,
              align: 'center',
              behavior: 'auto',
            });
          });
        }
      },
    },
  });

  useEffect(() => {
    const root = osRootRef.current;
    if (scroller && root) {
      initialize({ target: root, elements: { viewport: scroller } });
    }
    return () => osInstance()?.destroy();
  }, [scroller, initialize, osInstance]);

  // Flag real user gestures so onScroll can tell them apart from the synthetic
  // scroll emitted when the current volume auto-expands on open.
  useEffect(() => {
    if (!scroller) return;
    const markUserInput = () => {
      userInputRef.current = true;
    };
    const passiveCapture = { capture: true, passive: true } as const;
    const capture = { capture: true } as const;
    scroller.addEventListener('wheel', markUserInput, passiveCapture);
    scroller.addEventListener('touchstart', markUserInput, passiveCapture);
    scroller.addEventListener('pointerdown', markUserInput, passiveCapture);
    scroller.addEventListener('keydown', markUserInput, capture);
    return () => {
      scroller.removeEventListener('wheel', markUserInput, passiveCapture);
      scroller.removeEventListener('touchstart', markUserInput, passiveCapture);
      scroller.removeEventListener('pointerdown', markUserInput, passiveCapture);
      scroller.removeEventListener('keydown', markUserInput, capture);
    };
  }, [scroller]);

  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    setScroller(el instanceof HTMLElement ? el : null);
  }, []);

  useTextTranslation(bookKey, containerRef.current, false, 'translation-target-toc');

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const parentContainer = containerRef.current.closest('.scroll-container');
        if (parentContainer) {
          const parentRect = parentContainer.getBoundingClientRect();
          const availableHeight = parentRect.height - (rect.top - parentRect.top);
          setContainerHeight(Math.max(400, availableHeight));
        }
      }
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    let resizeObserver: ResizeObserver | null = null;
    if (containerRef.current) {
      const parentContainer = containerRef.current.closest('.scroll-container');
      if (parentContainer) {
        resizeObserver = new ResizeObserver(updateHeight);
        resizeObserver.observe(parentContainer);
      }
    }
    return () => {
      window.removeEventListener('resize', updateHeight);
      if (resizeObserver) resizeObserver.disconnect();
    };
  }, []);

  const activeHref = progress?.sectionHref ?? null;
  const flatItems = useMemo(() => flattenTOC(toc, expandedItems), [toc, expandedItems]);
  // Inject a "current position" row under the active item showing the current
  // reading page. It sits after the active item, so flatItems indices (used by
  // the auto-scroll effects) stay valid against this rendered list.
  const displayItems = useMemo(
    () => buildTOCDisplayItems(flatItems, activeHref, progress?.page),
    [flatItems, activeHref, progress?.page],
  );
  // Keep the refs read by the OverlayScrollbars `initialized` callback current.
  activeHrefRef.current = activeHref;
  flatItemsRef.current = flatItems;

  const handleToggleExpand = useCallback((item: TOCItem) => {
    const itemId = getItemIdentifier(item);
    setExpandedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(itemId)) {
        newSet.delete(itemId);
      } else {
        newSet.add(itemId);
      }
      return newSet;
    });
  }, []);

  const handleItemClick = useCallback(
    (item: TOCItem) => {
      eventDispatcher.dispatch('navigate', { bookKey, href: item.href });
      if (item.href) {
        getView(bookKey)?.goTo(item.href);
      }
    },
    [bookKey, getView],
  );

  const handleCurrentPositionClick = useCallback(() => {
    const location = getProgress(bookKey)?.location;
    if (!location) return;
    eventDispatcher.dispatch('navigate', { bookKey, cfi: location });
    getView(bookKey)?.goTo(location);
  }, [bookKey, getView, getProgress]);

  useEffect(() => {
    if (editing) return;
    if (!isSideBarVisible || sideBarBookKey !== bookKey) {
      userScrolledRef.current = false;
      pendingScrollRef.current = false;
      initialAutoScrollProcessedRef.current = false;
      return;
    }
    if (userScrolledRef.current && initialAutoScrollProcessedRef.current) return;
    setExpandedItems((prev) => {
      const next = computeExpandedSet(toc, progress?.sectionHref);
      return setsHaveSameContents(prev, next) ? prev : next;
    });
    if (progress?.sectionHref) {
      if (initialScrollHandledRef.current) {
        initialScrollHandledRef.current = false;
      } else {
        pendingScrollRef.current = true;
      }
      initialAutoScrollProcessedRef.current = true;
    }
  }, [isSideBarVisible, sideBarBookKey, bookKey, toc, progress, editing]);

  useEffect(() => {
    if (editing) return;
    if (!pendingScrollRef.current || !activeHref || !isSideBarVisible) return;
    const idx = flatItems.findIndex((f) => f.item.href === activeHref);
    if (idx === -1) {
      // The active section's parents were just queued to expand by the
      // post-mount progress effect above — flatItems still reflects the
      // pre-update expandedItems. Leave pendingScrollRef set so this
      // effect retries on the next render once flatItems contains the
      // active section. Clearing it here would strand the scroll.
      return;
    }
    // Eink displays ghost previous frames during smooth JS scroll
    // animations; force an instant jump to avoid the artifact. A CSS-only
    // fix is impossible because scrollTo({ behavior: 'smooth' }) overrides
    // CSS scroll-behavior and is not a CSS transition.
    const distance = Math.abs(idx - visibleCenterRef.current);
    const behavior = isEink || distance > 16 ? 'auto' : 'smooth';
    virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior });
    // When the current volume auto-expands on open, the list grows by dozens of
    // rows in this same commit. Virtuoso scrolls before measuring the new rows,
    // so a single scrollToIndex lands short. Re-assert on the next frame (once
    // they're measured) for the instant-jump case so the chapter ends centered.
    if (behavior === 'auto') {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'auto' });
      });
    }
    pendingScrollRef.current = false;
  }, [flatItems, activeHref, isSideBarVisible, isEink, editing]);

  return (
    <div ref={containerRef} className='toc-list rounded-sm' role='tree'>
      {isPdf && !editing && (
        <div className='flex justify-end px-2 pt-1'>
          <button
            onClick={startEditing}
            className='btn btn-ghost btn-sm text-base-content/70 text-sm'
            title={_('Edit TOC')}
          >
            <FiEdit2 aria-hidden='true' />
            {_('Edit TOC')}
          </button>
        </div>
      )}
      {editing && editToc ? (
        <TOCEditView
          bookKey={bookKey}
          toc={editToc}
          containerHeight={containerHeight}
          onCommit={commitToc}
          onExit={() => {
            setEditing(false);
            setEditToc(null);
          }}
        />
      ) : (
        <div
          ref={osRootRef}
          data-overlayscrollbars-initialize=''
          style={{ height: containerHeight }}
        >
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={handleScrollerRef}
            initialTopMostItemIndex={
              initialScrollTarget.index > 0
                ? { index: initialScrollTarget.index, align: 'center' }
                : 0
            }
            rangeChanged={({ startIndex, endIndex }) => {
              visibleCenterRef.current = Math.floor((startIndex + endIndex) / 2);
            }}
            onScroll={() => {
              // A scroll arriving while a pending auto-scroll is still queued
              // (idx === -1, waiting on flatItems to expand) normally means the
              // user is now driving — drop the queued auto-scroll so the next
              // render doesn't yank them away. But auto-expanding the current
              // volume on open grows the list and emits a synthetic scroll with
              // no gesture behind it; ignore that so the initial auto-scroll
              // survives. A real user scroll still cancels it via userInputRef.
              if (pendingScrollRef.current && !userInputRef.current) return;
              pendingScrollRef.current = false;
              userScrolledRef.current = true;
              if (scrollCooldownRef.current) clearTimeout(scrollCooldownRef.current);
              scrollCooldownRef.current = setTimeout(() => {
                userScrolledRef.current = false;
              }, 10000);
            }}
            style={{ height: containerHeight }}
            totalCount={displayItems.length}
            itemContent={(index) => {
              const row = displayItems[index]!;
              if (isCurrentPositionItem(row)) {
                return (
                  <CurrentPositionRow
                    depth={row.depth}
                    page={row.page}
                    onClick={handleCurrentPositionClick}
                  />
                );
              }
              if (isPdf && row.item.id === renamingId) {
                return <TocRenameRow item={row.item} depth={row.depth} onSubmit={handleRenamed} />;
              }
              return (
                <div
                  className='w-full'
                  onContextMenu={
                    isPdf
                      ? (event) => {
                          event.preventDefault();
                          setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            item: row.item,
                          });
                        }
                      : undefined
                  }
                >
                  <StaticListRow
                    bookKey={bookKey}
                    flatItem={row}
                    activeHref={activeHref}
                    onToggleExpand={handleToggleExpand}
                    onItemClick={handleItemClick}
                  />
                </div>
              );
            }}
            overscan={500}
          />
        </div>
      )}
      {contextMenu && (
        <BookContextMenuPopup
          position={{ x: contextMenu.x, y: contextMenu.y }}
          items={[{ text: _('Rename'), action: () => startRename(contextMenu.item) }]}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
};
export default TOCView;
