import { describe, expect, it } from 'vitest';

import type { Book, PdfDrawing } from '@/types/book';

import {
  buildPdfDrawingsPayload,
  parsePdfDrawingsPayload,
  pickNewerPdfDrawings,
} from '@/services/sync/file/pdfDrawings';

const book = { hash: 'abc123' } as Book;
const drawings: PdfDrawing[] = [
  {
    id: 'd1',
    pageIndex: 3,
    type: 'line',
    points: [
      [100, 700],
      [300, 700],
    ],
    color: '#f87171',
    strokeWidth: 2,
  },
];

describe('buildPdfDrawingsPayload / parsePdfDrawingsPayload', () => {
  it('round-trips the envelope', () => {
    const payload = buildPdfDrawingsPayload(book, drawings, 1726800000000);
    const parsed = parsePdfDrawingsPayload(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });

  it('parses a legacy bare-array file as updatedAt 0', () => {
    const parsed = parsePdfDrawingsPayload(JSON.stringify(drawings));
    expect(parsed).not.toBeNull();
    expect(parsed!.updatedAt).toBe(0);
    expect(parsed!.drawings).toEqual(drawings);
  });

  it('returns null for garbage, emptiness, and wrong schema', () => {
    expect(parsePdfDrawingsPayload(null)).toBeNull();
    expect(parsePdfDrawingsPayload('')).toBeNull();
    expect(parsePdfDrawingsPayload('not json')).toBeNull();
    expect(parsePdfDrawingsPayload('{"schemaVersion":2,"drawings":[],"updatedAt":1}')).toBeNull();
    expect(parsePdfDrawingsPayload('{"schemaVersion":1,"updatedAt":1}')).toBeNull();
  });
});

describe('pickNewerPdfDrawings', () => {
  const older = buildPdfDrawingsPayload(book, drawings, 100);
  const newer = buildPdfDrawingsPayload(book, drawings, 200);

  it('picks the newer envelope', () => {
    expect(pickNewerPdfDrawings(older, newer)).toBe(newer);
    expect(pickNewerPdfDrawings(newer, older)).toBe(newer);
  });

  it('keeps the current holder on a tie', () => {
    const sameTs = buildPdfDrawingsPayload(book, drawings, 100);
    expect(pickNewerPdfDrawings(older, sameTs)).toBe(older);
  });

  it('handles null sides', () => {
    expect(pickNewerPdfDrawings(null, newer)).toBe(newer);
    expect(pickNewerPdfDrawings(older, null)).toBe(older);
    expect(pickNewerPdfDrawings(null, null)).toBeNull();
  });
});
