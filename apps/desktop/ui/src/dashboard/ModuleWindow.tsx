import type { IDockviewPanelProps } from 'dockview';
import { PowerOff } from 'lucide-react';
import { EmptyState } from '@htflow/ui-kit';
import { t, translateLiteral as tl, tt } from '@htflow/i18n';
import type { ModuleWindowState, WindowState } from '@htflow/workspace';
import { useWindows } from '../state/windows';
import { moduleDef } from '../shell/modules';
import { MODULE_ICONS } from '../shell/icons';
import { moduleView } from '../modules/registry';
import { isModuleDisabled } from '../state/modules';
import { useSetting } from '../state/settings';

/** Hosts any registered module view; unbuilt modules show the phase placeholder. */
export function ModuleWindow(props: IDockviewPanelProps) {
  const id = props.api.id;
  const s = useWindows((st) => st.windows[id]) as ModuleWindowState | undefined;
  useSetting('modules.disabled'); // re-render when Settings → Custom modules changes
  if (!s) return null;
  const reg = moduleView(s.module);
  if (reg && isModuleDisabled(s.module)) {
    return (
      <EmptyState
        icon={<PowerOff size={28} />}
        title={tt`${tl(reg.label ?? s.module)} is disabled`}
      >
        {tl('Enable it again in Settings → Custom modules.')}
      </EmptyState>
    );
  }
  if (reg) {
    const View = reg.view;
    return (
      <View
        windowId={id}
        state={s}
        setParams={(patch) => {
          const cur = useWindows.getState().windows[id];
          if (cur?.kind !== 'module') return;
          useWindows
            .getState()
            .patch(id, { params: { ...(cur.params ?? {}), ...patch } } as Partial<WindowState>);
        }}
      />
    );
  }
  const def = moduleDef(s.module);
  const Icon = MODULE_ICONS[s.module] ?? MODULE_ICONS.chart!;
  return (
    <EmptyState
      icon={<Icon size={28} />}
      title={t('empty.module.title', { name: def?.label ?? s.module })}
    >
      {t('empty.module.body', { phase: def?.phase ?? '—' })}
    </EmptyState>
  );
}
