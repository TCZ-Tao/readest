import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FiCornerUpLeft } from 'react-icons/fi';

import { DEFAULT_HIGHLIGHT_COLORS, PdfDrawing } from '@/types/book';
import { PdfDrawToolType } from '@/types/annotator';
import { useEnv } from '@/context/EnvContext';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { applyPdfDrawings, seedPdfDrawings, usePdfDrawingsStore } from '@/store/pdfDrawingsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { saveViewSettings } from '@/helpers/settings';
import { useTranslation } from '@/hooks/useTranslation';
import { getHighlightColorHex } from '../utils/annotatorUtil';
import { uniqueId } from '@/utils/misc';

interface PageRect {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface StrokeState {
  pageIndex: number;
  // The page's on-screen origin at stroke start; pointer moves arrive in
  // client coords and must be brought back into page-local space.
  offsetX: number;
  offsetY: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface TextInputState {
  pageIndex: number;
  x: number;
  y: number;
  value: string;
}

// Default text size and stroke width in PDF user-space units (pt); on screen
// they multiply by the current page scale so they track zoom like real PDF
// annotations.
const DEFAULT_FONT_SIZE = 12;
const DEFAULT_STROKE_WIDTH = 2;
// A drag shorter than this is a tap, not a stroke.
const MIN_STROKE_PX = 4;

const PdfDrawOverlay: React.FC<{ bookKey: string; tool: PdfDrawToolType }> = ({
  bookKey,
  tool,
}) => {
  const _ = useTranslation();
  const { appService, envConfig } = useEnv();
  const { settings } = useSettingsStore();
  const { getView } = useReaderStore();
  const { getBookData } = useBookDataStore();
  const bookData = getBookData(bookKey);
  const isPdf = bookData?.book?.format === 'PDF';

  const highlightStyle = settings.globalReadSettings.highlightStyle;
  const defaultColor =
    getHighlightColorHex(settings, settings.globalReadSettings.highlightStyles[highlightStyle]) ??
    '#f87171';
  const palette = DEFAULT_HIGHLIGHT_COLORS.map(
    (color) => getHighlightColorHex(settings, color) ?? defaultColor,
  );

  const [color, setColor] = useState(defaultColor);
  const [pages, setPages] = useState<PageRect[]>([]);
  const [preview, setPreview] = useState<StrokeState | null>(null);
  const [textInput, setTextInput] = useState<TextInputState | null>(null);
  const pagesRef = useRef<PageRect[]>([]);
  pagesRef.current = pages;
  const strokeRef = useRef<StrokeState | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  // Scale-1 viewport dims per page index, cached to derive the display scale.
  const geometryCache = useRef(new Map<number, { width: number; height: number }>());

  const deactivate = useCallback(() => {
    saveViewSettings(envConfig, bookKey, 'annotationQuickAction', null, false, true);
  }, [envConfig, bookKey]);

  // Track the on-screen rects of the visible pages every frame, so strokes
  // stay bound to the page they started on across page turns, zooms and
  // window resizes without wiring into the renderer's events. (Same scan as
  // PdfCropOverlay.)
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
      if (!book?.getPdfPageSize || !book?.convertToPdfPoint) return null;
      const cached = geometryCache.current.get(index);
      if (cached) return cached;
      const geometry = await book.getPdfPageSize(index);
      geometryCache.current.set(index, geometry);
      return geometry;
    },
    [bookKey, getView],
  );

  const commitDrawing = useCallback(
    async (drawing: PdfDrawing) => {
      // Seed from the foliate book first: it holds the truth loaded at open
      // time, and this overlay may be the first touch of the store.
      seedPdfDrawings(bookKey);
      const current = usePdfDrawingsStore.getState().drawingsByBook[bookKey] ?? [];
      await applyPdfDrawings(bookKey, [...current, drawing], appService);
      // One-shot: disarm after the stroke lands, Zotero-style.
      deactivate();
    },
    [appService, bookKey, deactivate],
  );

  const undoLastDrawing = useCallback(async () => {
    seedPdfDrawings(bookKey);
    const current = usePdfDrawingsStore.getState().drawingsByBook[bookKey] ?? [];
    if (current.length === 0) return;
    await applyPdfDrawings(bookKey, current.slice(0, -1), appService);
  }, [appService, bookKey]);

