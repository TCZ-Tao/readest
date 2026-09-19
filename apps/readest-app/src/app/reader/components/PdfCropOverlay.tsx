import clsx from 'clsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PdfCropRect } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { saveViewSettings } from '@/helpers/settings';
import { useTranslation } from '@/hooks/useTranslation';

type DragMode = 'move' | 'left' | 'right' | 'top' | 'bottom' | 'tl' | 'tr' | 'bl' | 'br';

interface PageRect {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DragState {
  mode: DragMode;
  startX: number;
  startY: number;
  start: PdfCropRect;
  width: number;
  height: number;
}

const NO_CROP: PdfCropRect = { left: 0, top: 0, right: 0, bottom: 0 };
// Keep at least 5% of the page on every side so the crop can't collapse.
const MIN_CROP = 0.05;

const DRAG_AXES: Record<DragMode, { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean }> = {
  move: {},
  left: { left: true },
  right: { right: true },
  top: { top: true },
  bottom: { bottom: true },
  tl: { left: true, top: true },
  tr: { right: true, top: true },
  bl: { left: true, bottom: true },
  br: { right: true, bottom: true },
};

const HANDLES: { mode: DragMode; className: string }[] = [
  { mode: 'tl', className: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize' },
  { mode: 'tr', className: 'right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize' },
  { mode: 'bl', className: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize' },
  { mode: 'br', className: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize' },
  { mode: 'top', className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize' },
  { mode: 'bottom', className: 'bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 cursor-ns-resize' },
  { mode: 'left', className: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
  { mode: 'right', className: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize' },
];

const isUncropped = (crop: PdfCropRect) =>
  crop.left <= 0 && crop.top <= 0 && crop.right <= 0 && crop.bottom <= 0;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const PdfCropOverlay: React.FC<{ bookKey: string; onClose: () => void }> = ({
  bookKey,
  onClose,
}) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const getView = useReaderStore((s) => s.getView);
  const getViewSettings = useReaderStore((s) => s.getViewSettings);
  const viewSettings = getViewSettings(bookKey);
  const [crop, setCrop] = useState<PdfCropRect>(viewSettings?.pdfCrop ?? NO_CROP);
  const [pages, setPages] = useState<PageRect[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const cropRef = useRef(crop);
  cropRef.current = crop;

  // Track the on-screen rects of the visible pages every frame, so the crop
  // handles follow page turns, zooms and window resizes without wiring into
  // the renderer's events.
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onDragMove = useCallback((e: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / drag.width;
    const dy = (e.clientY - drag.startY) / drag.height;
    const { mode, start } = drag;
    const axes = DRAG_AXES[mode];
    let { left, top, right, bottom } = start;
    if (axes.left) left = clamp(start.left + dx, 0, 1 - start.right - MIN_CROP);
    if (axes.right) right = clamp(start.right - dx, 0, 1 - start.left - MIN_CROP);
    if (axes.top) top = clamp(start.top + dy, 0, 1 - start.bottom - MIN_CROP);
    if (axes.bottom) bottom = clamp(start.bottom - dy, 0, 1 - start.top - MIN_CROP);
    if (mode === 'move') {
      // Shift all four edges together, clamped to keep the rect inside the page.
      const width = 1 - start.left - start.right;
      const height = 1 - start.top - start.bottom;
      const newLeft = clamp(start.left + dx, 0, 1 - width);
      const newTop = clamp(start.top + dy, 0, 1 - height);
      left = newLeft;
      right = start.right - (newLeft - start.left);
      top = newTop;
      bottom = start.bottom - (newTop - start.top);
    }
    setCrop({ left, top, right, bottom });
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
  }, [onDragMove]);

  const startDrag = (e: React.PointerEvent, page: PageRect, mode: DragMode) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      start: cropRef.current,
      width: page.width,
      height: page.height,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  };

  const applyCrop = useCallback(
    async (value: PdfCropRect | null) => {
      const view = getView(bookKey);
      if (!view) return;
      view.book?.setCrop?.(value);
      // The renderer rebuilds its frames on a 'crop' attribute change.
      view.renderer.setAttribute(
        'crop',
        value ? `${value.left},${value.top},${value.right},${value.bottom}` : 'none',
      );
      await saveViewSettings(envConfig, bookKey, 'pdfCrop', value, true, false);
    },
    [bookKey, envConfig, getView],
  );

  const handleApply = async () => {
    await applyCrop(isUncropped(cropRef.current) ? null : cropRef.current);
    onClose();
  };

  const handleReset = async () => {
    setCrop(NO_CROP);
    await applyCrop(null);
  };

  // Wheel scrolling keeps working while the overlay is up, so the bottom of a
  // tall fit-width page can be reached to crop it.
  const handleWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) return;
    const renderer = getView(bookKey)?.renderer;
    if (!renderer) return;
    renderer.scrollTop += e.deltaY;
    renderer.scrollLeft += e.deltaX;
  };

  const renderPageLayer = (page: PageRect) => {
    const w = page.width;
    const h = page.height;
    const rectLeft = crop.left * w;
    const rectTop = crop.top * h;
    const rectWidth = Math.max(0, (1 - crop.left - crop.right) * w);
    const rectHeight = Math.max(0, (1 - crop.top - crop.bottom) * h);
    return (
      <div
        key={page.index}
        className='fixed'
        style={{ left: page.left, top: page.top, width: w, height: h }}
      >
        {/* Dim what will be cropped away */}
        <div className='absolute left-0 top-0 w-full bg-black/60' style={{ height: rectTop }} />
        <div
          className='absolute bottom-0 left-0 w-full bg-black/60'
          style={{ height: crop.bottom * h }}
        />
        <div
          className='absolute bg-black/60'
          style={{ left: 0, top: rectTop, width: rectLeft, height: rectHeight }}
        />
        <div
          className='absolute bg-black/60'
          style={{ right: 0, top: rectTop, width: crop.right * w, height: rectHeight }}
        />
        <div
          className='absolute cursor-move border-[1.5px] border-white'
          style={{ left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight }}
          onPointerDown={(e) => startDrag(e, page, 'move')}
        >
          {HANDLES.map(({ mode, className }) => (
            <div
              key={mode}
              className={clsx(
                'absolute flex items-center justify-center',
                (mode === 'top' || mode === 'bottom') && 'h-4 w-10',
                (mode === 'left' || mode === 'right') && 'h-10 w-4',
                mode.length === 2 && 'h-6 w-6',
                className,
              )}
              onPointerDown={(e) => startDrag(e, page, mode)}
            >
              <div
                className={clsx(
                  'rounded-full bg-white shadow-sm',
                  (mode === 'top' || mode === 'bottom') && 'h-1 w-6',
                  (mode === 'left' || mode === 'right') && 'h-6 w-1',
                  mode.length === 2 && 'h-2.5 w-2.5',
                )}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div
      role='dialog'
      aria-label={_('Crop Page Margins')}
      className='no-context-menu fixed inset-0 z-50 touch-none select-none'
      onWheel={handleWheel}
    >
      {pages.map(renderPageLayer)}
      <div className='eink-bordered fixed bottom-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-base-100 px-3 py-2 shadow-lg'>
        <span className='px-2 text-xs whitespace-nowrap text-base-content/80'>
          {_('Drag the borders to crop the page')}
        </span>
        <button className='btn btn-sm btn-ghost' onClick={handleReset}>
          {_('Reset')}
        </button>
        <button className='btn btn-sm btn-ghost' onClick={onClose}>
          {_('Cancel')}
        </button>
        <button className='btn btn-sm btn-contrast' onClick={handleApply}>
          {_('Apply')}
        </button>
      </div>
    </div>
  );
};

export default PdfCropOverlay;
