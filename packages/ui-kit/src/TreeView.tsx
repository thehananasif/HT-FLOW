import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  checkState,
  flattenTree,
  navigate,
  toggleChecked,
  toggleExpanded,
  type TreeKey,
  type TreeNode,
} from './treeLogic';

import { tt } from '@htflow/i18n';
export interface TreeViewProps {
  nodes: TreeNode[];
  /** Expanded branch ids (controlled). Omit for uncontrolled. */
  expanded?: ReadonlySet<string>;
  defaultExpanded?: Iterable<string>;
  onExpandedChange?: (ids: Set<string>) => void;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Show checkboxes. `checked` holds leaf ids; branches show mixed state. */
  checkable?: boolean;
  checked?: ReadonlySet<string>;
  onCheckedChange?: (leafIds: Set<string>) => void;
  renderLabel?: (node: TreeNode) => ReactNode;
  className?: string;
  'aria-label': string;
}

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);

/** Accessible tree (WAI-ARIA tree pattern): roving focus, arrow-key expand/collapse, optional tri-state checkboxes. */
export function TreeView({
  nodes,
  expanded: expandedProp,
  defaultExpanded,
  onExpandedChange,
  selectedId,
  onSelect,
  checkable,
  checked: checkedProp,
  onCheckedChange,
  renderLabel,
  className,
  'aria-label': ariaLabel,
}: TreeViewProps) {
  const [expLocal, setExpLocal] = useState(() => new Set(defaultExpanded ?? []));
  const expanded = expandedProp ?? expLocal;
  const [chkLocal, setChkLocal] = useState<Set<string>>(new Set());
  const checked = checkedProp ?? chkLocal;
  const [focusId, setFocusId] = useState<string | null>(null);
  const root = useRef<HTMLUListElement>(null);

  const rows = useMemo(() => flattenTree(nodes, expanded), [nodes, expanded]);
  const tabId = rows.find((r) => r.node.id === focusId)?.node.id ?? rows[0]?.node.id ?? null;

  const setExpanded = (next: Set<string>) => {
    setExpLocal(next);
    onExpandedChange?.(next);
  };
  const setChecked = (next: Set<string>) => {
    setChkLocal(next);
    onCheckedChange?.(next);
  };

  useEffect(() => {
    // Move DOM focus when keyboard navigation changed the roving id.
    const el = root.current;
    if (el && el.contains(document.activeElement) && focusId) {
      const t = el.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(focusId)}"]`);
      if (t && t !== document.activeElement) t.focus();
    }
  }, [focusId, rows.length]);

  const onKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      const r = navigate(rows, expanded, id, e.key as TreeKey);
      if (r.expanded.size !== expanded.size || [...r.expanded].some((x) => !expanded.has(x)))
        setExpanded(r.expanded);
      setFocusId(r.focusId);
      return;
    }
    const row = rows.find((r) => r.node.id === id);
    if (!row) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onSelect?.(id);
    } else if (e.key === ' ' && checkable && !row.node.disabled) {
      e.preventDefault();
      setChecked(toggleChecked(row.node, checked));
    } else if (e.key === '*') {
      e.preventDefault();
      const next = new Set(expanded);
      nodes.forEach((n) => n.children?.length && next.add(n.id));
      setExpanded(next);
    }
  };

  return (
    <ul
      ref={root}
      className={`ht-tree ${className ?? ''}`}
      role="tree"
      aria-label={ariaLabel}
      aria-multiselectable={checkable || undefined}
    >
      {rows.map((r, i) => {
        const id = r.node.id;
        const cs = checkable ? checkState(r.node, checked) : null;
        return (
          <li
            key={id}
            role="treeitem"
            data-node-id={id}
            className="ht-tree-item"
            data-selected={selectedId === id || undefined}
            aria-level={r.depth + 1}
            aria-posinset={i + 1}
            aria-setsize={rows.length}
            aria-expanded={r.hasChildren ? r.expanded : undefined}
            aria-selected={selectedId === undefined ? undefined : selectedId === id}
            aria-checked={cs ? (cs === 'mixed' ? 'mixed' : cs === 'checked') : undefined}
            aria-disabled={r.node.disabled || undefined}
            tabIndex={id === tabId ? 0 : -1}
            style={{ paddingLeft: 6 + r.depth * 14 }}
            onFocus={() => setFocusId(id)}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget) onKey(e, id);
            }}
            onClick={() => {
              setFocusId(id);
              if (!r.node.disabled) onSelect?.(id);
            }}
          >
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              className="ht-tree-twist"
              data-open={r.expanded || undefined}
              style={{ visibility: r.hasChildren ? 'visible' : 'hidden' }}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(toggleExpanded(expanded, id));
              }}
            >
              <ChevronRight size={12} />
            </button>
            {checkable && (
              <input
                type="checkbox"
                tabIndex={-1}
                aria-label={tt`Check ${r.node.label}`}
                checked={cs === 'checked'}
                disabled={r.node.disabled}
                ref={(el) => {
                  if (el) el.indeterminate = cs === 'mixed';
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={() => setChecked(toggleChecked(r.node, checked))}
              />
            )}
            <span className="ht-tree-label">
              {renderLabel ? renderLabel(r.node) : r.node.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