  const strokeToDrawing = useCallback(
    async (stroke: StrokeState) => {
      const page = pagesRef.current.find((p) => p.index === stroke.pageIndex);
      if (!page) return;
      const geometry = await getGeometry(stroke.pageIndex);
      const book = getView(bookKey)?.book;
      if (!geometry || !book?.convertToPdfPoint) return;
      const scale = page.width / geometry.width;
      const clampX = (v: number) => Math.min(Math.max(v, 0), page.width);
      const clampY = (v: number) => Math.min(Math.max(v, 0), page.height);
      const [x1, y1] = await book.convertToPdfPoint(
        stroke.pageIndex,
        clampX(stroke.startX),
        clampY(stroke.startY),
        scale,
      );
      const [x2, y2] = await book.convertToPdfPoint(
        stroke.pageIndex,
        clampX(stroke.endX),
        clampY(stroke.endY),
        scale,
      );
      await commitDrawing({
        id: uniqueId(),
        pageIndex: stroke.pageIndex,
        type: toolRef.current === 'pdf-line' ? 'line' : 'rect',
        points: [
          [x1, y1],
          [x2, y2],
        ],
        color,
        strokeWidth: DEFAULT_STROKE_WIDTH,
      });
    },
    [color, commitDrawing, bookKey, getGeometry, getView],
  );

