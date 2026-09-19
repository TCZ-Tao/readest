import clsx from 'clsx';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FiEdit3 } from 'react-icons/fi';

import { useEnv } from '@/context/EnvContext';
import { useReaderStore } from '@/store/readerStore';
import { saveViewSettings } from '@/helpers/settings';
import { useTranslation } from '@/hooks/useTranslation';
import { Overlay } from '@/components/Overlay';
import ModalPortal from '@/components/ModalPortal';
import Menu from '@/components/Menu';
import MenuItem from '@/components/MenuItem';

const VIEWPORT_PADDING = 8;

interface Position {
  x: number;
  y: number;
}

// Reader-canvas context menu for PDF books: desktop right-click on a page
// opens "Edit PDF Drawings" — same entry as the header's select tool, always
// available (no drawings check, mirroring the header button). The page
// iframes own the pointer, so the contextmenu listener attaches inside each
// iframe's document: via the renderer's create-overlayer event for frames
// rendered later, plus a catch-up pass over frames that exist before this
// component mounts (the initial pages dispatch it before we can listen).
const PdfDrawingsContextMenu: React.FC<{ bookKey: string }> = ({ bookKey }) => {
  const _ = useTranslation();
  const { envConfig } = useEnv();
  const getView = useReaderStore((s) => s.getView);
  const [position, setPosition] = useState<Position | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderer: EventTarget | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const handleContextMenu = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const doc = e.currentTarget as Document;
      const frame = doc.defaultView?.frameElement as HTMLElement | null;
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      setPosition({
        x: rect.left + (e as MouseEvent).clientX,
        y: rect.top + (e as MouseEvent).clientY,
      });
    };

    const attach = (doc: Document) => doc.addEventListener('contextmenu', handleContextMenu);
    const onDoc = (event: Event) => {
      const { doc } = (event as CustomEvent).detail;
      if (doc) attach(doc);
    };

    // The renderer appears only after the view opens, which races this
    // component's mount; poll briefly, then listen for later frames and catch
    // up on the ones already on screen.
    const tryAttach = () => {
      if (cancelled) return;
      const current = getView(bookKey)?.renderer;
      if (!current) {
        retryTimer = setTimeout(tryAttach, 200);
        return;
      }
      renderer = current;
      current.addEventListener('create-overlayer', onDoc);
      for (const { doc } of current.getContents?.() ?? []) {
        if (doc) attach(doc);
      }
    };
    tryAttach();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      renderer?.removeEventListener('create-overlayer', onDoc);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookKey]);

  useLayoutEffect(() => {
    if (!position || !menuRef.current) return;
    const { width, height } = menuRef.current.getBoundingClientRect();
    const left = Math.max(
      VIEWPORT_PADDING,
      Math.min(position.x, window.innerWidth - width - VIEWPORT_PADDING),
    );
    const top = Math.max(
      VIEWPORT_PADDING,
      Math.min(position.y, window.innerHeight - height - VIEWPORT_PADDING),
    );
    setPlacement({ left, top });
    menuRef.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [position]);

  if (!position) return null;

  const close = () => {
    setPosition(null);
    setPlacement(null);
  };

  const enterEditMode = () => {
    saveViewSettings(envConfig, bookKey, 'annotationQuickAction', 'pdf-select', false, true);
  };

  return (
    <ModalPortal showOverlay={false}>
      <Overlay onDismiss={close} className='z-0' />
      <div
        ref={menuRef}
        className={clsx('absolute z-[1] w-max', !placement && 'invisible')}
        style={{ left: placement?.left ?? 0, top: placement?.top ?? 0 }}
      >
        <Menu
          className='dropdown-content no-triangle bg-base-100 rounded-box relative! z-[1] mt-0! p-2 shadow-sm'
          onCancel={close}
        >
          <MenuItem label={_('Edit PDF Drawings')} Icon={FiEdit3} onClick={enterEditMode} />
        </Menu>
      </div>
    </ModalPortal>
  );
};

export default PdfDrawingsContextMenu;
