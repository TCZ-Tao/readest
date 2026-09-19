import React, { useEffect } from 'react';
import { FiSquare, FiSlash, FiType } from 'react-icons/fi';
import { RiDeleteBinLine } from 'react-icons/ri';

import { PdfDrawing } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { applyPdfDrawings, usePdfDrawingsStore } from '@/store/pdfDrawingsStore';
import { saveViewSettings } from '@/helpers/settings';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';

const TYPE_LABEL: Record<PdfDrawing['type'], string | null> = {
  line: 'Line',
  rect: 'Rectangle',
  text: null,
};

// Sidebar section listing a PDF book's drawing annotations (the page tools'
// output): jump to the page, or delete a stray shape. Shown in the
// annotations tab only, and only when the book has drawings.
const PdfDrawingsSection: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { appService, envConfig } = useEnv();
  const getView = useReaderStore((s) => s.getView);
  const drawings = usePdfDrawingsStore((s) => s.drawingsByBook[bookKey]);

  // The foliate book holds the truth loaded at open time; mirror it once so
  // the section renders without waiting for the first store write. The view
  // may still be opening when this mounts, so retry until it answers.
  useEffect(() => {
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trySeed = () => {
      const book = useReaderStore.getState().getView(bookKey)?.book;
      if (book?.getDrawings) {
        usePdfDrawingsStore.getState().setDrawings(bookKey, book.getDrawings());
      } else if (attempts++ < 50) {
        timer = setTimeout(trySeed, 200);
      }
    };
    trySeed();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  if (!drawings?.length) return null;

  const jumpTo = (pageIndex: number) => {
    // PDF TOC hrefs are JSON-encoded page indices; the navigate event closes
    // the sidebar on mobile like every other sidebar navigation.
    const href = JSON.stringify(pageIndex);
    eventDispatcher.dispatch('navigate', { bookKey, href });
    getView(bookKey)?.goTo(href);
  };

  // Clicking an entry jumps to its page and enters the shape editor with the
  // drawing pre-selected — the "edit this one" flow.
  const editDrawing = (drawing: PdfDrawing) => {
    usePdfDrawingsStore.getState().setPendingSelect(drawing.id);
    void saveViewSettings(envConfig, bookKey, 'annotationQuickAction', 'pdf-select', false, true);
    jumpTo(drawing.pageIndex);
  };

  const remove = (id: string) => {
    void applyPdfDrawings(
      bookKey,
      drawings.filter((d) => d.id !== id),
      appService,
    );
  };

  return (
    <div className='px-2 pt-2'>
      <h3 className='content font-size-base line-clamp-1 px-2 font-normal'>{_('PDF Drawings')}</h3>
      <ul>
        {drawings.map((drawing) => {
          const Icon = drawing.type === 'line' ? FiSlash : drawing.type === 'rect' ? FiSquare : FiType;
          return (
            <li
              key={drawing.id}
              className='group flex items-center gap-2 rounded px-2 py-1 hover:bg-base-300/50'
            >
              <span
                className='border-base-content/40 h-3 w-3 shrink-0 rounded-full border'
                style={{ backgroundColor: drawing.color }}
              />
              <button
                type='button'
                data-pdf-drawing-entry={drawing.id}
                className='flex min-w-0 flex-1 items-center gap-1.5 text-start text-sm'
                onClick={() => editDrawing(drawing)}
              >
                <Icon className='shrink-0 text-base-content/70' size={13} />
                <span className='min-w-0 truncate'>
                  {drawing.type === 'text' ? drawing.text : _(TYPE_LABEL[drawing.type]!)}
                  <span className='text-base-content/60'>
                    {' '}
                    · {_('Page {{page}}', { page: drawing.pageIndex + 1 })}
                  </span>
                </span>
              </button>
              <button
                type='button'
                title={_('Delete')}
                className='btn btn-ghost btn-xs h-6 min-h-6 w-6 p-0 opacity-0 group-hover:opacity-100'
                onClick={() => remove(drawing.id)}
              >
                <RiDeleteBinLine size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default PdfDrawingsSection;
