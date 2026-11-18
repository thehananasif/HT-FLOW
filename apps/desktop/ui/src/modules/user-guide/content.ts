import type { Article } from './search';

/** Default shortcuts (Appendix C + the commands registered by modules). Rebind in Settings → Hot keys. */
export const SHORTCUTS: { keys: string; action: string; scope: string }[] = [
  { keys: 'Ctrl+K', action: 'Command palette', scope: 'Global' },
  { keys: 'Ctrl+,', action: 'Settings', scope: 'Global' },
  { keys: 'Ctrl+L', action: 'Lock HT Flow', scope: 'Global' },
  { keys: 'T', action: 'Show / hide the Trading Panel', scope: 'Global' },
  { keys: 'H', action: 'Breakeven (move stops to entry)', scope: 'Global' },
  { keys: 'Ctrl+I', action: 'Indicators', scope: 'Chart' },
  { keys: 'Alt+V', action: 'Footprint mode: Volume', scope: 'Chart' },
  { keys: 'Alt+T', action: 'Footprint mode: Trades', scope: 'Chart' },
  { keys: 'Alt+B', action: 'Footprint mode: Bid x Ask', scope: 'Chart' },
  { keys: 'Alt+D', action: 'Footprint mode: Delta', scope: 'Chart' },
  { keys: 'Del', action: 'Delete the selected drawing', scope: 'Chart' },
  { keys: 'Ctrl+Z / Ctrl+Y', action: 'Undo / redo drawing edits', scope: 'Chart' },
  { keys: 'Space', action: 'Replay: play / pause', scope: 'Replay' },
  { keys: 'Right / Left', action: 'Replay: step one bar forward / back', scope: 'Replay' },
  { keys: 'Shift+Right', action: 'Replay: step one tick', scope: 'Replay' },
  { keys: '1 – 9', action: 'Replay: speed presets', scope: 'Replay' },
];

const shortcutTable = [
  '| Keys | Action | Scope |',
  '| --- | --- | --- |',
  ...SHORTCUTS.map((s) => `| \`${s.keys}\` | ${s.action} | ${s.scope} |`),
].join('\n');

