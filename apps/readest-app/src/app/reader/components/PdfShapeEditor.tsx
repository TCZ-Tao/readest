import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FiArrowUpRight } from 'react-icons/fi';

import { DEFAULT_HIGHLIGHT_COLORS, PdfDrawing } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import {
  applyPdfDrawings,
  PDF_BACKGROUND_COLORS,
  PDF_FONT_SIZES,
  PDF_STROKE_WIDTHS,
  seedPdfDrawings,
  usePdfDrawingsStore,
} from '@/store/pdfDrawingsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { saveViewSettings } from '@/helpers/settings';
import { useTranslation } from '@/hooks/useTranslation';
import { getHighlightColorHex } from '../utils/annotatorUtil';

interface PageRect {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

// Page-local pixel coords of a drawing's points at the current zoom — the
// screen-space image of its user-space points. Recomputed when the drawing
// list or the zoom level changes; stays valid across scrolls.
interface ShapeGeom {
  pageIndex: number;
  pts: [number, number][];
}

interface DragState {
  id: string;
  pageIndex: number;
  mode: 'move' | 'line-end' | 'rect-corner';
  handleIndex: number;
  startClientX: number;
  startClientY: number;
  startPts: [number, number][];
}

// Work-in-progress points of the shape being dragged, in page-local px.
interface DraftState {
  id: string;
  pageIndex: number;
  pts: [number, number][];
}

interface TextEditState {
  id: string;
  pageIndex: number;
  x: number;
  y: number;
  value: string;
}

const HANDLE_HIT_PX = 9;
const EDGE_HIT_PX = 8;
const TEXT_PAD_PX = 4;
const SELECTION_COLOR = '#3b82f6';

const distToSegment = (
  px: number,
  py: number,
  [ax, ay]: [number, number],
  [bx, by]: [number, number],
) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

const rectBounds = (pts: [number, number][]) => {
  const a = pts[0]!;
  const b = pts[1]!;
  return {
    x0: Math.min(a[0], b[0]),
    y0: Math.min(a[1], b[1]),
    x1: Math.max(a[0], b[0]),
    y1: Math.max(a[1], b[1]),
  };
};

const CORNERS: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

// Text hit box: anchor plus an estimated glyph run (0.6em average advance —
// no real text metrics exist in user space; close enough for picking).
const textBox = (drawing: PdfDrawing, pts: [number, number][], scale: number) => {
  const [x, y] = pts[0]!;
  const fontSize = (drawing.fontSize ?? 12) * scale;
  return {
    x0: x - TEXT_PAD_PX,
    y0: y - TEXT_PAD_PX,
    x1: x + (drawing.text?.length ?? 1) * fontSize * 0.6 + TEXT_PAD_PX,
    y1: y + fontSize * 1.3 + TEXT_PAD_PX,
  };
};

// Persistent editor for a PDF book's drawing annotations: click to select,
// drag to move, handles to adjust endpoints/corners, double-click text to
// re-edit its content, Delete to remove. Armed from the quick-action menu and
// stays active until Done/Escape. All interaction happens in screen space on
// this overlay; the in-page SVG layers stay pointer-transparent.
const PdfShapeEditor: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { appService, envConfig } = useEnv();
  const { settings } = useSettingsStore();
  const { getView } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const isPdf = getBookData(bookKey)?.book?.format === 'PDF';

  const drawings = usePdfDrawingsStore((s) => s.drawingsByBook[bookKey]);
  const penStrokeWidth = usePdfDrawingsStore((s) => s.penStrokeWidth);
  const setPenStrokeWidth = usePdfDrawingsStore((s) => s.setPenStrokeWidth);
  const penFontSize = usePdfDrawingsStore((s) => s.penFontSize);
  const setPenFontSize = usePdfDrawingsStore((s) => s.setPenFontSize);
  const penBackground = usePdfDrawingsStore((s) => s.penBackground);
  const setPenBackground = usePdfDrawingsStore((s) => s.setPenBackground);
  const setPenArrow = usePdfDrawingsStore((s) => s.setPenArrow);
  const drawingsRef = useRef<PdfDrawing[]>([]);
  drawingsRef.current = drawings ?? [];

