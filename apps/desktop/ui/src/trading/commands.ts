import { toast } from '@htflow/ui-kit';
import { tradingDefaults } from './globalSettings';
import { paper } from '../state/market';
import { activeInstrument } from '../state/windows';
import { registerCommands, type Command } from '../shell/commands';
import { activeAccount, createPaperAccount, pickableAccounts, selectAccount } from './accounts';
import { atmStore, allTemplates } from './atmStore';
import { cancelOrder, closePosition, reversePosition, submitOrder } from './orders';
import { setChartPrefs, setPrefs, tradingPrefs } from './prefs';
import { openTradingSetup } from './setupNav';
import { linkLastTwo, useOco } from './oco';
import { setPanelWidth } from './panelWidth';

/** Every P17 trading action in the Command Palette (Ctrl+K) and the hot-key editor. */
const withInst = (fn: (id: string) => void) => () => {
  const id = activeInstrument();
  if (id) fn(id);
};

/** Order hot keys switched off in Settings → Trading. */
function hotkeysOff(): void {
  toast('info', 'Order hot keys are off', 'Turn them on in Settings → Trading.');
}

const base: Command[] = [
  {
    id: 'trading.panel.reset-width',
    label: 'Trading Panel: Reset width',
    group: 'Trading',
    keywords: 'resize trading panel width default',
    run: () => setPanelWidth('trading', null),
  },
  {
    id: 'trading.oco.toggle',
    label: 'Toggle OCO (one-cancels-other) for new orders',
    group: 'Trading',
    keywords: 'oco one cancels other link group',
    run: () => {
      const on = !useOco.getState().enabled;
      useOco.getState().setEnabled(on);
      toast('info', on ? 'OCO on' : 'OCO off', on ? 'Resting orders join one OCO group.' : '');
    },
  },
  {
    id: 'trading.oco.new',
    label: 'Start a new OCO group',
    group: 'Trading',
    keywords: 'oco one cancels other',
    run: () => useOco.getState().newGroup(),
  },
  {
    id: 'trading.oco.linkLast',
    label: 'Link the last two working orders as OCO',
    group: 'Trading',
    keywords: 'oco one cancels other link pair',
    run: () => {
      const g = linkLastTwo(activeAccount(), activeInstrument() ?? undefined);
      toast(
        g ? 'success' : 'warning',
        g ? 'Orders linked as OCO' : 'Nothing to link',
        g ? 'The first fill or cancel cancels the other.' : 'Two working orders are needed.',
      );
    },
  },
  {
    id: 'trading.setup.atm',
    label: 'ATM templates…',
    group: 'Trading',
    keywords: 'auto trade management bracket stop target breakeven trailing',
    run: () => openTradingSetup('atm'),
  },
  {
    id: 'trading.setup.accounts',
    label: 'Paper accounts…',
    group: 'Trading',
    keywords: 'account balance reset currency',
    run: () => openTradingSetup('accounts'),
  },
  {
    id: 'trading.setup.confirm',
    label: 'Order confirmations…',
    group: 'Trading',
    keywords: 'confirm dialog',
    run: () => openTradingSetup('confirm'),
  },
  {
    id: 'trading.setup.chart',
    label: 'Chart trading settings…',
    group: 'Trading',
    keywords: 'order lines colours position line fills',
    run: () => openTradingSetup('chart'),
  },
  {
    id: 'trading.account.new',
    label: 'New paper account',
    group: 'Trading',
    run: () => {
      const a = createPaperAccount(`Paper ${pickableAccounts().length + 1}`);
      selectAccount(a.id);
      openTradingSetup('accounts');
    },
  },
  {
    id: 'trading.account.reset',
    label: 'Reset active paper account',
    group: 'Trading',
    run: () => {
      const id = activeAccount();
      const a = paper.accounts.get(id);
      if (a && window.confirm(`Reset ${a.name}? Positions and orders are removed.`))
        paper.resetAccount(id);
    },
  },
  {
    id: 'trading.account.next',
    label: 'Switch to next paper account',
    group: 'Trading',
    run: () => {
      const list = pickableAccounts();
      const i = list.findIndex((a) => a.id === activeAccount());
      const next = list[(i + 1) % list.length];
      if (next) selectAccount(next.id);
    },
  },
  {
    id: 'trading.bracket.toggle',
    label: 'Toggle SL / TP (ATM) on new orders',
    group: 'Trading',
    run: () => setPrefs({ bracketOn: !tradingPrefs.get().bracketOn }),
  },
  {
    id: 'trading.atm.custom',
    label: 'ATM: custom SL / TP',
    group: 'Trading',
    run: () => setPrefs({ atmId: '' }),
  },
  {
    id: 'trading.chart.toggle',
    label: 'Toggle trading on chart',
    group: 'Trading',
    run: () => setChartPrefs({ enabled: !tradingPrefs.get().chart.enabled }),
  },
  {
    id: 'trading.chart.fills',
    label: 'Toggle fill markers on charts',
    group: 'Trading',
    run: () => setChartPrefs({ showFills: !tradingPrefs.get().chart.showFills }),
  },
  {
    id: 'trading.buy-market',
    label: 'Buy market (active instrument)',
    group: 'Trading',
    scope: 'trading',
    run: withInst((id) => {
      const td = tradingDefaults();
      if (!td.orderHotkeys) return hotkeysOff();
      void submitOrder({ instrumentId: id, side: 'buy', type: 'market', qty: td.qty, tif: td.tif });
    }),
  },
  {
    id: 'trading.sell-market',
    label: 'Sell market (active instrument)',
    group: 'Trading',
    scope: 'trading',
    run: withInst((id) => {
      const td = tradingDefaults();
      if (!td.orderHotkeys) return hotkeysOff();
      void submitOrder({
        instrumentId: id,
        side: 'sell',
        type: 'market',
        qty: td.qty,
        tif: td.tif,
      });
    }),
  },
  {
    id: 'trading.close',
    label: 'Close position (active instrument)',
    group: 'Trading',
    run: withInst((id) => (tradingDefaults().orderHotkeys ? void closePosition(id) : hotkeysOff())),
  },
  {
    id: 'trading.reverse',
    label: 'Reverse position (active instrument)',
    group: 'Trading',
    run: withInst((id) =>
      tradingDefaults().orderHotkeys ? void reversePosition(id) : hotkeysOff(),
    ),
  },
  {
    id: 'trading.cancel-all',
    label: 'Cancel all orders (active instrument)',
    group: 'Trading',
    run: withInst((id) => paper.cancelAll(activeAccount(), id)),
  },
  {
    id: 'trading.cancel-last',
    label: 'Cancel last working order',
    group: 'Trading',
    run: withInst((id) => {
      const os = paper.workingOrders(activeAccount(), id);
      const last = os[os.length - 1];
      if (last) void cancelOrder(last);
    }),
  },
];

registerCommands(base);

// One "Use ATM: <name>" command per template, refreshed when templates change.
let unAtm: (() => void) | null = null;
const refreshAtmCommands = () => {
  unAtm?.();
  unAtm = registerCommands(
    allTemplates().map((t) => ({
      id: `trading.atm.${t.id}`,
      label: `ATM: use ${t.name}`,
      group: 'Trading' as const,
      run: () => setPrefs({ atmId: t.id, bracketOn: true }),
    })),
  );
};
refreshAtmCommands();
atmStore.subscribe(refreshAtmCommands);
