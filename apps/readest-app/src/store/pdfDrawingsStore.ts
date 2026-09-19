import { create } from 'zustand';

import { PdfDrawing } from '@/types/book';
import { AppService } from '@/types/system';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';

interface PdfDrawingsState {
  drawingsByBook: Record<string, PdfDrawing[]>;
  setDrawings: (bookKey: string, drawings: PdfDrawing[]) => void;
}

// React-side mirror of the foliate book's drawing list (book.getDrawings()).
// The foliate book owns the truth for rendering; this store makes the list
// reactive for the sidebar section and the draw overlay. Mutators must go
// through applyPdfDrawings, which writes store, foliate book and disk.
export const usePdfDrawingsStore = create<PdfDrawingsState>((set) => ({
  drawingsByBook: {},
  setDrawings: (bookKey, drawings) =>
    set((state) => ({ drawingsByBook: { ...state.drawingsByBook, [bookKey]: drawings } })),
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
    } catch (e) {
      console.warn('Failed to persist PDF drawings:', e);
    }
  }
};