  const [pages, setPages] = useState<PageRect[]>([]);
  const pagesRef = useRef<PageRect[]>([]);
  pagesRef.current = pages;
  const [geom, setGeom] = useState<Map<string, ShapeGeom>>(new Map());
  const geomRef = useRef(geom);
  geomRef.current = geom;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const draftRef = useRef<DraftState | null>(null);
  draftRef.current = draft;
  const [editing, setEditing] = useState<TextEditState | null>(null);
  const [hovering, setHovering] = useState(false);
  const dragRef = useRef<DragState | null>(null);

  const highlightStyle = settings.globalReadSettings.highlightStyle;
  const defaultColor =
    getHighlightColorHex(settings, settings.globalReadSettings.highlightStyles[highlightStyle]) ??
    '#f87171';
  const [color, setColor] = useState(defaultColor);
  const palette = DEFAULT_HIGHLIGHT_COLORS.map(
    (c) => getHighlightColorHex(settings, c) ?? defaultColor,
  );

  const geometryCache = useRef(new Map<number, { width: number; height: number }>());

  const deactivate = useCallback(() => {
    saveViewSettings(envConfig, bookKey, 'annotationQuickAction', null, false, true);
  }, [envConfig, bookKey]);

  useEffect(() => {
    seedPdfDrawings(bookKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  // Sidebar section (and any future entry point) asks the editor to select a
  // specific drawing through the store; consume it whenever it appears.
  const pendingSelectId = usePdfDrawingsStore((s) => s.pendingSelectId);
  useEffect(() => {
    if (!pendingSelectId) return;
    setSelectedId(pendingSelectId);
    usePdfDrawingsStore.getState().setPendingSelect(null);
  }, [pendingSelectId]);

  // Same per-frame page scan as the other PDF overlays, so handles follow
  // page turns, zooms and resizes.
  useEffect(() => {
    let raf = 0;
    const scan = () => {
      raf = requestAnimationFrame(scan);
      const view = getView(bookKey);
      const contents = view?.renderer?.getContents?.() ?? [];
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const next: PageRect[] = [];
      for (const { doc, index } of contents) {
        if (index == null || !doc) continue;
        const frame = doc.defaultView?.frameElement as HTMLElement | null;
        if (!frame) continue;
        const rect = frame.getBoundingClientRect();
        if (
          rect.width < 20 ||
          rect.height < 20 ||
          rect.right < -40 ||
          rect.left > vw + 40 ||
          rect.bottom < -40 ||
          rect.top > vh + 40
        )
          continue;
        next.push({
          index,
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
        });
      }
      next.sort((a, b) => a.index - b.index);
      setPages((prev) =>
        prev.length === next.length &&
        prev.every((p, i) => {
          const q = next[i]!;
          return (
            p.index === q.index &&
            Math.abs(p.left - q.left) < 0.5 &&
            Math.abs(p.top - q.top) < 0.5 &&
            Math.abs(p.width - q.width) < 0.5 &&
            Math.abs(p.height - q.height) < 0.5
          );
        })
          ? prev
          : next,
      );
    };
    raf = requestAnimationFrame(scan);
    return () => cancelAnimationFrame(raf);
  }, [bookKey, getView]);

  const getGeometry = useCallback(
    async (index: number) => {
      const book = getView(bookKey)?.book;
      if (!book?.getPdfPageSize || !book?.convertToViewportPoint) return null;
      const cached = geometryCache.current.get(index);
      if (cached) return cached;
      const geometry = await book.getPdfPageSize(index);
      geometryCache.current.set(index, geometry);
      return geometry;
    },
    [bookKey, getView],
  );

  const pageScaleOf = useCallback((pageIndex: number) => {
    const geometry = geometryCache.current.get(pageIndex);
    const page = pagesRef.current.find((p) => p.index === pageIndex);
    return geometry && page ? page.width / geometry.width : null;
  }, []);

  // Recompute page-local screen coords whenever the drawing list or the zoom
  // level changes. Scroll moves pageRects, not these page-local coords.
  const scaleSig = pages.map((p) => Math.round(p.width)).join(',');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const book = getView(bookKey)?.book;
      if (!book?.convertToViewportPoint) return;
      const next = new Map<string, ShapeGeom>();
      for (const drawing of drawingsRef.current) {
        const geometry = await getGeometry(drawing.pageIndex);
        const page = pagesRef.current.find((p) => p.index === drawing.pageIndex);
        if (!geometry || !page) continue;
        const scale = page.width / geometry.width;
        const pts = await Promise.all(
          drawing.points.map(([x, y]) =>
            book.convertToViewportPoint!(drawing.pageIndex, x, y, scale),
          ),
        );
        if (cancelled) return;
        next.set(drawing.id, { pageIndex: drawing.pageIndex, pts });
      }
      if (!cancelled) setGeom(next);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawings, scaleSig]);

  // Drop a stale selection when its drawing is deleted elsewhere (sidebar).
  useEffect(() => {
    if (selectedId && !drawingsRef.current.some((d) => d.id === selectedId)) {
      setSelectedId(null);
    }
  }, [drawings, selectedId]);

  const hitPageAt = (clientX: number, clientY: number) =>
    pagesRef.current.find(
      (p) =>
        clientX >= p.left &&
        clientX <= p.left + p.width &&
        clientY >= p.top &&
        clientY <= p.top + p.height,
    );

  const hitTest = useCallback((clientX: number, clientY: number): PdfDrawing | null => {
    const page = hitPageAt(clientX, clientY);
    if (!page) return null;
    const lx = clientX - page.left;
    const ly = clientY - page.top;
    const items = drawingsRef.current.filter((d) => d.pageIndex === page.index);
    for (let i = items.length - 1; i >= 0; i--) {
      const drawing = items[i]!;
      const g = geomRef.current.get(drawing.id);
      if (!g) continue;
      if (drawing.type === 'line') {
        if (distToSegment(lx, ly, g.pts[0]!, g.pts[1]!) <= EDGE_HIT_PX) return drawing;
      } else if (drawing.type === 'rect') {
        const { x0, y0, x1, y1 } = rectBounds(g.pts);
        const nearX =
          (Math.abs(lx - x0) <= EDGE_HIT_PX || Math.abs(lx - x1) <= EDGE_HIT_PX) &&
          ly >= y0 - EDGE_HIT_PX &&
          ly <= y1 + EDGE_HIT_PX;
        const nearY =
          (Math.abs(ly - y0) <= EDGE_HIT_PX || Math.abs(ly - y1) <= EDGE_HIT_PX) &&
          lx >= x0 - EDGE_HIT_PX &&
          lx <= x1 + EDGE_HIT_PX;
        const inside = lx > x0 && lx < x1 && ly > y0 && ly < y1;
        if (nearX || nearY || inside) return drawing;
      } else {
        const scale = pageScaleOf(page.index) ?? 1;
        const b = textBox(drawing, g.pts, scale);
        if (lx >= b.x0 && lx <= b.x1 && ly >= b.y0 && ly <= b.y1) return drawing;
      }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageScaleOf]);

  // Handles of the selected shape (line endpoints / rect corners), in
  // page-local coords. Text has no handles — it moves by body drag.
  const selectedHandles = useCallback((): ShapeGeom | null => {
    if (!selectedId) return null;
    const g = geomRef.current.get(selectedId);
    const drawing = drawingsRef.current.find((d) => d.id === selectedId);
    if (!g || !drawing || drawing.type === 'text') return null;
    if (drawing.type === 'line') return g;
    const { x0, y0, x1, y1 } = rectBounds(g.pts);
    return {
      pageIndex: g.pageIndex,
      pts: CORNERS.map(([cx, cy]) => [cx ? x1 : x0, cy ? y1 : y0]),
    };
  }, [selectedId]);

  const hitHandle = useCallback(
    (clientX: number, clientY: number) => {
      const handles = selectedHandles();
      if (!handles) return null;
      const page = pagesRef.current.find((p) => p.index === handles.pageIndex);
      if (!page) return null;
      const lx = clientX - page.left;
      const ly = clientY - page.top;
      for (let i = 0; i < handles.pts.length; i++) {
        const [hx, hy] = handles.pts[i]!;
        if (Math.hypot(lx - hx, ly - hy) <= HANDLE_HIT_PX) return { handleIndex: i, page };
      }
      return null;
    },
    [selectedHandles],
  );

  const commitPts = useCallback(
    async (id: string, pageIndex: number, pts: [number, number][]) => {
      const geometry = await getGeometry(pageIndex);
      const book = getView(bookKey)?.book;
      const scale = pageScaleOf(pageIndex);
      if (!geometry || !book?.convertToPdfPoint || !scale) return;
      const userPts = await Promise.all(
        pts.map(([x, y]) => book.convertToPdfPoint!(pageIndex, x, y, scale)),
      );
      const next = drawingsRef.current.map((d) => (d.id === id ? { ...d, points: userPts } : d));
      await applyPdfDrawings(bookKey, next, appService);
    },
    [appService, bookKey, getGeometry, getView, pageScaleOf],
  );

  const onDragMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startClientX;
    const dy = e.clientY - drag.startClientY;
    let pts: [number, number][];
    if (drag.mode === 'move') {
      pts = drag.startPts.map(([x, y]) => [x + dx, y + dy]);
    } else if (drag.mode === 'line-end') {
      const fixed = drag.startPts[1 - drag.handleIndex]!;
      const moved = drag.startPts[drag.handleIndex]!;
      let x = moved[0] + dx;
      let y = moved[1] + dy;
      if (e.ctrlKey) {
        // Snap to the nearest 45° direction (0/45/90/...), keeping the
        // length the pointer is holding.
        const ddx = x - fixed[0];
        const ddy = y - fixed[1];
        const length = Math.hypot(ddx, ddy);
        if (length > 0) {
          const angle = Math.round(Math.atan2(ddy, ddx) / (Math.PI / 4)) * (Math.PI / 4);
          x = fixed[0] + Math.cos(angle) * length;
          y = fixed[1] + Math.sin(angle) * length;
        }
      }
      pts = drag.startPts.map((_, i) => (i === drag.handleIndex ? [x, y] : fixed));
    } else {
      // Dragging one rect corner; the opposite corner stays put. Store the
      // normalized pair (top-left, bottom-right) — drawShapes takes any
      // opposite pair, but keeping it normalized keeps handles stable.
      const { x0, y0, x1, y1 } = rectBounds(drag.startPts);
      const [cxFlag, cyFlag] = CORNERS[drag.handleIndex]!;
      let cx = cxFlag ? x1 + dx : x0 + dx;
      let cy = cyFlag ? y1 + dy : y0 + dy;
      if (e.ctrlKey) {
        // Lock to a square: equalize the signed extents from the static
        // corner to the larger of the two.
        const oppX = cxFlag ? x0 : x1;
        const oppY = cyFlag ? y0 : y1;
        let sw = cx - oppX;
        let sh = cy - oppY;
        const size = Math.max(Math.abs(sw), Math.abs(sh));
        sw = (sw < 0 ? -1 : 1) * size;
        sh = (sh < 0 ? -1 : 1) * size;
        cx = oppX + sw;
        cy = oppY + sh;
      }
      pts = [
        [Math.min(cx, cxFlag ? x0 : x1), Math.min(cy, cyFlag ? y0 : y1)],
        [Math.max(cx, cxFlag ? x0 : x1), Math.max(cy, cyFlag ? y0 : y1)],
      ];
    }
    setDraft({ id: drag.id, pageIndex: drag.pageIndex, pts });
  }, []);

