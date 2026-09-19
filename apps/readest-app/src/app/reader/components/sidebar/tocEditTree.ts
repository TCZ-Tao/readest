import { TOCItem } from '@/libs/document';

/**
 * Pure tree operations behind the PDF TOC editor. The editor works on a
 * flattened (depth-annotated) view of the tree — always fully expanded — so
 * drag & drop, deletion and insertion all reduce to flat-list surgery followed
 * by a rebuild. Every node must carry a unique `id` for that to work; the id
 * is also what persists, keeping drag keys stable across sessions.
 */

export type TocDropPosition = 'before' | 'after' | 'child';

export interface FlatTocRow {
  item: TOCItem;
  depth: number;
}

// Assign a unique id to every node that lacks one. Already-assigned ids are
// preserved so that repeated edits (and re-opens) don't renumber nodes.
export const ensureTocIds = (items: TOCItem[]): TOCItem[] => {
  let next = 1;
  const collectMax = (nodes: TOCItem[]) => {
    for (const node of nodes) {
      if (typeof node.id === 'number') next = Math.max(next, node.id + 1);
      if (node.subitems) collectMax(node.subitems);
    }
  };
  collectMax(items);
  const walk = (nodes: TOCItem[]): TOCItem[] =>
    nodes.map((node) => {
      const id = typeof node.id === 'number' ? node.id : next++;
      const subitems = node.subitems ? walk(node.subitems) : undefined;
      return subitems ? { ...node, id, subitems } : { ...node, id };
    });
  return walk(items);
};

export const flattenTocForEdit = (items: TOCItem[], depth = 0): FlatTocRow[] => {
  const rows: FlatTocRow[] = [];
  for (const item of items) {
    rows.push({ item, depth });
    if (item.subitems?.length) {
      rows.push(...flattenTocForEdit(item.subitems, depth + 1));
    }
  }
  return rows;
};

// Drop empty `subitems` arrays. An empty array is falsy-adjacent everywhere
// except the expander check (`item.subitems && …`), where it still renders a
// collapse triangle for a node with no children — so moving or deleting a
// node's last child must clean the parent up.
export const normalizeTocTree = (items: TOCItem[]): TOCItem[] =>
  items.map((item) => {
    const subitems = item.subitems?.length ? normalizeTocTree(item.subitems) : undefined;
    return subitems ? { ...item, subitems } : { ...item, subitems: undefined };
  });

// Rebuild a tree from a flat list where every row's depth differs from its
// predecessor's by at most +1 (callers clamp depths before calling this).
// Every node is shallow-copied so insertion never mutates the input tree.
const rebuildFromRows = (rows: FlatTocRow[]): TOCItem[] => {
  const root: TOCItem[] = [];
  const stack: TOCItem[] = [];
  for (const { item, depth } of rows) {
    stack.length = depth;
    const node: TOCItem = { ...item, subitems: item.subitems?.length ? [] : item.subitems };
    if (depth === 0) {
      root.push(node);
    } else {
      stack[depth - 1]!.subitems = [...(stack[depth - 1]!.subitems ?? []), node];
    }
    stack[depth] = node;
  }
  return normalizeTocTree(root);
};

const collectIds = (item: TOCItem, acc: Set<TOCItem['id']>) => {
  acc.add(item.id);
  item.subitems?.forEach((child) => collectIds(child, acc));
};

const subtreeSize = (rows: FlatTocRow[], start: number) => {
  const depth = rows[start]!.depth;
  let end = start + 1;
  while (end < rows.length && rows[end]!.depth > depth) end++;
  return end - start;
};

/**
 * Move the subtree rooted at `dragId` relative to `targetId`.
 * - 'before'/'after': place as a sibling of the target ('after' skips past the
 *   target's whole subtree).
 * - 'child': append as the target's last child.
 * Depths are clamped so the moved node never becomes deeper than the rows
 * around it allow. Returns null when the drop is impossible (target inside the
 * dragged subtree, or drag/target not found) — callers keep the current tree.
 */
