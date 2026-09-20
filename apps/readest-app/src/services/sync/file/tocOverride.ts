import { TOCItem } from '@/libs/document';
import { Book } from '@/types/book';

/**
 * Per-book remote payload stored at
 *   <rootPath>/Readest/books/<hash>/toc-override.json
 *
 * The user-edited PDF table of contents (TOC editor). The whole edited tree
 * travels as one blob and merges by whole-blob last-writer-wins on
 * `updatedAt` — a single-editor artifact (one reader curating their own TOC
 * across devices), so nothing fancier than "newest file wins" is warranted,
 * and a tie keeps the local copy untouched.
 *
 * The LOCAL per-book file (`Books/<hash>/toc-override.json`) stores this same
 * envelope. Older builds wrote a bare `TOCItem[]` there; the parser below
 * accepts both and stamps a bare array with `updatedAt: 0`, so a legacy local
 * file loses to any remote copy that was ever synced — and gains a real
 * timestamp the next time it is saved on this device.
 *
 * FROZEN: `schemaVersion` and the field set are the on-wire contract; the
 * additive-evolution contract of the sync layout (see layout.ts) is what
 * keeps pre-existing clients from ever reading this file at all.
 */
export interface RemoteTocOverride {
  schemaVersion: 1;
  bookHash: string;
  toc: TOCItem[];
  /** When the writer last saved the tree (client wall clock, millis). */
  updatedAt: number;
}

export const buildTocOverridePayload = (
  book: Book,
  toc: TOCItem[],
  updatedAt: number,
): RemoteTocOverride => ({
  schemaVersion: 1,
  bookHash: book.hash,
  toc,
  updatedAt,
});

/** Accepts the envelope or a legacy bare `TOCItem[]`; null when neither. */
export const parseTocOverridePayload = (raw: string | null): RemoteTocOverride | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return { schemaVersion: 1, bookHash: '', toc: parsed as TOCItem[], updatedAt: 0 };
    }
    if (
      parsed &&
      parsed.schemaVersion === 1 &&
      Array.isArray(parsed.toc) &&
      typeof parsed.updatedAt === 'number'
    ) {
      return parsed as RemoteTocOverride;
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
export const pickNewerTocOverride = (
  current: RemoteTocOverride | null,
  incoming: RemoteTocOverride | null,
): RemoteTocOverride | null => {
  if (!incoming) return current;
  if (!current) return incoming;
  return incoming.updatedAt > current.updatedAt ? incoming : current;
};
