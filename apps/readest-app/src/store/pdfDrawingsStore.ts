import { create } from 'zustand';

import { PdfDrawing } from '@/types/book';
import { AppService } from '@/types/system';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { eventDispatcher } from '@/utils/event';

// Pen presets shared by the draw overlay and the shape editor toolbars.
export const PDF_STROKE_WIDTHS = [1, 2, 4, 8];
export const PDF_FONT_SIZES = [12, 16, 24, 32];
// Light tints for the text background, ordered like the highlight palette.
export const PDF_BACKGROUND_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#ddd6fe', '#e5e7eb'];

interface PdfDrawingsState {
  drawingsByBook: Record<string, PdfDrawing[]>;
  setDrawings: (bookKey: string, drawings: PdfDrawing[]) => void;
  // Set by outside entry points (sidebar section, context menu) to ask the
  // shape editor to select a specific drawing; consumed (cleared) by it.
  pendingSelectId: string | null;
  setPendingSelect: (id: string | null) => void;
  // Current pen settings shared by the draw overlay (new strokes) and the
  // shape editor (defaults when nothing is selected).
  penStrokeWidth: number;
  penFontSize: number;
  penBackground?: string;
  penArrow: boolean;
  setPenStrokeWidth: (w: number) => void;
  setPenFontSize: (size: number) => void;
  setPenBackground: (color?: string) => void;
  setPenArrow: (arrow: boolean) => void;
}

// React-side mirror of the foliate book's drawing list (book.getDrawings()).
// The foliate book owns the truth for rendering; this store makes the list
// reactive for the sidebar section and the draw overlay. Mutators must go
// through applyPdfDrawings, which writes store, foliate book and disk.
export const usePdfDrawingsStore = create<PdfDrawingsState>((set) => ({
  drawingsByBook: {},
  setDrawings: (bookKey, drawings) =>
    set((state) => ({ drawingsByBook: { ...state.drawingsByBook, [bookKey]: drawings } })),
  pendingSelectId: null,
  setPendingSelect: (id) => set({ pendingSelectId: id }),
  penStrokeWidth: 2,
  penFontSize: 12,
  penBackground: undefined,
  penArrow: false,
  setPenStrokeWidth: (w) => set({ penStrokeWidth: w }),
  setPenFontSize: (size) => set({ penFontSize: size }),
  setPenBackground: (color) => set({ penBackground: color }),
  setPenArrow: (arrow) => set({ penArrow: arrow }),
}));

// Seed the store from the foliate book (the truth loaded at open time).
export const seedPdfDrawings = (bookKey: string) => {
  const book = useReaderStore.getState().getView(bookKey)?.book;
  if (book?.getDrawings) {
    usePdfDrawingsStore.getState().setDrawings(bookKey, book.getDrawings());
  }
};

// Write the new list everywhere: store (React), foliate book (page SVG layers)
// and the per-book JSON on disk. `appService` comes from useEnv in components.
export const applyPdfDrawings = async (
  bookKey: string,
  drawings: PdfDrawing[],
  appService?: AppService | null,
) => {
  usePdfDrawingsStore.getState().setDrawings(bookKey, drawings);
  const view = useReaderStore.getState().getView(bookKey);
  view?.book?.setDrawings?.(drawings);
  const book = useBookDataStore.getState().getBookData(bookKey)?.book;
  if (book && appService) {
    try {
      await appService.savePdfDrawings(book, drawings);
      // Tell the reader's file-sync hook to push the fresh envelope.
      eventDispatcher.dispatch('pdf-drawings-changed', { bookKey });
    } catch (e) {
      console.warn('Failed to persist PDF drawings:', e);
    }
  }
};
