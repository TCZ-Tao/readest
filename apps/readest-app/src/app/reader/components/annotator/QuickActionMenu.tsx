import clsx from 'clsx';
import React from 'react';

import { AnnotationToolType, PdfDrawToolType } from '@/types/annotator';
import { useTranslation } from '@/hooks/useTranslation';
import { annotationToolQuickActions, pdfDrawingToolButtons } from './AnnotationTools';
import { eventDispatcher } from '@/utils/event';
import MenuItem from '@/components/MenuItem';
import Menu from '@/components/Menu';

interface QuickActionMenuProps {
  menuClassName?: string;
  selectedAction?: AnnotationToolType | null;
  onActionSelect: (action: AnnotationToolType) => void;
  setIsDropdownOpen?: (open: boolean) => void;
  isPdf?: boolean;
}

const isPdfDrawTool = (action: AnnotationToolType): action is PdfDrawToolType =>
  action.startsWith('pdf-');

const QuickActionMenu: React.FC<QuickActionMenuProps> = ({
  menuClassName,
  selectedAction,
  onActionSelect,
  setIsDropdownOpen,
  isPdf,
}) => {
  const _ = useTranslation();

  const handleActionClick = (action: AnnotationToolType) => {
    onActionSelect(action);
    if (selectedAction === action) {
      eventDispatcher.dispatch('toast', {
        type: 'info',
        timeout: 2000,
        message: isPdfDrawTool(action)
          ? _('Drawing Tool Disabled')
          : _('Instant {{action}} Disabled', {
              action: _(
                annotationToolQuickActions.find((btn) => btn.type === action)?.label ||
                  _('Annotation'),
              ),
            }),
      });
    } else {
      const buttons = isPdfDrawTool(action) ? pdfDrawingToolButtons : annotationToolQuickActions;
      eventDispatcher.dispatch('toast', {
        type: 'info',
        timeout: 2000,
        message: _(buttons.find((btn) => btn.type === action)?.tooltip || ''),
      });
    }
    setIsDropdownOpen?.(false);
  };

  return (
    <Menu
      className={clsx(
        'annotation-quick-action-menu dropdown-content z-20 mt-1.5 border',
        'bgcolor-base-200 shadow-2xl',
        menuClassName,
      )}
      onCancel={() => setIsDropdownOpen?.(false)}
    >
      {annotationToolQuickActions.map((button) => (
        <MenuItem
          key={button.type}
          label={_('Instant {{action}}', { action: _(button.label) })}
          tooltip={_(button.tooltip)}
          buttonClass={selectedAction === button.type ? 'bg-base-300/85' : ''}
          Icon={button.Icon}
          onClick={() => handleActionClick(button.type)}
        />
      ))}
      {isPdf && (
        <>
          <div aria-hidden='true' className='bg-base-content/10 mx-2 my-1 h-px' />
          {pdfDrawingToolButtons.map((button) => (
            <MenuItem
              key={button.type}
              label={_(button.label)}
              tooltip={_(button.tooltip)}
              buttonClass={selectedAction === button.type ? 'bg-base-300/85' : ''}
              Icon={button.Icon}
              onClick={() => handleActionClick(button.type)}
            />
          ))}
        </>
      )}
    </Menu>
  );
};

export default QuickActionMenu;
