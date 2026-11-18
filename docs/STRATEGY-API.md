# HT Strategy API (HT Editor)

Strategies written in the **HT Editor** (Strategies window → HT Editor tab) are JavaScript with
optional TypeScript syntax (types, interfaces and `as` casts are stripped; nothing is
type-checked). A strategy is one entry file (`strategy.ts`) plus optional helper files that it
imports with `import { x } from './util1'`. The code runs in a sandbox (a dedicated Web Worker with
no DOM and no network, see [SECURITY-AUDIT.md](SECURITY-AUDIT.md#ht-editor-sandbox)); everything
below is available as a global in every file, or as `import { buy, ta } from 'ht'`.

Prices are in price units (e.g. `5012.25`). Stop / target / trail distances are in **ticks**.

## Structure

```ts
export const meta = {
  name: 'MA cross',
  description: 'Shown in the strategy list',
  timeframe: '5m', // primary bars: 30s, 1m, 5m, 1h, 1d, 500t (ticks), 1000v (volume), 8r (range)
  timeframes: ['15m', '1h'], // extra series readable with bars('15m') / indicator(…, { tf: '15m' })
};

export const params = {
  fast: param.int('Fast MA', 9, { min: 2, max: 200 }),
  risk: param.float('Risk $', 250, { min: 0, step: 50 }),
  longOnly: param.bool('Long only', false),
  mode: param.choice('Mode', 'trend', ['trend', 'fade']),
};

export function onStart() {}
export function onBar(bar: Bar) {}
export function onTick(tick: Tick) {}
export function onOrderUpdate(order: Order) {}
export function onStop() {}
```

`params` declarations become a settings form; inside hooks they are plain values
(`params.fast` is a number). A strategy must export `onBar` or `onTick`. Hooks are synchronous.

| Hook                   | When                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `onStart()`            | Once, before the first event (10× the CPU budget).                                                         |
| `onBar(bar)`           | Every closed bar of the primary timeframe.                                                                 |
| `onTick(tick)`         | Every trade `{ time, price, qty, side }`. In backtests every trade is a round trip to the sandbox: slower. |
| `onOrderUpdate(order)` | Fills (incl. bracket stop / target children), cancels and rejections of your orders.                       |
| `onStop()`             | When the run ends; orders are ignored.                                                                     |

## Data

| Function                                                         | Returns                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bars(tf?, count?)`                                              | Closed bars, oldest first: `{ time, open, high, low, close, volume, buyVolume, sellVolume, delta, trades, index }`. `tf` must be the primary timeframe or one of `meta.timeframes`.                |
| `closes(tf?, count?)`                                            | Close prices.                                                                                                                                                                                      |
| `footprint(barsAgo?, tf?)`                                       | `{ price, bid, ask, volume, delta }[]` (volume at price; the last 500 bars keep their footprint).                                                                                                  |
| `delta(barsAgo?, tf?)`, `cvd(tf?)`                               | Bar delta, cumulative delta.                                                                                                                                                                       |
| `poc(barsAgo?, tf?)`                                             | Point of control.                                                                                                                                                                                  |
| `imbalances(barsAgo?, { ratio?, minVolume? }, tf?)`              | Diagonal imbalances `{ price, side, ratio }[]` (default ratio 3).                                                                                                                                  |
| `stackedImbalances(barsAgo?, opts?, tf?)`                        | Longest same-side run `{ count, side, from, to }`.                                                                                                                                                 |
| `book()`                                                         | Top 10 levels `{ bids: {price,size}[], asks }`, or `null`.                                                                                                                                         |
| `indicator(id, inputs?, { tf? })`                                | Any indicator of the registry (autocomplete lists the ids): `.value(output?, barsAgo?)`, `.values(output?, count?)`. Price outputs are in price units. Example: `indicator('vwap').value('vwap')`. |
| `ta.sma / ema / rsi / stdev / highest / lowest (values, length)` | Last value (NaN when there is not enough data). `ta.smaSeries`, `ta.emaSeries` return arrays.                                                                                                      |
| `ta.atr(bars, length)`, `ta.vwap(bars)`                          | On bar objects.                                                                                                                                                                                    |
| `ta.crossOver(a, b)`, `ta.crossUnder(a, b)`                      | Compare the last two elements of two arrays.                                                                                                                                                       |
| `position()`                                                     | `{ qty, side: 'long' \| 'short' \| 'flat', avgPrice, openPnl }`                                                                                                                                    |
| `account()`                                                      | `{ balance, equity, dayPnl, currency }`                                                                                                                                                            |
| `orders()`                                                       | Working orders.                                                                                                                                                                                    |
| `time()`, `last()`, `canTrade()`, `instrument`                   | Clock (ms), last price, trading allowed, `{ symbol, tickSize, tickValue, pricePrecision }`.                                                                                                        |

Position, account and orders are a snapshot taken before the hook ran: orders you place in a hook
are applied after it returns, and the next event shows their effect.

## Orders

| Function                                                       |                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `buy(qty, opts?)`, `sell(qty, opts?)`                          | Market order. Returns an order id (`'c1'`), or `null` when trading is off. |
| `limit(side, qty, price, opts?)`                               | `side` is `'buy'` or `'sell'`.                                             |
| `stop(side, qty, price, opts?)`                                | Stop order (market when touched).                                          |
| `bracket(side, qty, { entry?, stop, target, trail?, label? })` | Entry (limit at `entry`, else market) with exits.                          |
| `close(label?)`                                                | Flatten and cancel working orders.                                         |
| `cancel(id)`, `cancelAll()`                                    |                                                                            |

`opts`: `{ stop?: ticks, target?: ticks | ticks[] (up to 4, quantity split), trail?: ticks, label?: string }`.

Every order is validated by the host before anything is sent: side / type / quantity / price
types, max order quantity, the strategy's max position, limit and stop prices within 20 % of the
last price, bracket distances, at most 20 orders per callback. It then goes through the order
engine's pre-trade checks: the account's **risk rules** (daily loss limit, max position, orders
per minute, trading hours, locks — the Risk module), the slippage guard, and for backtests a risk
engine built from the editor's limits. Rejections are logged and reported to `onOrderUpdate`
with `status: 'rejected'`.

## Logging and plots

- `log(...values)`, `warn(...values)` — run log (50 lines per callback, 500 characters each).
- `plot(name, value, { color?, overlay? })` — a value at the current bar. Overlay plots are drawn
  on the backtest's **Plots** chart with the trades.

## Running

- **Backtest**: history of the selected instrument / day / hours (tick store or simulator),
  primary bars from `meta.timeframe` or the Bars picker, tape fills with slippage and
  commission. Results: summary stats, equity curve with drawdown, trades, plots, log.
  Deterministic: the same code, params and data give the same trades.
- **Paper**: the live feed of the instrument, orders on the active paper account. The run first
  replays the session's history with orders disabled (warm-up), then trades.
- **Live…**: only through a connector that supports live order routing, after an arming dialog
  (type the symbol, acknowledge). No connector implements live orders yet (see BLOCKERS).
- **KILL**: stops every running strategy (HT Editor and chart strategies) and flattens.
- **Deploy to my VPS**: the VPS runner tab's deploy dialog with the script preselected; the
  compiled script ships inside the runner bundle and runs (paper) on your VPS.
- Runs tab: every paper / live run with status, position, trades, net P&L, stop and logs.

## Files

Save keeps strategies in your profile. **Export** writes a `.htstrat` file (JSON:
`{ format: 'htstrat', version: 1, id, name, files: [{ name, source }], params }`); **Import
.htstrat** reads one back (file names `[A-Za-z0-9_-].ts|js`, at most 16 files of 256 KB).

## Limits

| Guard                              | Default                                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU time per callback              | 250 ms (editor setting; `onStart` 10×). Over budget → the run stops with an error; a callback that never returns gets the worker terminated after budget + 1.5 s. |
| Orders / logs / plots per callback | 20 / 50 / 32                                                                                                                                                      |
| Bars kept per series               | 20,000 (footprint on the last 500)                                                                                                                                |
| Imports                            | Only the strategy's own files and `'ht'`.                                                                                                                         |
| Not available                      | DOM, `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `import()`, `eval`, `Function`, timers, storage.                                                    |
