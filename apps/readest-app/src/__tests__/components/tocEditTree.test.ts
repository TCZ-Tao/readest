import { describe, expect, it } from 'vitest';

import type { TOCItem } from '@/libs/document';

import {
  appendTocItem,
  applyTocDrop,
  deleteTocItem,
  ensureTocIds,
  findActiveTocHref,
  flattenTocForEdit,
  insertTocItemAfterHref,
  makePageTocItem,
  normalizeTocTree,
  renameTocItem,
} from '@/app/reader/components/sidebar/tocEditTree';

const node = (id: number, label: string, subitems?: TOCItem[]): TOCItem => ({
  id,
  label,
  href: `#${id}`,
  index: id,
  ...(subitems ? { subitems } : {}),
});

// A(0) ─ B(0) ─┬─ C(1) ─ D(2)
//              └─ E(1)
// F(0)
const tree = (): TOCItem[] => [
  node(1, 'A'),
  node(2, 'B', [node(3, 'C', [node(4, 'D')]), node(5, 'E')]),
  node(6, 'F'),
];

const labels = (items: TOCItem[]): string =>
  flattenTocForEdit(items)
    .map(({ item, depth }) => `${item.label}(${depth})`)
    .join(' ');

describe('ensureTocIds', () => {
  it('assigns ids to nodes that lack one', () => {
    const untyped = [
      { label: 'a', href: 'x', index: 0, subitems: [{ label: 'b', href: 'y', index: 1 }] },
    ] as unknown as TOCItem[];
    const result = ensureTocIds(untyped);
    expect(typeof result[0]!.id).toBe('number');
    expect(typeof result[0]!.subitems![0]!.id).toBe('number');
    expect(result[0]!.id).not.toBe(result[0]!.subitems![0]!.id);
  });

  it('keeps existing ids and is idempotent', () => {
    const once = ensureTocIds(tree());
    const twice = ensureTocIds(once);
    expect(labels(twice)).toBe(labels(once));
    expect(twice.map((n) => n.id)).toEqual([1, 2, 6]);
  });
});

describe('flattenTocForEdit', () => {
  it('flattens fully expanded with depths', () => {
    expect(labels(tree())).toBe('A(0) B(0) C(1) D(2) E(1) F(0)');
  });
});