export const applyTocDrop = (
  items: TOCItem[],
  dragId: TOCItem['id'],
  targetId: TOCItem['id'],
  position: TocDropPosition,
): TOCItem[] | null => {
  const rows = flattenTocForEdit(items);
  const dragIndex = rows.findIndex((row) => row.item.id === dragId);
  const targetIndex = rows.findIndex((row) => row.item.id === targetId);
  if (dragIndex === -1 || targetIndex === -1) return null;

  const dragIds = new Set<TOCItem['id']>();
  collectIds(rows[dragIndex]!.item, dragIds);
  if (dragIds.has(targetId)) return null;

  const dragSize = subtreeSize(rows, dragIndex);
  const remaining = [...rows.slice(0, dragIndex), ...rows.slice(dragIndex + dragSize)];
  if (!remaining.length) return rebuildFromRows([]);

  const targetIndexInRemaining = remaining.findIndex((row) => row.item.id === targetId);
  if (targetIndexInRemaining === -1) return null;

  const dragged = rows[dragIndex]!.item;
  const targetDepth = remaining[targetIndexInRemaining]!.depth;

  let insertIndex: number;
  let depth: number;
  if (position === 'child') {
    insertIndex = targetIndexInRemaining + subtreeSize(remaining, targetIndexInRemaining);
    depth = targetDepth + 1;
  } else if (position === 'before') {
    insertIndex = targetIndexInRemaining;
    depth = targetDepth;
  } else {
    insertIndex = targetIndexInRemaining + subtreeSize(remaining, targetIndexInRemaining);
    depth = targetDepth;
  }
  // A node at depth d needs an ancestor at every level above; the previous row
  // bounds how deep the insertion point can be.
  const prevDepth = insertIndex > 0 ? remaining[insertIndex - 1]!.depth : -1;
  depth = Math.min(depth, prevDepth + 1);

  remaining.splice(insertIndex, 0, { item: dragged, depth });
  return rebuildFromRows(remaining);
};

const mapTree = (items: TOCItem[], fn: (item: TOCItem) => TOCItem): TOCItem[] =>
  items.map((item) => {
    const mapped = fn(item);
    return mapped.subitems?.length ? { ...mapped, subitems: mapTree(mapped.subitems, fn) } : mapped;
  });

export const renameTocItem = (items: TOCItem[], id: TOCItem['id'], label: string): TOCItem[] =>
  mapTree(items, (item) => (item.id === id ? { ...item, label } : item));

export const deleteTocItem = (items: TOCItem[], id: TOCItem['id']): TOCItem[] =>
  normalizeTocTree(
    items
      .filter((item) => item.id !== id)
      .map((item) =>
        item.subitems?.length ? { ...item, subitems: deleteTocItem(item.subitems, id) } : item,
      ),
  );

// Append a new root-level item; the reader drags it into its final place.
export const appendTocItem = (items: TOCItem[], item: TOCItem): TOCItem[] => [...items, item];

// Insert a new item directly below where the "current position" row renders —
// right under the item containing the current page. A leaf gets it as a
// sibling directly below; a parent gets it as its first child (the position
// row also renders above that item's children). Falls back to a root-level
// append when there is no such item (empty tree, or the position precedes
// every entry).
export const insertTocItemAfterHref = (
  items: TOCItem[],
  afterHref: string | null | undefined,
  newItem: TOCItem,
): TOCItem[] => {
  const rows = flattenTocForEdit(items);
  const idx = afterHref
    ? rows.findIndex((row) => row.item.href && row.item.href === afterHref)
    : -1;
  if (idx === -1) return appendTocItem(items, newItem);
  const target = rows[idx]!;
  const depth = target.item.subitems?.length ? target.depth + 1 : target.depth;
  rows.splice(idx + 1, 0, { item: newItem, depth });
  return rebuildFromRows(rows);
};

// The TOC item the current PDF page sits in: the entry with the greatest page
// index not ahead of the reading position (later rows win ties, so a deeper
// marker at the same page beats its ancestor). Null when none qualifies.
export const findActiveTocHref = (items: TOCItem[], pageIndex: number): string | null => {
  let bestIndex = -1;
  let bestHref: string | null = null;
  for (const { item } of flattenTocForEdit(items)) {
    if (item.index === undefined || item.index > pageIndex) continue;
    if (item.index >= bestIndex) {
      bestIndex = item.index;
      bestHref = item.href || null;
    }
  }
  return bestHref;
};

// A user-added entry pointing at a physical PDF page. A bare number is the
// page-index form of a PDF TOC href (see foliate-js pdf.js resolveHref).
export const makePageTocItem = (pageIndex: number, id: TOCItem['id'], label: string): TOCItem => ({
  id,
  label,
  href: JSON.stringify(pageIndex),
  index: pageIndex,
});
