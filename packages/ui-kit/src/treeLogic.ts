export interface TreeNode {
  id: string;
  label: string;
  children?: TreeNode[];
  disabled?: boolean;
}

export interface FlatNode {
  node: TreeNode;
  depth: number;
  parentId: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

/** Visible rows in display order, given the set of expanded ids. */
export function flattenTree(nodes: TreeNode[], expanded: ReadonlySet<string>): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (list: TreeNode[], depth: number, parentId: string | null) => {
    for (const node of list) {
      const hasChildren = !!node.children?.length;
      const isOpen = hasChildren && expanded.has(node.id);
      out.push({ node, depth, parentId, hasChildren, expanded: isOpen });
      if (isOpen) walk(node.children!, depth + 1, node.id);
    }
  };
  walk(nodes, 0, null);
  return out;
}

export function toggleExpanded(expanded: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function allBranchIds(nodes: TreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: TreeNode[]) =>
    list.forEach((n) => {
      if (n.children?.length) {
        ids.push(n.id);
        walk(n.children);
      }
    });
  walk(nodes);
  return ids;
}

export type TreeKey = 'ArrowDown' | 'ArrowUp' | 'ArrowRight' | 'ArrowLeft' | 'Home' | 'End';

export interface NavResult {
  focusId: string | null;
  expanded: Set<string>;
}

/** WAI-ARIA tree keyboard navigation. Pure: returns the new focus id and expanded set. */
export function navigate(
  rows: FlatNode[],
  expanded: ReadonlySet<string>,
  focusId: string | null,
  key: TreeKey,
): NavResult {
  const idx = Math.max(
    0,
    rows.findIndex((r) => r.node.id === focusId),
  );
  const cur = rows[idx];
  const same = { focusId: cur?.node.id ?? null, expanded: new Set(expanded) };
  if (!cur) return same;
  switch (key) {
    case 'ArrowDown':
      return {
        focusId: rows[Math.min(rows.length - 1, idx + 1)]!.node.id,
        expanded: same.expanded,
      };
    case 'ArrowUp':
      return { focusId: rows[Math.max(0, idx - 1)]!.node.id, expanded: same.expanded };
    case 'Home':
      return { focusId: rows[0]!.node.id, expanded: same.expanded };
    case 'End':
      return { focusId: rows[rows.length - 1]!.node.id, expanded: same.expanded };
    case 'ArrowRight':
      if (cur.hasChildren && !cur.expanded)
        return { focusId: cur.node.id, expanded: toggleExpanded(expanded, cur.node.id) };
      if (cur.hasChildren && cur.expanded)
        return { focusId: rows[idx + 1]?.node.id ?? cur.node.id, expanded: same.expanded };
      return same;
    case 'ArrowLeft':
      if (cur.hasChildren && cur.expanded)
        return { focusId: cur.node.id, expanded: toggleExpanded(expanded, cur.node.id) };
      return { focusId: cur.parentId ?? cur.node.id, expanded: same.expanded };
  }
}

export type CheckState = 'checked' | 'unchecked' | 'mixed';

function leafIds(node: TreeNode): string[] {
  return node.children?.length ? node.children.flatMap(leafIds) : [node.id];
}

/** Checked set holds leaf ids only; branch state is derived. */
export function checkState(node: TreeNode, checked: ReadonlySet<string>): CheckState {
  const leaves = leafIds(node);
  const n = leaves.filter((l) => checked.has(l)).length;
  return n === 0 ? 'unchecked' : n === leaves.length ? 'checked' : 'mixed';
}

/** Toggles a node: a branch checks/unchecks all its leaves (mixed becomes checked). */
export function toggleChecked(node: TreeNode, checked: ReadonlySet<string>): Set<string> {
  const next = new Set(checked);
  const turnOn = checkState(node, checked) !== 'checked';
  for (const l of leafIds(node)) {
    if (turnOn) next.add(l);
    else next.delete(l);
  }
  return next;
}
