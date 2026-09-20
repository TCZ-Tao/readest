import { PdfDrawing } from '@/types/book';
import { Book } from '@/types/book';

/**
 * Per-book remote payload stored at
 *   <rootPath>/Readest/books/<hash>/pdf-drawings.json
 *
 * The user's drawing annotations on PDF pages (line/rect/text from the page
 * tools). The whole list travels as one blob and merges by whole-blob
 * last-writer-wins on `updatedAt` — a single-editor artifact (one reader
 * sketching on their own pages across devices), so nothing fancier than
 * "newest file wins" is warranted, and a tie keeps the local copy untouched.
 *
 * The LOCAL per-book file (`Books/<hash>/pdf-drawings.json`) stores this same
 * envelope. Builds before file sync wrote a bare `PdfDrawing[]` there; the
 * parser below accepts both and stamps a bare array with `updatedAt: 0`, so a
 * legacy local file loses to any remote copy that was ever synced — and gains
 * a real timestamp the next time it is saved on this device.
 *
 * FROZEN: `schemaVersion` and the field set are the on-wire contract; the
 * additive-evolution contract of the sync layout (see layout.ts) is what
 * keeps pre-existing clients from ever reading this file at all.
 */
export interface RemotePdfDrawings {
  schemaVersion: 1;
  bookHash: string;
  drawings: PdfDrawing[];
  /** When the writer last saved the list (client wall clock, millis). */
  updatedAt: number;
}

export const buildPdfDrawingsPayload = (
  book: Book,
  drawings: PdfDrawing[],
  updatedAt: number,
): RemotePdfDrawings => ({
  schemaVersion: 1,
  bookHash: book.hash,
  drawings,
  updatedAt,
});

/** Accepts the envelope or a legacy bare `PdfDrawing[]`; null when neither. */
export const parsePdfDrawingsPayload = (raw: string | null): RemotePdfDrawings | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { schemaVersion: 1, bookHash: '', drawings: parsed as PdfDrawing[], updatedAt: 0 };
    }
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      Array.isArray(parsed.drawings) &&
      typeof parsed.updatedAt === 'number'
    ) {
      return parsed as RemotePdfDrawings;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Whole-blob LWW: the newer `updatedAt` wins; a tie (or both null) keeps the
 * current holder, so a no-op sync round never rewrites anything.
 */
export const pickNewerPdfDrawings = (
  current: RemotePdfDrawings | null,
  incoming: RemotePdfDrawings | null,
): RemotePdfDrawings | null => {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.updatedAt > current.updatedAt ? incoming : current;
};