  const onStrokeMove = useCallback((e: PointerEvent) => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    stroke.endX = e.clientX - stroke.offsetX;
    stroke.endY = e.clientY - stroke.offsetY;
    setPreview({ ...stroke });
  }, []);

  const onStrokeEnd = useCallback(() => {
    window.removeEventListener('pointermove', onStrokeMove);
    window.removeEventListener('pointerup', onStrokeEnd);
    window.removeEventListener('pointercancel', onStrokeEnd);
    const stroke = strokeRef.current;
    strokeRef.current = null;
    setPreview(null);
    if (!stroke) return;
    const distance = Math.hypot(stroke.endX - stroke.startX, stroke.endY - stroke.startY);
    if (distance < MIN_STROKE_PX) return;
    void strokeToDrawing(stroke);
  }, [onStrokeMove, strokeToDrawing]);

  const hitPage = (clientX: number, clientY: number) =>
    pagesRef.current.find(
      (p) =>
        clientX >= p.left &&
        clientX <= p.left + p.width &&
        clientY >= p.top &&
        clientY <= p.top + p.height,
    );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const page = hitPage(e.clientX, e.clientY);
    if (!page) return;
    const x = e.clientX - page.left;
    const y = e.clientY - page.top;
    // Warm the geometry cache so the stroke preview (and the text input)
    // render at the page's true scale from the first frame.
    void getGeometry(page.index);
    if (tool === 'pdf-text') {
      // Without this the browser's pointerdown focus default (target is not
      // focusable, focus falls to <body>) lands AFTER React's sync commit and
      // its autoFocus, instantly blurring the input — which commits the empty
      // text and unmounts it within the same frame.
      e.preventDefault();
      setTextInput({ pageIndex: page.index, x, y, value: '' });
      return;
    }
    e.preventDefault();
    const stroke: StrokeState = {
      pageIndex: page.index,
      offsetX: page.left,
      offsetY: page.top,
      startX: x,
      startY: y,
      endX: x,
      endY: y,
    };
    strokeRef.current = stroke;
    setPreview(stroke);
    window.addEventListener('pointermove', onStrokeMove);
    window.addEventListener('pointerup', onStrokeEnd);
    window.addEventListener('pointercancel', onStrokeEnd);
  };

  // Drop the window stroke listeners if the overlay unmounts mid-stroke
  // (tool switched from the header while the pointer was down).
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onStrokeMove);
      window.removeEventListener('pointerup', onStrokeEnd);
      window.removeEventListener('pointercancel', onStrokeEnd);
    },
    [onStrokeMove, onStrokeEnd],
  );

  // Escape cancels an open text input, otherwise disarms the tool.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (textInput) {
        setTextInput(null);
        e.stopPropagation();
        return;
      }
      deactivate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deactivate, textInput]);

  const commitTextInput = useCallback(async () => {
    const input = textInput;
    setTextInput(null);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const page = pagesRef.current.find((p) => p.index === input.pageIndex);
    if (!page) return;
    const geometry = await getGeometry(input.pageIndex);
    const book = getView(bookKey)?.book;
    if (!geometry || !book?.convertToPdfPoint) return;
    const scale = page.width / geometry.width;
    const [x, y] = await book.convertToPdfPoint(
      input.pageIndex,
      Math.min(Math.max(input.x, 0), page.width),
      Math.min(Math.max(input.y, 0), page.height),
      scale,
    );
    await commitDrawing({
      id: uniqueId(),
      pageIndex: input.pageIndex,
      type: 'text',
      points: [[x, y]],
      text,
      color,
      fontSize: DEFAULT_FONT_SIZE,
    });
  }, [bookKey, color, commitDrawing, getGeometry, getView, textInput]);

  if (!isPdf) return null;

  const renderPageLayer = (page: PageRect) => {
    const stroke = preview?.pageIndex === page.index ? preview : null;
    const scale = geometryCache.current.get(page.index);
    const strokeWidth = DEFAULT_STROKE_WIDTH * (scale ? page.width / scale.width : 1);
    const input = textInput?.pageIndex === page.index ? textInput : null;
    const inputFontSize = DEFAULT_FONT_SIZE * (scale ? page.width / scale.width : 1);
    return (
      <div
        key={page.index}
        className='fixed'
        style={{ left: page.left, top: page.top, width: page.width, height: page.height }}
      >
        {stroke && (
          <svg className='pointer-events-none absolute left-0 top-0 h-full w-full'>
            {tool === 'pdf-line' ? (
              <line
                x1={stroke.startX}
                y1={stroke.startY}
                x2={stroke.endX}
                y2={stroke.endY}
                stroke={color}
                strokeWidth={strokeWidth}
                strokeLinecap='round'
              />
            ) : (
              <rect
                x={Math.min(stroke.startX, stroke.endX)}
                y={Math.min(stroke.startY, stroke.endY)}
                width={Math.abs(stroke.endX - stroke.startX)}
                height={Math.abs(stroke.endY - stroke.startY)}
                fill='none'
                stroke={color}
                strokeWidth={strokeWidth}
              />
            )}
          </svg>
        )}
        {input && (
          <input
            autoFocus
            className='eink-bordered absolute rounded-sm border bg-base-100/80 px-1 outline-hidden'
            style={{
              left: input.x,
              top: input.y,
              width: Math.min(page.width * 0.6, 320),
              color,
              fontSize: inputFontSize,
              lineHeight: 1.2,
            }}
            value={input.value}
            placeholder={_('Type and press Enter')}
            onChange={(e) =>
              setTextInput((prev) => (prev ? { ...prev, value: e.target.value } : prev))
            }
            onBlur={(e) => {
              // A click on the toolbar (undo/cancel) shifts focus; committing
              // on that blur would disarm the tool before the button's own
              // click lands. Commit only when focus left for good.
              const target = e.relatedTarget;
              if (target instanceof Element && target.closest('[data-draw-toolbar]')) return;
              void commitTextInput();
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitTextInput();
              } else if (e.key === 'Escape') {
                setTextInput(null);
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
      className='no-context-menu fixed inset-0 z-50 cursor-crosshair touch-none select-none'
      onPointerDown={onPointerDown}
    >
      {pages.map(renderPageLayer)}
      <div
        data-draw-toolbar=''
        className='eink-bordered fixed bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-base-100 px-3 py-2 shadow-lg'
        onPointerDown={(e) => e.stopPropagation()}
      >
        <span className='px-2 text-xs whitespace-nowrap text-base-content/80'>
          {tool === 'pdf-text'
            ? _('Click to place text on the page')
            : _('Drag to draw on the page')}
        </span>
        {palette.map((hex) => (
          <button
            key={hex}
            title={hex}
            className={clsx(
              'h-5 w-5 rounded-full border',
              color === hex ? 'border-base-content' : 'border-base-content/25',
            )}
            style={{ backgroundColor: hex }}
            onClick={() => setColor(hex ?? defaultColor)}
          />
        ))}
        <button className='btn btn-sm btn-ghost' onClick={() => void undoLastDrawing()}>
          <FiCornerUpLeft />
          {_('Undo')}
        </button>
        <button className='btn btn-sm btn-ghost' onClick={deactivate}>
          {_('Cancel')}
        </button>
      </div>
    </div>
  );
};

export default PdfDrawOverlay;