  const onDragEnd = useCallback(() => {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragEnd);
    window.removeEventListener('pointercancel', onDragEnd);
    const drag = dragRef.current;
    dragRef.current = null;
    const current = draftRef.current;
    setDraft(null);
    if (!drag) return;
    if (current) {
      // Commit first (setDrawings repaints with the drawing still hidden, so
      // the old position never flashes), then unhide to reveal the new spot.
      void commitPts(current.id, current.pageIndex, current.pts).then(() => {
        getView(bookKey)?.book?.hideDrawing?.(null);
      });
    } else {
      // A click without movement: nothing committed, restore the shape.
      getView(bookKey)?.book?.hideDrawing?.(null);
    }
  }, [bookKey, commitPts, getView, onDragMove]);

  // Drop the window drag listeners if the editor unmounts mid-drag, and make
  // sure a hidden shape never stays blanked after the editor is gone.
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragEnd);
      window.removeEventListener('pointercancel', onDragEnd);
      useReaderStore.getState().getView(bookKey)?.book?.hideDrawing?.(null);
    },
    [bookKey, onDragMove, onDragEnd],
  );

  const startDrag = (
    e: React.PointerEvent,
    id: string,
    pageIndex: number,
    mode: DragState['mode'],
    handleIndex: number,
    startPts: [number, number][],
  ) => {
    // Blank the committed shape so the drag preview is the only copy on
    // screen (line/rect used to show as a double image; text didn't move).
    getView(bookKey)?.book?.hideDrawing?.(id);
    dragRef.current = {
      id,
      pageIndex,
      mode,
      handleIndex,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPts,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd);
    window.addEventListener('pointercancel', onDragEnd);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (editing) return; // the input's blur commit handles it
    e.preventDefault();

    const handle = hitHandle(e.clientX, e.clientY);
    if (handle && selectedId) {
      const g = geomRef.current.get(selectedId)!;
      const drawing = drawingsRef.current.find((d) => d.id === selectedId)!;
      startDrag(
        e,
        selectedId,
        handle.page.index,
        drawing.type === 'line' ? 'line-end' : 'rect-corner',
        handle.handleIndex,
        g.pts,
      );
      return;
    }

    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) {
      setSelectedId(null);
      return;
    }
    setSelectedId(hit.id);
    const g = geomRef.current.get(hit.id)!;
    startDrag(e, hit.id, g.pageIndex, 'move', -1, g.pts);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit || hit.type !== 'text') return;
    const g = geomRef.current.get(hit.id);
    if (!g) return;
    const [x, y] = g.pts[0]!;
    setEditing({ id: hit.id, pageIndex: hit.pageIndex, x, y, value: hit.text ?? '' });
  };

  const commitTextEdit = useCallback(async () => {
    const input = editing;
    setEditing(null);
    if (!input) return;
    const drawing = drawingsRef.current.find((d) => d.id === input.id);
    if (!drawing) return;
    const text = input.value.trim();
    if (text === (drawing.text ?? '').trim()) return;
    if (!text) {
      // Emptied text means delete the shape.
      await applyPdfDrawings(
        bookKey,
        drawingsRef.current.filter((d) => d.id !== input.id),
        appService,
      );
      setSelectedId(null);
      return;
    }
    await applyPdfDrawings(
      bookKey,
      drawingsRef.current.map((d) => (d.id === input.id ? { ...d, text } : d)),
      appService,
    );
  }, [appService, bookKey, editing]);

  const deleteSelected = useCallback(async () => {
    if (!selectedId) return;
    await applyPdfDrawings(
      bookKey,
      drawingsRef.current.filter((d) => d.id !== selectedId),
      appService,
    );
    setSelectedId(null);
  }, [appService, bookKey, selectedId]);

  const applyColor = useCallback(
    async (hex: string) => {
      setColor(hex);
      if (!selectedId) return;
      await applyPdfDrawings(
        bookKey,
        drawingsRef.current.map((d) => (d.id === selectedId ? { ...d, color: hex } : d)),
        appService,
      );
    },
    [appService, bookKey, selectedId],
  );

  // Pen-width / font-size / background: clicking sets the pen default, and
  // when a shape of the matching kind is selected it is restyled in place.
  const selectedDrawing = selectedId
    ? drawingsRef.current.find((d) => d.id === selectedId)
    : undefined;

  const applyStrokeWidth = useCallback(
    async (w: number) => {
      setPenStrokeWidth(w);
      if (!selectedId || !selectedDrawing || selectedDrawing.type === 'text') return;
      await applyPdfDrawings(
        bookKey,
        drawingsRef.current.map((d) => (d.id === selectedId ? { ...d, strokeWidth: w } : d)),
        appService,
      );
    },
    [appService, bookKey, selectedDrawing, selectedId, setPenStrokeWidth],
  );

  const applyArrow = useCallback(
    async (arrow: boolean) => {
      setPenArrow(arrow);
      if (!selectedId || !selectedDrawing || selectedDrawing.type !== 'line') return;
      await applyPdfDrawings(
        bookKey,
        drawingsRef.current.map((d) =>
          d.id === selectedId ? { ...d, ...(arrow ? { arrow: true } : { arrow: undefined }) } : d,
        ),
        appService,
      );
    },
    [appService, bookKey, selectedDrawing, selectedId, setPenArrow],
  );

  const applyFontSize = useCallback(
    async (size: number) => {
      setPenFontSize(size);
      if (!selectedId || !selectedDrawing || selectedDrawing.type !== 'text') return;
      await applyPdfDrawings(
        bookKey,
        drawingsRef.current.map((d) => (d.id === selectedId ? { ...d, fontSize: size } : d)),
        appService,
      );
    },
    [appService, bookKey, selectedDrawing, selectedId, setPenFontSize],
  );

  const applyBackground = useCallback(
    async (color?: string) => {
      setPenBackground(color);
      if (!selectedId || !selectedDrawing || selectedDrawing.type !== 'text') return;
      await applyPdfDrawings(
        bookKey,
        drawingsRef.current.map((d) =>
          d.id === selectedId ? { ...d, background: color } : d,
        ),
        appService,
      );
    },
    [appService, bookKey, selectedDrawing, selectedId, setPenBackground],
  );

  // Escape peels layers: close the text editor, then drop the selection,
  // then exit the editor. Delete removes the selected shape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (editing) {
          setEditing(null);
          e.stopPropagation();
        } else if (selectedId) {
          setSelectedId(null);
          e.stopPropagation();
        } else {
          deactivate();
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !editing) {
        e.preventDefault();
        void deleteSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deactivate, deleteSelected, editing, selectedId]);

  // Wheel keeps working so shapes on other pages stay reachable.
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) return;
    const renderer = getView(bookKey)?.renderer;
    if (!renderer) return;
    renderer.scrollTop += e.deltaY;
    renderer.scrollLeft += e.deltaX;
  };

  if (!isPdf) return null;

  const renderPageLayer = (page: PageRect) => {
    const pageDraft = draft?.pageIndex === page.index ? draft : null;
    const selectedGeom = selectedId ? geomRef.current.get(selectedId) : null;
    const selectedOnPage =
      !pageDraft && selectedGeom?.pageIndex === page.index ? selectedGeom : null;
    const selectedDrawing = selectedId
      ? drawingsRef.current.find((d) => d.id === selectedId)
      : undefined;
    const scale = pageScaleOf(page.index) ?? 1;
    const handles =
      selectedOnPage && selectedDrawing && selectedDrawing.type !== 'text'
        ? selectedDrawing.type === 'line'
          ? selectedOnPage.pts
          : (() => {
              const { x0, y0, x1, y1 } = rectBounds(selectedOnPage.pts);
              return CORNERS.map(([cx, cy]) => [cx ? x1 : x0, cy ? y1 : y0]);
            })()
        : null;
    const input = editing?.pageIndex === page.index ? editing : null;
    return (
      <div
        key={page.index}
        className='pointer-events-none fixed'
        style={{ left: page.left, top: page.top, width: page.width, height: page.height }}
      >
        {pageDraft &&
          (() => {
            const drawing = drawingsRef.current.find((d) => d.id === pageDraft.id);
            if (!drawing) return null;
            const [ax, ay] = pageDraft.pts[0]!;
            const [bx, by] = pageDraft.pts[1] ?? pageDraft.pts[0]!;
            if (drawing.type === 'text') {
              const fontSize = (drawing.fontSize ?? 12) * scale;
              return (
                <svg className='absolute left-0 top-0 h-full w-full'>
                  {drawing.background && (
                    <rect
                      x={ax - 2}
                      y={ay - 1}
                      width={(drawing.text?.length ?? 1) * fontSize * 0.6 + 4}
                      height={fontSize * 1.3 + 2}
                      rx={2}
                      fill={drawing.background}
                    />
                  )}
                  <text
                    x={ax}
                    y={ay}
                    fill={drawing.color}
                    fontSize={fontSize}
                    fontFamily='sans-serif'
                    dominantBaseline='text-before-edge'
                  >
                    {drawing.text}
                  </text>
                </svg>
              );
            }
            return (
              <svg className='absolute left-0 top-0 h-full w-full'>
                {drawing.type === 'line' ? (
                  <>
                    <line
                      x1={ax}
                      y1={ay}
                      x2={bx}
                      y2={by}
                      stroke={drawing.color}
                      strokeWidth={(drawing.strokeWidth ?? 2) * scale}
                      strokeLinecap='round'
                    />
                    {drawing.arrow &&
                      bx !== ax &&
                      by !== ay &&
                      [1, -1].map((sign) => {
                        const wingAngle =
                          Math.atan2(by - ay, bx - ax) + Math.PI + sign * 0.5;
                        const wing = Math.max(8, (drawing.strokeWidth ?? 2) * scale * 3);
                        return (
                          <line
                            key={sign}
                            x1={bx}
                            y1={by}
                            x2={bx + Math.cos(wingAngle) * wing}
                            y2={by + Math.sin(wingAngle) * wing}
                            stroke={drawing.color}
                            strokeWidth={(drawing.strokeWidth ?? 2) * scale}
                            strokeLinecap='round'
                          />
                        );
                      })}
                  </>
                ) : (
                  <rect
                    x={Math.min(ax, bx)}
                    y={Math.min(ay, by)}
                    width={Math.abs(bx - ax)}
                    height={Math.abs(by - ay)}
                    fill='none'
                    stroke={drawing.color}
                    strokeWidth={2 * scale}
                  />
                )}
              </svg>
            );
          })()}
        {selectedOnPage && selectedDrawing && (
          <svg className='absolute left-0 top-0 h-full w-full'>
            {selectedDrawing.type === 'rect' &&
              (() => {
                const { x0, y0, x1, y1 } = rectBounds(selectedOnPage.pts);
                return (
                  <rect
                    x={x0}
                    y={y0}
                    width={x1 - x0}
                    height={y1 - y0}
                    fill='none'
                    stroke={SELECTION_COLOR}
                    strokeWidth={1}
                    strokeDasharray='4 3'
                  />
                );
              })()}
            {selectedDrawing.type === 'line' && (
              <line
                x1={selectedOnPage.pts[0]![0]}
                y1={selectedOnPage.pts[0]![1]}
                x2={selectedOnPage.pts[1]![0]}
                y2={selectedOnPage.pts[1]![1]}
                stroke={SELECTION_COLOR}
                strokeWidth={1}
                strokeDasharray='4 3'
                opacity={0.6}
              />
            )}
            {selectedDrawing.type === 'text' &&
              (() => {
                // Same visual language as line/rect: dashed outline plus a
                // handle dot, so the selection is obvious on a text shape too.
                const b = textBox(selectedDrawing, selectedOnPage.pts, scale);
                return (
                  <>
                    <rect
                      x={b.x0}
                      y={b.y0}
                      width={b.x1 - b.x0}
                      height={b.y1 - b.y0}
                      fill='none'
                      stroke={SELECTION_COLOR}
                      strokeWidth={1}
                      strokeDasharray='4 3'
                      opacity={0.6}
                    />
                    <circle
                      cx={selectedOnPage.pts[0]![0]}
                      cy={selectedOnPage.pts[0]![1]}
                      r={HANDLE_HIT_PX / 2}
                      fill={SELECTION_COLOR}
                    />
                  </>
                );
              })()}
          </svg>
        )}
        {handles &&
          handles.map((h, i) => (
            <div
              key={i}
              className='rounded-full border bg-base-100'
              style={{
                position: 'absolute',
                left: h[0]! - HANDLE_HIT_PX / 2,
                top: h[1]! - HANDLE_HIT_PX / 2,
                width: HANDLE_HIT_PX,
                height: HANDLE_HIT_PX,
                borderColor: SELECTION_COLOR,
              }}
            />
          ))}
        {input && (
          <input
            autoFocus
            className='eink-bordered absolute rounded-sm border px-1 outline-hidden'
            style={{
              left: input.x,
              top: input.y,
              width: Math.min(page.width * 0.6, 320),
              color: selectedDrawing?.color ?? defaultColor,
              background:
                selectedDrawing?.background ??
                'color-mix(in srgb, var(--color-base-100) 80%, transparent)',
              fontSize: (selectedDrawing?.fontSize ?? 12) * scale,
              lineHeight: 1.2,
            }}
            value={input.value}
            onChange={(e) =>
              setEditing((prev) => (prev ? { ...prev, value: e.target.value } : prev))
            }
            onBlur={(e) => {
              const target = e.relatedTarget;
              if (target instanceof Element && target.closest('[data-shape-toolbar]')) return;
              void commitTextEdit();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitTextEdit();
              } else if (e.key === 'Escape') {
                setEditing(null);
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
        )}
      </div>
    );
  };

  return (
    <div
      role='application'
      aria-label={_('PDF Drawing Tools')}
      className={clsx(
        'no-context-menu fixed inset-0 z-50 touch-none select-none',
        hovering ? 'cursor-move' : 'cursor-default',
      )}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerMove={(e) => {
        if (dragRef.current || editing) return;
        const over = !!hitTest(e.clientX, e.clientY) || !!hitHandle(e.clientX, e.clientY);
        setHovering((prev) => (prev === over ? prev : over));
      }}
      onWheel={handleWheel}
    >
      {pages.map(renderPageLayer)}
      <div
        data-shape-toolbar=''
        className='eink-bordered fixed bottom-8 left-1/2 z-10 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-full bg-base-100 px-3 py-2 shadow-lg'
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className='hidden px-2 text-xs whitespace-nowrap text-base-content/80 sm:inline'>
          {_('Click a drawing to select, drag to move or resize')}
        </span>
        {(selectedDrawing?.type === 'line' || selectedDrawing?.type === 'rect') && (
          <>
            {PDF_STROKE_WIDTHS.map((w) => (
              <button
                key={w}
                title={_('Stroke Width') + ` ${w}`}
                className={clsx(
                  'flex h-6 w-6 items-center justify-center rounded-full',
                  penStrokeWidth === w ? 'bg-base-300' : '',
                )}
                onClick={() => void applyStrokeWidth(w)}
              >
                <span
                  className='bg-base-content rounded-full'
                  style={{ width: 2 + w * 1.2, height: 2 + w * 1.2 }}
                />
              </button>
            ))}
            <div className='bg-base-content/10 mx-1 h-5 w-px' />
          </>
        )}
        {selectedDrawing?.type === 'line' && (
          <button
            title={_('Arrow')}
            className={clsx(
              'flex h-6 w-6 items-center justify-center rounded-full',
              selectedDrawing.arrow ? 'bg-base-300' : '',
            )}
            onClick={() => void applyArrow(!selectedDrawing.arrow)}
          >
            <FiArrowUpRight />
          </button>
        )}
        {selectedDrawing?.type === 'line' && (
          <div className='bg-base-content/10 mx-1 h-5 w-px' />
        )}
        {palette.map((hex) => (
          <button
            key={hex}
            title={hex}
            className={clsx(
              'h-5 w-5 rounded-full border',
              color === hex ? 'border-base-content' : 'border-base-content/25',
            )}
            style={{ backgroundColor: hex }}
            onClick={() => void applyColor(hex ?? defaultColor)}
          />
        ))}
        {selectedDrawing?.type === 'text' && (
          <>
            <div className='bg-base-content/10 mx-1 h-5 w-px' />
            {PDF_FONT_SIZES.map((size) => (
              <button
                key={size}
                title={_('Font Size') + ` ${size}`}
                className={clsx(
                  'h-6 min-w-6 rounded-full px-1 text-xs',
                  penFontSize === size ? 'bg-base-300 font-semibold' : 'text-base-content/80',
                )}
                onClick={() => void applyFontSize(size)}
              >
                {size}
              </button>
            ))}
            <button
              title={_('No Background')}
              className={clsx(
                'flex h-5 w-5 items-center justify-center rounded-full border',
                penBackground ? 'border-base-content/25' : 'border-base-content',
              )}
              onClick={() => void applyBackground(undefined)}
            >
              <span className='bg-base-content/60 block h-px w-3 rotate-45' />
            </button>
            {PDF_BACKGROUND_COLORS.map((hex) => (
              <button
                key={hex}
                title={_('Background Color') + ` ${hex}`}
                className={clsx(
                  'h-5 w-5 rounded-full border',
                  penBackground === hex ? 'border-base-content' : 'border-base-content/25',
                )}
                style={{ backgroundColor: hex }}
                onClick={() => void applyBackground(hex)}
              />
            ))}
          </>
        )}
        {selectedId && (
          <button className='btn btn-sm btn-ghost' onClick={() => void deleteSelected()}>
            {_('Delete')}
          </button>
        )}
        <button className='btn btn-sm btn-contrast' onClick={deactivate}>
          {_('Done')}
        </button>
      </div>
    </div>
  );
};

export default PdfShapeEditor;
