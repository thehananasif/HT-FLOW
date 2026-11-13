import { Fragment } from 'react';
import { ContextMenu, RibbonButton } from '@htflow/ui-kit';
import { MODULES } from './modules';
import { MODULE_ICONS } from './icons';
import { runCommand } from './commands';
import { RibbonCustomize } from './RibbonCustomize';
import { ribbonMenu } from './ribbonMenus';

/** Wraps a ribbon button in its module's ▾ menu, when the module registered one. */
function withMenu(id: string, button: JSX.Element): JSX.Element {
  const Menu = ribbonMenu(id);
  return Menu ? <Menu trigger={button} /> : button;
}
import { groupIds, ribbonStore, RIBBON_GROUPS, useRibbonState } from './ribbonStore';

/**
 * Top ribbon: grouped icon-over-label buttons (P02 / P44). Groups scroll horizontally.
 * Right-click (or Shift+F10) a button to hide it or open "Customize ribbon…".
 */
export function Ribbon({ compact }: { compact?: boolean }) {
  const { hidden, order } = useRibbonState();
  const byId = new Map(MODULES.map((m) => [m.id, m]));
  const groups = RIBBON_GROUPS.map((g) => ({
    group: g,
    items: groupIds(g, order)
      .filter((id) => !hidden.includes(id))
      .map((id) => byId.get(id)!),
  })).filter((g) => g.items.length > 0);
  return (
    <nav
      className="ribbon"
      aria-label="Ribbon"
      aria-keyshortcuts="ArrowLeft ArrowRight Home End"
      onKeyDown={(e) => {
        // P29 keyboard navigation: arrows move between ribbon buttons (Tab still visits each one).
        const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
        if (!keys.includes(e.key)) return;
        const btns = [
          ...e.currentTarget.querySelectorAll<HTMLElement>('button[data-testid^="ribbon-"]'),
        ];
        const i = btns.indexOf(document.activeElement as HTMLElement);
        if (i < 0) return;
        const n = btns.length;
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
        btns[next]?.focus();
        e.preventDefault();
      }}
    >
      {groups.map(({ group, items }, gi) => (
        <Fragment key={group}>
          {gi > 0 && <div className="ribbon-sep" />}
          <div className="ribbon-group" role="group" aria-label={group}>
            {items.map((m) => {
              const Icon = MODULE_ICONS[m.id] ?? MODULE_ICONS.chart!;
              return (
                <ContextMenu
                  key={m.id}
                  items={[
                    {
                      id: 'hide',
                      label: 'Hide button',
                      onSelect: () => ribbonStore.hide(m.id),
                    },
                    {
                      id: 'customize',
                      label: 'Customize ribbon…',
                      onSelect: () => ribbonStore.openCustomize(true),
                    },
                  ]}
                >
                  {withMenu(
                    m.id,
                    <RibbonButton
                      icon={<Icon />}
                      label={m.label}
                      hasMenu={m.hasMenu}
                      compact={compact}
                      data-testid={`ribbon-${m.id}`}
                      onClick={ribbonMenu(m.id) ? undefined : () => runCommand(`open.${m.id}`)}
                    />,
                  )}
                </ContextMenu>
              );
            })}
          </div>
        </Fragment>
      ))}
      {groups.length === 0 && (
        <button
          type="button"
          className="ht-btn ht-btn--sm"
          data-testid="ribbon-restore"
          onClick={() => ribbonStore.openCustomize(true)}
        >
          Customize ribbon…
        </button>
      )}
      <RibbonCustomize />
    </nav>
  );
}
