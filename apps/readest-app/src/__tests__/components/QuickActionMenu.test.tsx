import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import QuickActionMenu from '@/app/reader/components/annotator/QuickActionMenu';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string, params?: Record<string, string>) =>
    params ? key.replace(/\{\{(\w+)\}\}/g, (_, name) => params[name] ?? '') : key,
}));

vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: vi.fn() },
}));

// Menu/MenuItem are layout primitives; stub them so assertions read the
// rendered labels directly.
vi.mock('@/components/Menu', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/MenuItem', () => ({
  default: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type='button' onClick={onClick}>
      {label}
    </button>
  ),
}));

const renderMenu = (isPdf?: boolean) =>
  render(<QuickActionMenu selectedAction={null} onActionSelect={() => {}} isPdf={isPdf} />);

afterEach(cleanup);

describe('QuickActionMenu', () => {
  it('shows the selection quick actions only for non-PDF books', () => {
    renderMenu(false);
    expect(screen.getByText('Instant Highlight')).toBeTruthy();
    expect(screen.queryByText('Line')).toBeNull();
    expect(screen.queryByText('Rectangle')).toBeNull();
    expect(screen.queryByText('Text')).toBeNull();
  });

  it('appends the PDF drawing tools for PDF books', () => {
    renderMenu(true);
    expect(screen.getByText('Instant Highlight')).toBeTruthy();
    expect(screen.getByText('Line')).toBeTruthy();
    expect(screen.getByText('Rectangle')).toBeTruthy();
    expect(screen.getByText('Text')).toBeTruthy();
  });
});
