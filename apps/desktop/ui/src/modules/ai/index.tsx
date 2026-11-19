import { useEffect, useSyncExternalStore } from 'react';
import { Button, Tabs } from '@htflow/ui-kit';
import { t } from '@htflow/i18n';
import { registerModule, type ModuleViewProps } from '../registry';
import { registerCommands } from '../../shell/commands';
import { AgentTab } from './AgentDashboard';
import { dispatchAi, onAi, type AiTab } from './bus';
import { ChatTab } from './ChatView';
import { ProvidersTab } from './ProvidersView';
import { QUICK_ACTIONS } from './slash';
import {
  activeConversation,
  ai,
  clearAudit,
  killSwitch,
  newConversation,
  startAgent,
  stopAgent,
} from './runtime';
import './styles.css';

const TABS: AiTab[] = ['chat', 'agent', 'audit', 'providers'];

function useAi() {
  return useSyncExternalStore(ai.subscribe, ai.version);
}

const openAi = () => window.dispatchEvent(new CustomEvent('htflow:open-module', { detail: 'ai' }));

/** Opens the window (if needed) and hands `a` to it. */
function act(a: Parameters<typeof dispatchAi>[0]): void {
  openAi();
  if (a.type !== 'tab' && !activeConversation()) newConversation();
  dispatchAi(a);
}

/* ------------------------------------------------------------------ audit */

function AuditTab() {
  useAi();
  const rows = [...ai.state().audit].reverse();
  return (
    <div className="ai-audit col" data-testid="ai-audit">
      <div className="ai-audit-head">
        <span>{t('ai.toolCalls', { n: rows.length })}</span>
        <span className="grow" />
        <Button size="sm" variant="outline" onClick={clearAudit}>
          {t('ai.clear')}
        </Button>
      </div>
      <table className="ai-audit-table tnum">
        <thead>
          <tr>
            <th>{t('ai.col.time')}</th>
            <th>{t('ai.col.mode')}</th>
            <th>{t('ai.col.tool')}</th>
            <th>{t('ai.col.args')}</th>
            <th>{t('ai.col.result')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.ok ? '' : 'is-error'} data-testid="ai-audit-row">
              <td>{new Date(r.ts).toLocaleTimeString()}</td>
              <td>{r.mode}</td>
              <td>{r.tool}</td>
              <td className="ai-args">{r.args}</td>
              <td>{r.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ window */

function AiWindow({ state, setParams }: ModuleViewProps) {
  const tab: AiTab = TABS.includes(state.params?.tab as AiTab)
    ? (state.params!.tab as AiTab)
    : 'chat';
  useAi();
  useEffect(() => {
    if (!ai.state().convs.length) newConversation();
  }, []);
  // Palette commands that switch tabs, or need the chat tab to be showing.
  useEffect(
    () =>
      onAi((a) => {
        if (a.type === 'tab') {
          setParams({ tab: a.tab });
          return true;
        }
        if (tab !== 'chat') {
          setParams({ tab: 'chat' });
          return false; // kept until the chat tab mounts
        }
        return false;
      }),
    [tab, setParams],
  );
  return (
    <div className="ai-win col" data-testid="ai-window" data-ai-exclude="">
      <Tabs<AiTab>
        value={tab}
        onChange={(v) => setParams({ tab: v })}
        tabs={[
          { value: 'chat', label: t('ai.tab.chat') },
          { value: 'agent', label: t('ai.tab.agent') },
          { value: 'audit', label: t('ai.tab.audit') },
          { value: 'providers', label: t('ai.tab.providers') },
        ]}
      />
      <div className="ai-body">
        {tab === 'chat' && <ChatTab />}
        {tab === 'agent' && <AgentTab />}
        {tab === 'audit' && <AuditTab />}
        {tab === 'providers' && <ProvidersTab />}
      </div>
    </div>
  );
}

registerModule({ id: 'ai', view: AiWindow });

type Cmd = Parameters<typeof registerCommands>[0][number];

registerCommands([
  {
    id: 'ai.open',
    label: t('ai.cmd.open'),
    group: 'Platform',
    keywords: 'llm chat gpt claude gemini grok',
    run: openAi,
  },
  {
    id: 'ai.ask-chart',
    label: t('ai.cmd.askChart'),
    group: 'Chart',
    keywords: 'llm screenshot analyse explain',
    run: () => act({ type: 'fill', text: t('ai.askChartPrompt'), shot: true }),
  },
  {
    id: 'ai.new-chat',
    label: t('ai.cmd.newChat'),
    group: 'Platform',
    keywords: 'llm conversation',
    run: () => {
      openAi();
      newConversation();
      dispatchAi({ type: 'tab', tab: 'chat' });
      dispatchAi({ type: 'focus' });
    },
  },
  ...QUICK_ACTIONS.map((q): Cmd => ({
    id: `ai.quick.${q.id}`,
    label: t(`ai.cmd.quick.${q.id}` as 'ai.cmd.quick.analyse'),
    group: 'Chart',
    keywords: 'llm ai ask',
    run: () => act({ type: 'quick', id: q.id }),
  })),
  { id: 'ai.stop', label: t('ai.cmd.stop'), group: 'Platform', run: () => act({ type: 'stop' }) },
  {
    id: 'ai.edit-last',
    label: t('ai.cmd.editLast'),
    group: 'Platform',
    run: () => act({ type: 'editLast' }),
  },
  {
    id: 'ai.regenerate',
    label: t('ai.cmd.regenerate'),
    group: 'Platform',
    run: () => act({ type: 'regenerate' }),
  },
  {
    id: 'ai.tab.agent',
    label: t('ai.cmd.tabAgent'),
    group: 'Platform',
    keywords: 'llm dashboard',
    run: () => act({ type: 'tab', tab: 'agent' }),
  },
  {
    id: 'ai.tab.providers',
    label: t('ai.cmd.tabProviders'),
    group: 'Platform',
    keywords: 'llm api key model',
    run: () => act({ type: 'tab', tab: 'providers' }),
  },
  {
    id: 'ai.agent.start',
    label: t('ai.cmd.startAgent'),
    group: 'Trading',
    keywords: 'llm automated bot',
    run: () => void startAgent(),
  },
  { id: 'ai.agent.stop', label: t('ai.cmd.stopAgent'), group: 'Trading', run: stopAgent },
  {
    id: 'ai.agent.pause',
    label: t('ai.cmd.pauseAgent'),
    group: 'Trading',
    keywords: 'llm automated bot',
    run: stopAgent,
  },
  {
    id: 'ai.kill',
    label: t('ai.cmd.kill'),
    group: 'Trading',
    keywords: 'emergency stop llm agent',
    run: killSwitch,
  },
]);
