import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import { FiCheck, FiMenu, FiPlus, FiTrash2 } from 'react-icons/fi';

import { TOCItem } from '@/libs/document';
import { useTranslation } from '@/hooks/useTranslation';
import { useReaderStore } from '@/store/readerStore';
import {
  appendTocItem,
  applyTocDrop,
  deleteTocItem,
  flattenTocForEdit,
  makePageTocItem,
  renameTocItem,
  TocDropPosition,
} from './tocEditTree';

interface DragIndicator {
  overId: TOCItem['id'];
  position: TocDropPosition;
}

const getPointerY = (activatorEvent: Event, deltaY: number): number | null => {
  const event = activatorEvent as MouseEvent | TouchEvent;
  const clientY = 'touches' in event ? event.touches[0]?.clientY : event.clientY;
  return clientY == null ? null : clientY + deltaY;
};

const EditableRow: React.FC<{
  item: TOCItem;
  depth: number;
  indicator: DragIndicator | null;
  isRenaming: boolean;
  onRenameStart: () => void;
  onRename: (label: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}> = ({
  item,
  depth,
  indicator,
  isRenaming,
  onRenameStart,
  onRename,
  onRenameCancel,
  onDelete,
}) => {
  const _ = useTranslation();
  const { setNodeRef: setDroppableRef, isOver } = useDroppable({ id: item.id });
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableRef,
    transform,
  } = useDraggable({
    id: item.id,
  });
  const cancelledRef = useRef(false);

  const indicatorClass = clsx(
    indicator?.position === 'before' && 'border-t-2 border-blue-500',
    indicator?.position === 'after' && 'border-b-2 border-blue-500',
    indicator?.position === 'child' && 'ms-1 border-s-2 border-blue-500 bg-base-300/50',
  );

  const commitRename = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      if (cancelledRef.current) {
        cancelledRef.current = false;
        onRenameCancel();
        return;
      }
      const label = event.target.value.trim();
      if (label && label !== item.label) onRename(label);
      else onRenameCancel();
    },
    [item.label, onRename, onRenameCancel],
  );

  const commitRenameInput = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      cancelledRef.current = true;
      event.currentTarget.blur();
    }
  }, []);

  return (
    <div
      ref={setDroppableRef}
      className={clsx(
        'border-base-300 flex w-full items-center border-b sm:border-none',
        'pe-2 ps-2 sm:pe-2',
        indicatorClass,
      )}
      style={{ paddingInlineStart: `${(depth + 1) * 12}px` }}
    >
      <button
        ref={setDraggableRef}
        {...attributes}
        {...listeners}
        aria-label={_('Drag to reorder')}
        className='text-base-content/60 hover:text-base-content cursor-grab touch-none p-1 active:cursor-grabbing'
        style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
      >
        <FiMenu aria-hidden='true' />
      </button>
      {isRenaming ? (
        <input
          autoFocus
          defaultValue={item.label}
          onBlur={commitRename}
          onKeyDown={commitRenameInput}
          className='input input-sm ms-1 min-w-0 flex-1'
          aria-label={item.label}
        />
      ) : (
        <div
          className={clsx(
            'ms-1 min-w-0 flex-1 cursor-text truncate rounded-md px-1 py-1 text-sm',
            isOver && 'bg-base-300/50',
          )}
          onClick={onRenameStart}
          title={item.label}
        >
          {item.label}
        </div>
      )}
      {item.index !== undefined && (
        <div className='text-base-content/50 shrink-0 ps-1 text-xs' aria-hidden='true'>
          {item.index + 1}
        </div>
      )}
      <button
        onClick={onDelete}
        aria-label={_('Delete')}
        className='text-base-content/60 hover:bg-base-300/75 hover:text-base-content ms-1 rounded-md p-1'
      >
        <FiTrash2 aria-hidden='true' />
      </button>
    </div>
  );
};

