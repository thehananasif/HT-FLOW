import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import { Button, Checkbox, Dialog, moveItem } from '@htflow/ui-kit';
import { MODULES } from './modules';
import { groupIds, ribbonStore, RIBBON_GROUPS, useRibbonState } from './ribbonStore';

import { translateLiteral as tl } from '@htflow/i18n';
type Drop = { id: string; where: 'before' | 'after' } | null;

/**
 * "Customize ribbon…" dialog: per-group list with show/hide checkboxes, drag to reorder
 * (or the up/down buttons for keyboard users) and Reset. Changes apply live and persist.
 */
export function RibbonCustomize() {
  const { customizeOpen, hidden, order } = useRibbonState();
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const label = new Map(MODULES.map((m) => [m.id, m.label]));

  useEffect(() => {
    if (!customizeOpen) {
      setDrag(null);
      setDrop(null);
    }
  }, [customizeOpen]);

  /** Rewrites the global order from per-group lists so it always covers every button. */
  const commitGroup = (group: string, ids: string[]) => {
    const flat = RIBBON_GROUPS.flatMap((g) => (g === group ? ids : groupIds(g, order)));
    ribbonStore.setLayout({ hidden, order: flat });
  };
  const move = (group: string, id: string, delta: number) => {
    const ids = groupIds(group, order);
    const from = ids.indexOf(id);
    commitGroup(group, moveItem(ids, from, from + delta));
  };
  const dropOn = (group: string, targetId: string) => {
    if (!drag || drag === targetId || !drop) return;
    const ids = groupIds(group, order);
    if (!ids.includes(drag)) return;
    const without = ids.filter((x) => x !== drag);
    let at = without.indexOf(targetId);
    if (drop.where === 'after') at += 1;
    without.splice(at, 0, drag);
    commitGroup(group, without);
  };

  return (
    <Dialog
      open={customizeOpen}
      onOpenChange={(o) => ribbonStore.openCustomize(o)}
      title={tl('Customize ribbon')}
      description={tl('Show or hide buttons and drag to reorder them within a group.')}
      width={420}
    >
      <div data-testid="ribbon-customize" style={{ maxHeight: '52vh', overflow: 'auto' }}>
        {RIBBON_GROUPS.map((g) => {
          const ids = groupIds(g, order);
          return (
            <section key={g} className="ht-rc-group" aria-label={g}>
              <h4>{g}</h4>
              {ids.map((id, i) => (
                <div
                  key={id}
                  className="ht-rc-row"
                  draggable
                  data-dragging={drag === id || undefined}
                  data-drop={drop?.id === id ? drop.where : undefined}
                  onDragStart={(e) => {
                    setDrag(id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', id);
                  }}
                  onDragOver={(e) => {
                    if (!drag || !ids.includes(drag)) return;
                    e.preventDefault();
                    const r = e.currentTarget.getBoundingClientRect();
                    const where = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
                    if (drop?.id !== id || drop.where !== where) setDrop({ id, where });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    dropOn(g, id);
                    setDrag(null);
                    setDrop(null);
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setDrop(null);
                  }}
                >
                  <GripVertical className="ht-rc-handle" size={14} aria-hidden />
                  <Checkbox
                    checked={!hidden.includes(id)}
                    onChange={(v) => ribbonStore.setHidden(id, !v)}
                    label={label.get(id)}
                  />
                  <button
                    type="button"
                    className="ht-icon-btn"
                    aria-label={`Move ${label.get(id)} up`}
                    disabled={i === 0}
                    onClick={() => move(g, id, -1)}
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    className="ht-icon-btn"
                    aria-label={`Move ${label.get(id)} down`}
                    disabled={i === ids.length - 1}
                    onClick={() => move(g, id, 1)}
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <div className="row gap8" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <Button data-testid="ribbon-reset" onClick={() => ribbonStore.reset()}>
          {tl('Reset')}
        </Button>
        <Button variant="primary" onClick={() => ribbonStore.openCustomize(false)}>
          {tl('Done')}
        </Button>
      </div>
    </Dialog>
  );
}