describe('applyTocDrop', () => {
  it('rejects dropping into the dragged subtree', () => {
    expect(applyTocDrop(tree(), 2, 4, 'child')).toBeNull();
    expect(applyTocDrop(tree(), 2, 3, 'after')).toBeNull();
  });

  it('rejects unknown ids', () => {
    expect(applyTocDrop(tree(), 99, 1, 'before')).toBeNull();
    expect(applyTocDrop(tree(), 1, 99, 'before')).toBeNull();
  });

  it('reorders siblings', () => {
    expect(labels(applyTocDrop(tree(), 1, 6, 'before')!)).toBe('B(0) C(1) D(2) E(1) A(0) F(0)');
    expect(labels(applyTocDrop(tree(), 6, 1, 'before')!)).toBe('F(0) A(0) B(0) C(1) D(2) E(1)');
  });

  it('drops after the target subtree, not between parent and child', () => {
    // 'after' B means after B's whole subtree, as a root-level sibling.
    expect(labels(applyTocDrop(tree(), 1, 2, 'after')!)).toBe('B(0) C(1) D(2) E(1) A(0) F(0)');
  });

  it('appends as last child on "child"', () => {
    const result = applyTocDrop(tree(), 1, 2, 'child')!;
    expect(labels(result)).toBe('B(0) C(1) D(2) E(1) A(1) F(0)');
  });

  it("inherits the target's depth on 'before'", () => {
    // Dropping A(0) 'before' D(2) puts A in D's slot: a child of C, sibling of D.
    const result = applyTocDrop(tree(), 1, 4, 'before')!;
    expect(labels(result)).toBe('B(0) C(1) A(2) D(2) E(1) F(0)');
  });

  it('clamps to root when dropped before the first row', () => {
    const result = applyTocDrop(tree(), 4, 1, 'before')!;
    expect(labels(result)).toBe('D(0) A(0) B(0) C(1) E(1) F(0)');
  });

  it('does not mutate the input tree', () => {
    const original = tree();
    const snapshot = JSON.stringify(original);
    applyTocDrop(original, 1, 2, 'child');
    applyTocDrop(original, 4, 1, 'before');
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('handles a single-node tree', () => {
    expect(applyTocDrop([node(1, 'A')], 1, 1, 'child')).toBeNull();
  });
});

describe('renameTocItem / deleteTocItem / appendTocItem', () => {
  it('renames only the target node', () => {
    const result = renameTocItem(tree(), 3, 'Renamed');
    expect(result[1]!.subitems![0]!.label).toBe('Renamed');
    expect(result[1]!.subitems![1]!.label).toBe('E');
  });

  it('deletes a node with its subtree', () => {
    expect(labels(deleteTocItem(tree(), 2))).toBe('A(0) F(0)');
    expect(labels(deleteTocItem(tree(), 4))).toBe('A(0) B(0) C(1) E(1) F(0)');
  });

  it('appends at root level', () => {
    const item = makePageTocItem(11, 99, 'Page 12');
    const result = appendTocItem(tree(), item);
    expect(result[result.length - 1]).toBe(item);
    expect(item.href).toBe('11');
    expect(item.index).toBe(11);
  });
});

describe('empty subitems cleanup', () => {
  it('moving the only child out clears the parent subitems', () => {
    const nested = [node(1, 'A', [node(2, 'B')])];
    const result = applyTocDrop(nested, 2, 1, 'after')!;
    expect(labels(result)).toBe('A(0) B(0)');
    expect(result[0]!.subitems).toBeUndefined();
  });

  it('deleting the only child clears the parent subitems', () => {
    const nested = [node(1, 'A', [node(2, 'B')])];
    const result = deleteTocItem(nested, 2);
    expect(labels(result)).toBe('A(0)');
    expect(result[0]!.subitems).toBeUndefined();
  });

  it('normalizes empty subitems arrays from stale files', () => {
    const stale = JSON.parse('[{"id":1,"label":"A","href":"#1","index":1,"subitems":[]}]');
    const result = normalizeTocTree(stale as TOCItem[]);
    expect(result[0]!.subitems).toBeUndefined();
  });
});

describe('insertTocItemAfterHref / findActiveTocHref', () => {
  it('inserts as first child when the target has children', () => {
    const item = makePageTocItem(11, 99, 'X');
    const result = insertTocItemAfterHref(tree(), '#2', item);
    expect(labels(result)).toBe('A(0) B(0) X(1) C(1) D(2) E(1) F(0)');
  });

  it('inserts as a sibling directly below a leaf', () => {
    const item = makePageTocItem(11, 99, 'X');
    const result = insertTocItemAfterHref(tree(), '#6', item);
    expect(labels(result)).toBe('A(0) B(0) C(1) D(2) E(1) F(0) X(0)');
  });

  it('falls back to root append when the href is missing', () => {
    const item = makePageTocItem(11, 99, 'X');
    expect(labels(insertTocItemAfterHref(tree(), '#404', item))).toBe(
      'A(0) B(0) C(1) D(2) E(1) F(0) X(0)',
    );
    expect(labels(insertTocItemAfterHref(tree(), null, item))).toBe(
      'A(0) B(0) C(1) D(2) E(1) F(0) X(0)',
    );
  });

  it('finds the entry containing the reading position', () => {
    // Markers on pages 3 and 21 (0-based 2 and 20): reading page 10 (idx 9)
    // sits inside the first marker; page 30 sits inside the second.
    const markers = [makePageTocItem(2, 1, 'P3'), makePageTocItem(20, 2, 'P21')];
    expect(findActiveTocHref(markers, 9)).toBe('2');
    expect(findActiveTocHref(markers, 20)).toBe('20');
    expect(findActiveTocHref(markers, 100)).toBe('20');
    expect(findActiveTocHref(markers, 0)).toBeNull();
    expect(findActiveTocHref([], 5)).toBeNull();
  });

  it('stacks successive page markers flat, in reading order', () => {
    const first = makePageTocItem(2, 1, 'P3');
    let items = insertTocItemAfterHref([], '2', first); // no active yet → append
    expect(labels(items)).toBe('P3(0)');
    const second = makePageTocItem(20, 2, 'P21');
    items = insertTocItemAfterHref(items, findActiveTocHref(items, 20), second);
    expect(labels(items)).toBe('P3(0) P21(0)');
    const third = makePageTocItem(9, 3, 'P10');
    items = insertTocItemAfterHref(items, findActiveTocHref(items, 9), third);
    expect(labels(items)).toBe('P3(0) P10(0) P21(0)');
  });
});
