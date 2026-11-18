import { CATEGORIES } from '@htflow/indicator-sdk';
import { CATALOG, INDICATORS, indicatorById, isImplemented } from './index';

const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Renders docs/INDICATORS.md from the catalog (run through Prettier afterwards to align columns). */
export function renderCatalogDoc(): string {
  const done = CATALOG.filter(isImplemented).length;
  const lines: string[] = [];
  lines.push(
    '# Indicator catalog (Appendix B)',
    '',
    'Status of every Appendix B entry. **implemented** = available in the Indicators dialog (chart header "Indicators", chart right-click menu, command "Indicators…" / Ctrl+I), built on `@htflow/indicator-sdk` with a Vitest reference test in `packages/indicators/src/*.test.ts`. **pending** = listed in the dialog (greyed, cannot be added) but not built; the note says why (blocked data source, ambiguous spec entry).',
    '',
    `- Catalog entries: ${CATALOG.length} (${done} implemented, ${CATALOG.length - done} pending)`,
    `- Distinct indicator implementations: ${INDICATORS.length}`,
    '- Variants (Appendix B: "parameter variants … to reach 222") are presets of an implementation, e.g. RSI of CVD = RSI with source = Cumulative delta.',
    '- Multi-timeframe (MTF) entries wrap their base indicator: it is computed on the chart\'s own bars merged per higher-timeframe period (identical to a BarSeries of that timeframe built from the same trades) and mapped back to the chart; "last closed bar" (default, never repaints) or "forming bar" per input.',
    '- Crypto Metrics and OI entries read funding / open interest / liquidations from the market store (`DerivativesLog` in the SDK). Simulated and spot feeds have none: the legend then says "no data from this feed".',
    '- Every implementation is also checked by the incremental-contract test: updating trade by trade gives exactly the same output as a full recompute.',
    '',
    'Common inputs: source (O/H/L/C/HL2/HLC3/OHLC4/volume/delta/CVD/buy/sell/trades) where the formula takes a series; reset (session/week/month/never) on cumulative indicators; timeframe override on the MTF entries; per output colour, width, line style, opacity, visible, label and axis price tag (Style tab); alerts when an output crosses a level or another output (Alerts tab); timeframe visibility; pane / scale / z-order / pane height, timeframe override (any indicator, computed on higher-timeframe bars) and data source (another symbol, mapped by time) (Advanced). Indicators without tape / feed inputs are computed in background workers (Stage 8).',
    '',
    "- Second-instrument indicators (Spread, Ratio, Correlation, Beta) have an `instrument` input (symbol picker): the second instrument's bars of the chart timeframe are aligned to the chart bar by bar (last aux bar at or before the bar open, gaps forward-filled; prices compared in real prices, not ticks). Correlation / Beta are rolling over simple returns. They run on the main thread.",
    '- Account Info Display, Position Sizing Tracker, Options Position and Options Risk Profile read a read-only snapshot of the active paper account (balance, position, tick value, open option positions) from the trading store; they show a note when there is no account / no options position.',
    '- Options Board and Volatility Smile read an options chain from the indicator context (`ctx.options`, lazily loaded only once such an indicator is on the chart, like `ctx.cot`): BTC / ETH instruments of a real venue use the free Deribit public API (desktop: through the allow-listed native `net_fetch_text`), demo-feed instruments the built-in simulated chain and any other symbol a generic simulated chain around the live price. Simulated chains are labelled "simulated" in the legend. The Board draws the nearest strikes of one expiry as price levels (call/put OI, volume, IV) plus the max-pain strike; the Smile draws IV against strike sideways in the price scale (strike on the price axis, IV along the bars) for up to three expiries. CME options need a user feed and are not included.',
    '- Market Profile & TPO is a profile overlay: per UTC day or week it builds time-price opportunities from the chart bars (30-minute bars give the classic profile; the letter view is the TPO chart type) and draws value area, POC, initial balance, single prints and poor highs / lows.',
    '- CMS and Margin Zones are not defined in Appendix B (the spec only lists the names, under Momentum and Levels / structure), so they have original definitions. CMS = Cumulative Market Sentiment: 100 · Σdelta / Σvolume over a rolling window, then EMA-smoothed (range -100..+100). Margin Zones: price bands where leveraged positions opened at a reference price (day open, week open or last close) are liquidated, per leverage tier (default 3, 5, 10, 25, 50, 100x) and maintenance margin rate (default 0.5 %): long liquidation = ref · (1 - 1/L + mmr), short liquidation = ref · (1 + 1/L - mmr); higher leverage is closer to the reference and the bands nest outwards.',
    '- Custom Formula: up to 1000 characters, nesting limited to 48 levels, names open high low close volume delta buyVol sellVol …, calls sma ema highest lowest abs min max iff ref …; the Edit button opens an editor with syntax errors (line:col) and a live preview of the last bars. Custom script (`.htind`) adds `let` bindings and several `plot()` outputs.',
    '- Custom Formula and Custom script (`.htind`) use HT Script, a small sandboxed indicator language (interpreted, no `eval`; only bar values, math / series functions and plot / input declarations are reachable). User scripts are written in the Script Editor window and appear under Custom (scripts).',
    '',
    'Regenerate this file from `packages/indicators/src/catalog.ts` when the catalog changes: `UPDATE_INDICATOR_DOC=1 pnpm exec vitest run packages/indicators/src/doc.test.ts && pnpm exec prettier --write docs/INDICATORS.md`.',
    '',
  );
  for (const cat of CATEGORIES) {
    const entries = CATALOG.filter((e) => e.category === cat.id);
    if (!entries.length) continue;
    lines.push(`## ${cat.label} (${entries.length})`, '');
    lines.push('| # | Indicator | Status | Implementation | Formula / note |');
    lines.push('| --- | --- | --- | --- | --- |');
    entries.forEach((e, k) => {
      const name = e.group ? `${e.name} (${e.group})` : e.name;
      const ok = isImplemented(e);
      let impl = '';
      let note = '';
      if (ok) {
        const inp = e.inputs
          ? ' ' +
            Object.entries(e.inputs)
              .map(([a, b]) => `${a}=${b}`)
              .join(', ')
          : '';
        impl = `\`${e.impl}\`${inp}`;
        note = indicatorById(e.impl!)?.formula ?? '';
      } else note = e.note ?? '';
      lines.push(
        `| ${k + 1} | ${esc(name)} | ${ok ? 'implemented' : 'pending'} | ${impl} | ${esc(note)} |`,
      );
    });
    lines.push('');
  }
  return lines.join('\n');
}
