import { describe, expect, it } from 'vitest';

import type { TOCItem } from '@/libs/document';
import type { Book } from '@/types/book';

import {
  buildTocOverridePayload,
  parseTocOverridePayload,
  pickNewerTocOverride,
} from '@/services/sync/file/tocOverride';

const book = { hash: 'abc123' } as Book;
const tree: TOCItem[] = [{ id: 1, label: 'A', href: '2', index: 2 }];

describe('buildTocOverridePayload / parseTocOverridePayload', () => {
  it('round-trips the envelope', () => {
    const payload = buildTocOverridePayload(book, tree, 1726800000000);
    const parsed = parseTocOverridePayload(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
  });

  it('parses a legacy bare-array file as updatedAt 0', () => {
    const parsed = parseTocOverridePayload(JSON.stringify(tree));
    expect(parsed).not.toBeNull();
    expect(parsed!.updatedAt).toBe(0);
    expect(parsed!.toc).toEqual(tree);
  });

  it('returns null for garbage, emptiness, and wrong schema', () => {
    expect(parseTocOverridePayload(null)).toBeNull();
    expect(parseTocOverridePayload('')).toBeNull();
    expect(parseTocOverridePayload('not json')).toBeNull();
    expect(parseTocOverridePayload('{"schemaVersion":2,"toc":[],"updatedAt":1}')).toBeNull();
    expect(parseTocOverridePayload('{"schemaVersion":1,"updatedAt":1}')).toBeNull();
  });
});

describe('pickNewerTocOverride', () => {
  const older = buildTocOverridePayload(book, tree, 100);
  const newer = buildTocOverridePayload(book, tree, 200);

  it('picks the newer envelope', () => {
    expect(pickNewerTocOverride(older, newer)).toBe(newer);
    expect(pickNewerTocOverride(newer, older)).toBe(newer);
  });

  it('keeps the current holder on a tie', () => {
    const sameTs = buildTocOverridePayload(book, tree, 100);
    expect(pickNewerTocOverride(older, sameTs)).toBe(older);
  });

  it('handles null sides', () => {
    expect(pickNewerTocOverride(null, newer)).toBe(newer);
    expect(pickNewerTocOverride(older, null)).toBe(older);
    expect(pickNewerTocOverride(null, null)).toBeNull();
  });
});
