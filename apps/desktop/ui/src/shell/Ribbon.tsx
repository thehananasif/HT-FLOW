import { Fragment } from 'react';
import { RibbonButton } from '@htflow/ui-kit';
import { MODULES } from './modules';
import { MODULE_ICONS } from './icons';
import { runCommand } from './commands';

/** Top ribbon: grouped icon-over-label buttons (P02 / P44). Groups scroll horizontally. */
export function Ribbon({ compact }: { compact?: boolean }) {
  const groups = [...new Set(MODULES.map((m) => m.group))];
  return (
    <nav className="ribbon" aria-label="Ribbon">
      {groups.map((g, gi) => (
        <Fragment key={g}>
          {gi > 0 && <div className="ribbon-sep" />}
          <div className="ribbon-group" role="group" aria-label={g}>
            {MODULES.filter((m) => m.group === g).map((m) => {
              const Icon = MODULE_ICONS[m.id] ?? MODULE_ICONS.chart!;
              return (
                <RibbonButton
                  key={m.id}
                  icon={<Icon />}
                  label={m.label}
                  hasMenu={m.hasMenu}
                  compact={compact}
                  data-testid={`ribbon-${m.id}`}
                  onClick={() => runCommand(`open.${m.id}`)}
                />
              );
            })}
          </div>
        </Fragment>
      ))}
    </nav>
  );
}