export const ARTICLES: Article[] = [
  {
    id: 'welcome',
    title: 'Welcome to HT Flow',
    section: 'Getting started',
    keywords: 'first run intro overview paper simulator tour',
    body: `HT Flow is an order-flow trading workspace: footprint charts, a depth-of-market ladder, tape tools and a paper-trading panel, all running on your PC.

## First steps

1. Create an account and **save the 24-word recovery code**. There is no server, so that code is the only way back in.
2. The dashboard opens with a DOM, a footprint chart and the Trading Panel on the built-in simulator (badge **Sim**).
3. Press \`Ctrl+K\` and type what you want. Every window, layout and setting is a command.
4. Run **Start guided tour** from the command palette for a 60-second walk-through.

## Where things are

- **Ribbon** (top): one button per window, grouped by purpose.
- **Chart, DOM, Trading Panel**: the core trading trio.
- **Status bar** (bottom): connection state, latency, clock and version.`,
  },
  {
    id: 'layouts',
    title: 'Layouts and workspaces',
    section: 'Getting started',
    keywords: 'dock split detach link group tabs workspace save',
    opens: ['workspaces', 'layout-settings'],
    body: `Title bar → **Layout** switches between presets: DOM | Chart | Panel, Grid 2x2, 1 + 2, Split and Single.

- Drag a window header to dock it anywhere; drag splitters to resize.
- **Split right / Split down** duplicates the active window (a floating window gets a floating copy beside it). **Detach window** moves it into its own OS window you can drag to another monitor (desktop app; Settings → Layout → Detach window opens) or floats it; **Re-attach** in that window's title bar brings it back.
- Layout tabs at the bottom keep several layouts; **+** adds one, double-click renames.
- **Link groups**: click the coloured dot in a window header. Changing the instrument in one window changes every window of the same colour.

Everything autosaves into the workspace, which is stored encrypted with your profile.`,
  },
  {
    id: 'chart',
    title: 'Charts and footprint',
    section: 'Analysis',
    keywords: 'candles volume profile footprint liquidity map order flow indicators drawings zoom',
    opens: ['chart', 'heatmap'],
    body: `The chart window has four templates: **Candles + Volume Profile**, **Footprint**, **Liquidity Map** and **Order Flow (Dark)**.

| Action | Mouse / key |
| --- | --- |
| Zoom time | Wheel |
| Zoom price | Ctrl + wheel, or drag the price axis |
| Pan | Drag; Shift + drag moves vertically |
| Auto-scale price | Double-click the price axis |
| Go to latest | Double-click the time axis |

- The left **side tools** hold footprint settings, the 21 footprint modes and the drawing tools.
- **Indicators** (\`Ctrl+I\`) adds studies on the price pane or in sub-panes.
- Right-click the chart for limit / stop orders at the cursor price.`,
  },
  {
    id: 'dom',
    title: 'Smart DOM',
    section: 'Analysis',
    keywords: 'depth of market ladder bid ask orders click flatten',
    opens: ['smart-dom'],
    body: `The ladder shows resting size at each price and your working orders.

- Left-click the Bid or Ask column to place a **buy limit** at that price; right-click for a **sell limit**. Hold \`Ctrl\` for stops.
- Click your order in the Orders / PnL column to cancel it.
- The footer has reverse, cancel, market buy / sell, **Flatten all** and a lock.`,
  },
  {
    id: 'trading',
    title: 'Trading Panel and paper account',
    section: 'Trading',
    keywords: 'order market limit stop oco bracket sl tp reverse position paper',
    opens: ['accounts', 'positions', 'orders', 'trades', 'activity'],
    body: `Orders are filled by the paper engine; the account starts with $50,000.

- **Trading Panel** (\`T\`): market, join ask / bid, cancel, reverse, breakeven (\`H\`), close. Options: OCO, time in force, reduce-only, and the **SL/TP** switch that attaches a stop and target in ticks.
- Tables: **Accounts**, **Positions**, **Orders**, **Trades** and **Trading Activity** in the ribbon.
- **Risk** sets daily loss limits and shows the risk meter in the title bar.`,
  },
  {
    id: 'tape',
    title: 'Tape tools',
    section: 'Analysis',
    keywords: 'smart tape bid ask all prices time and sales large lots filter',
    opens: ['smart-tape', 'bidask-tape', 'all-prices'],
    body: `- **Smart Tape**: time and sales with size filters and aggression colouring.
- **Bid/Ask Tape**: trades split by the side that was hit.
- **All Prices**: a price-by-price summary of volume traded in the session.`,
  },
  {
    id: 'watchlist',
    title: 'Watchlist, options and curves',
    section: 'Analysis',
    keywords: 'symbols market catalog options strategy analyser forward curve',
    opens: ['watchlist', 'options-board', 'forward-curve'],
    body: `- **Watchlist**: your symbols with last price and change; double-click to open a chart.
- **Options Board**: the chain and a strategy analyser with payoff and Greeks.
- **Forward curve**: futures term structure for a contract family.
- The instrument picker searches the market catalog (simulated, live and replay instruments).`,
  },
  {
    id: 'analytics',
    title: 'Market analytics',
    section: 'Analysis',
    keywords: 'pressure price change dom delta divergence',
    opens: ['market-pressure', 'price-change', 'dom-pressure', 'delta-divergence'],
    body: `Four compact dashboards summarise flow across your instruments: **Market Pressure**, **Price Change**, **DOM Pressure** and **Delta Divergence**. Each has its own settings menu for thresholds and colours.`,
  },
  {
    id: 'replay',
    title: 'Replay',
    section: 'Tools',
    keywords: 'historical playback speed sample session simulated',
    opens: ['replay'],
    body: `Replay re-plays recorded or simulated order flow on one clock, so charts, DOM and tape never show anything after the replay time.

1. Open **Replay**, choose instruments and a time range, then **Start**.
2. Use \`Space\` to play / pause, \`Right\` / \`Left\` to step a bar, \`1\`–\`9\` for speed.

For a quick demo run **Load sample replay session** from the command palette: it replays a fixed, seeded hour of a simulated instrument, identical every time.`,
  },
  {
    id: 'alerts',
    title: 'Alerts, journal and risk',
    section: 'Tools',
    keywords: 'notification sound price volume journal statistics daily limit',
    opens: ['alerts', 'journal', 'risk'],
    body: `- **Alerts**: price and order-flow conditions with sound and toast notifications.
- **Journal**: round-trip trades with notes, tags and statistics.
- **Risk**: daily loss and position limits; the title-bar meter turns amber, then red.`,
  },
  {
    id: 'info',
    title: 'RSS, News and Calendar',
    section: 'Information',
    keywords: 'feeds news economic calendar keywords opml',
    opens: ['rss', 'news', 'calendar'],
    body: `- **RSS Reader**: subscribe to feeds, import or export OPML, highlight keywords. Links open in **Web Pages**.
- **News** and **Calendar**: headlines and economic events, tagged to instruments.`,
  },
  {
    id: 'web-pages',
    title: 'Web Pages',
    section: 'Tools',
    keywords: 'browser tabs bookmarks url iframe',
    opens: ['web-pages'],
    body: `A tabbed mini browser with back, forward, reload and an address bar. Bookmarks (star button) are saved with your profile.

- Links clicked in the RSS reader open in a new tab here.
- **Browser preview**: pages are shown in an iframe; some sites refuse framing. Use **Open in system browser** for those.
- **Desktop app**: the app's content security policy blocks iframes, so a native child webview is required. Until then links open in your system browser.`,
  },
  {
    id: 'logs',
    title: 'Logs',
    section: 'Tools',
    keywords: 'errors console debug export diagnostics',
    opens: ['logs'],
    body: `An in-app log of what HT Flow is doing, including captured \`console.error\` output, uncaught errors and unhandled promise rejections.

- Filter by **level** and **source**, or search the text.
- **Pause** freezes the view while recording continues. **Copy**, **Export .txt** and **Clear** act on what you see.
- Attach an exported log when reporting a problem.`,
  },
  {
    id: 'connections',
    title: 'Connections and data sources',
    section: 'Data',
    keywords: 'binance live simulator provider api key broker',
    opens: ['connections'],
    body: `- **Simulated** instruments (BTCUSDT, CLZ6, GCZ6, ESZ6, NQZ6) work offline.
- **Binance Futures** is live and free; no API key needed.
- Broker and data-vendor connectors that need your own account are listed in **Connections**. Credentials are kept in your encrypted vault.`,
  },
  {
    id: 'settings',
    title: 'Settings and customisation',
    section: 'Getting started',
    keywords: 'theme colors hotkeys rebind sounds commission preferences',
    body: `Open Settings with \`Ctrl+,\`. Every visual and behaviour has a setting: colours and fonts, sounds, commissions, ribbon size and **Hot keys**, where each command can be rebound and limited to a scope (Global, Chart, Trading panel, Replay).`,
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    section: 'Reference',
    keywords: 'hotkeys keys appendix c bindings',
    body: `Default shortcuts. Rebind any of them in Settings → Hot keys; conflicts are flagged there.

${shortcutTable}`,
  },
  {
    id: 'tour',
    title: 'Guided tour',
    section: 'Reference',
    keywords: 'walkthrough onboarding first run restart',
    body: `A short spotlight tour highlights the ribbon, chart, DOM, Trading Panel and status bar. It appears once on first run. Start it again any time from the command palette: **Start guided tour**.`,
  },
];
