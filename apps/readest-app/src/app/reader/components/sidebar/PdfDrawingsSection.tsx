import React, { useEffect } from 'react';
import { FiSquare, FiSlash, FiType } from 'react-icons/fi';
import { RiDeleteBinLine } from 'react-icons/ri';

import { PdfDrawing } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { applyPdfDrawings, seedPdfDrawings, usePdfDrawingsStore } from '@/store/pdfDrawingsStore';
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
  const { appService } = useEnv();
  const getView = useReaderStore((s) => s.getView);
  const drawings = usePdfDrawingsStore((s) => s.drawingsByBook[bookKey]);

  // The foliate book holds the truth loaded at open time; mirror it once so
  // the section renders without waiting for the first store write.
  useEffect(() => {
    seedPdfDrawings(bookKey);
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
                className='flex min-w-0 flex-1 items-center gap-1.5 text-start text-sm'
                onClick={() => jumpTo(drawing.pageIndex)}
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