const TOCEditView: React.FC<{
  bookKey: string;
  toc: TOCItem[];
  containerHeight: number;
  onCommit: (toc: TOCItem[]) => void;
  onExit: () => void;
}> = ({ bookKey, toc, containerHeight, onCommit, onExit }) => {
  const _ = useTranslation();
  const rows = useMemo(() => flattenTocForEdit(toc), [toc]);
  const [renamingId, setRenamingId] = useState<TOCItem['id'] | null>(null);
  const [indicator, setIndicator] = useState<DragIndicator | null>(null);
  const indicatorRef = useRef<DragIndicator | null>(null);
  const draggedSubtreeRef = useRef<Set<TOCItem['id']> | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const subtree = new Set<TOCItem['id']>();
      const walk = (item: TOCItem) => {
        subtree.add(item.id);
        item.subitems?.forEach(walk);
      };
      const row = rows.find((r) => r.item.id === event.active.id);
      if (row) walk(row.item);
      draggedSubtreeRef.current = subtree;
    },
    [rows],
  );

  // onDragMove (not onDragOver) — dnd-kit only fires onDragOver when the over
  // droppable *changes*, but the before/child/after zones need continuous
  // pointer tracking within the same row.
  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const { active, over, activatorEvent, delta } = event;
    if (
      !over ||
      over.id === active.id ||
      draggedSubtreeRef.current?.has(over.id as TOCItem['id'])
    ) {
      indicatorRef.current = null;
      setIndicator(null);
      return;
    }
    const y = getPointerY(activatorEvent, delta.y);
    if (y == null || over.rect.height <= 0) return;
    const ratio = (y - over.rect.top) / over.rect.height;
    const position: TocDropPosition = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'child';
    const next = { overId: over.id as TOCItem['id'], position };
    indicatorRef.current = next;
    setIndicator(next);
  }, []);

  const clearDragState = useCallback(() => {
    draggedSubtreeRef.current = null;
    indicatorRef.current = null;
    setIndicator(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const pending = indicatorRef.current;
      clearDragState();
      if (!pending || pending.overId === event.active.id) return;
      const next = applyTocDrop(
        toc,
        event.active.id as TOCItem['id'],
        pending.overId,
        pending.position,
      );
      if (next) onCommit(next);
    },
    [toc, onCommit, clearDragState],
  );

  const handleRename = useCallback(
    (id: TOCItem['id'], label: string) => {
      onCommit(renameTocItem(toc, id, label));
    },
    [toc, onCommit],
  );

  const handleDelete = useCallback(
    (id: TOCItem['id']) => {
      onCommit(deleteTocItem(toc, id));
    },
    [toc, onCommit],
  );

  const handleAddCurrentPage = useCallback(() => {
    const progress = useReaderStore.getState().getProgress(bookKey);
    if (!progress) return;
    const pageIndex = progress.index;
    const maxId = rows.reduce((acc, { item }) => Math.max(acc, item.id as number), 0);
    onCommit(
      appendTocItem(
        toc,
        makePageTocItem(pageIndex, maxId + 1, _('Page {{page}}', { page: pageIndex + 1 })),
      ),
    );
  }, [bookKey, toc, rows, onCommit, _]);

  return (
    <div className='flex flex-col' style={{ height: containerHeight }}>
      <div className='flex items-center gap-1 px-2 pb-1'>
        <button onClick={onExit} className='btn btn-sm border-base-300 bg-base-100 text-sm'>
          <FiCheck aria-hidden='true' />
          {_('Done')}
        </button>
        <button
          onClick={handleAddCurrentPage}
          className='btn btn-sm border-base-300 bg-base-100 text-sm'
          title={_('Add current page')}
        >
          <FiPlus aria-hidden='true' />
          {_('Add current page')}
        </button>
      </div>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={clearDragState}
        >
          <div role='tree' aria-label={_('Table of contents')}>
            {rows.map(({ item, depth }) => (
              <EditableRow
                key={item.id}
                item={item}
                depth={depth}
                indicator={indicator?.overId === item.id ? indicator : null}
                isRenaming={renamingId === item.id}
                onRenameStart={() => setRenamingId(item.id)}
                onRename={(label) => {
                  setRenamingId(null);
                  handleRename(item.id, label);
                }}
                onRenameCancel={() => setRenamingId(null)}
                onDelete={() => handleDelete(item.id)}
              />
            ))}
          </div>
        </DndContext>
      </div>
    </div>
  );
};

export default TOCEditView;
