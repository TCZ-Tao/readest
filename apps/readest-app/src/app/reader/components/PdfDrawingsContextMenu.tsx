import clsx from 'clsx';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FiEdit3 } from 'react-icons/fi';

import { useEnv } from '@/context/EnvContext';
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
  const [position, setPosition] = useState<Position | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    // Pages forward their contextmenu through the parent window (coords
    // already translated) -- see the hook in foliate-js pdf.js render().
    const onForwarded = (e: Event) => {
      const { x, y } = (e as CustomEvent).detail;
      setPosition({ x, y });
    };
    window.addEventListener('readest-pdf-context-menu', onForwarded);

    // Right-clicks on the reading canvas but outside any page (the margins
    // around fit-page pages live in the parent document) take over here;
    // everything else (sidebar, toolbars) keeps the browser menu.
    const onDocument = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest?.('.foliate-viewer')) return;
      e.preventDefault();
      setPosition({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener('contextmenu', onDocument);

    return () => {
      window.removeEventListener('readest-pdf-context-menu', onForwarded);
      document.removeEventListener('contextmenu', onDocument);
    };
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
