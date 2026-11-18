/** Autocomplete entries for the HT Strategy API (full reference: docs/STRATEGY-API.md). */
export interface ApiEntry {
  label: string;
  type: 'function' | 'variable' | 'keyword' | 'namespace' | 'property';
  detail: string;
  info: string;
  /** Text inserted (default: label). */
  apply?: string;
}

export const API_DOCS: ApiEntry[] = [
  { label: 'onStart', type: 'keyword', detail: 'export function onStart()', info: 'Called once before the first bar.', apply: 'export function onStart() {\n  \n}' },
  { label: 'onBar', type: 'keyword', detail: 'export function onBar(bar)', info: 'Called for every closed bar of the primary timeframe.', apply: 'export function onBar(bar: Bar) {\n  \n}' },
  { label: 'onTick', type: 'keyword', detail: 'export function onTick(tick)', info: 'Called for every trade { time, price, qty, side }. Slower in backtests.', apply: 'export function onTick(tick: Tick) {\n  \n}' },
  { label: 'onOrderUpdate', type: 'keyword', detail: 'export function onOrderUpdate(order)', info: 'Fills, cancels and rejections of your orders.', apply: 'export function onOrderUpdate(order: Order) {\n  \n}' },
  { label: 'onStop', type: 'keyword', detail: 'export function onStop()', info: 'Called when the run ends (orders are ignored).', apply: 'export function onStop() {\n  \n}' },
  { label: 'meta', type: 'variable', detail: 'export const meta = { name, timeframe, timeframes }', info: "Strategy name, primary timeframe ('5m', '1h', '500t', '1000v', '8r') and extra timeframes.", apply: "export const meta = { name: 'My strategy', timeframe: '5m' };" },
  { label: 'params', type: 'variable', detail: 'export const params = { … }', info: 'Settings shown as a form; read them as values: params.fast.' },
  { label: 'param.int', type: 'function', detail: '(label, default, { min, max, step })', info: 'Integer setting.' },
  { label: 'param.float', type: 'function', detail: '(label, default, { min, max, step })', info: 'Decimal setting.' },
  { label: 'param.bool', type: 'function', detail: '(label, default)', info: 'On / off setting.' },
  { label: 'param.choice', type: 'function', detail: '(label, default, options[])', info: 'One of a list of strings.' },
  { label: 'buy', type: 'function', detail: '(qty, { stop?, target?, trail?, label? }) → id', info: 'Market buy. stop / target / trail are distances in ticks (bracket).' },
  { label: 'sell', type: 'function', detail: '(qty, { stop?, target?, trail?, label? }) → id', info: 'Market sell.' },
  { label: 'limit', type: 'function', detail: "('buy' | 'sell', qty, price, opts?) → id", info: 'Limit order at a price.' },
  { label: 'stop', type: 'function', detail: "('buy' | 'sell', qty, price, opts?) → id", info: 'Stop (market when touched) order.' },
  { label: 'bracket', type: 'function', detail: "('buy' | 'sell', qty, { entry?, stop, target, trail?, label? }) → id", info: 'Entry (market, or limit at `entry`) with stop and targets in ticks.' },
  { label: 'close', type: 'function', detail: '(label?)', info: 'Flattens the position and cancels working orders.' },
  { label: 'cancel', type: 'function', detail: '(id)', info: 'Cancels a working order by the id buy / sell / limit returned.' },
  { label: 'cancelAll', type: 'function', detail: '()', info: 'Cancels every working order of the strategy.' },
  { label: 'position', type: 'function', detail: '() → { qty, side, avgPrice, openPnl }', info: 'Current position (updated after your orders are processed).' },
  { label: 'account', type: 'function', detail: '() → { balance, equity, dayPnl, currency }', info: 'Account the run trades in.' },
  { label: 'orders', type: 'function', detail: '() → Order[]', info: 'Working orders of the strategy.' },
  { label: 'bars', type: 'function', detail: '(tf?, count?) → Bar[]', info: 'Closed bars (oldest first): { time, open, high, low, close, volume, buyVolume, sellVolume, delta, trades, index }.' },
  { label: 'closes', type: 'function', detail: '(tf?, count?) → number[]', info: 'Close prices of closed bars.' },
  { label: 'footprint', type: 'function', detail: '(barsAgo?, tf?) → { price, bid, ask, volume, delta }[]', info: 'Footprint (volume at price) of a bar.' },
  { label: 'delta', type: 'function', detail: '(barsAgo?, tf?) → number', info: 'Ask volume − bid volume of a bar.' },
  { label: 'cvd', type: 'function', detail: '(tf?) → number', info: 'Cumulative delta of the visible bars.' },
  { label: 'poc', type: 'function', detail: '(barsAgo?, tf?) → price', info: 'Point of control of a bar.' },
  { label: 'imbalances', type: 'function', detail: '(barsAgo?, { ratio?, minVolume? }, tf?)', info: 'Diagonal imbalances: { price, side, ratio }[].' },
  { label: 'stackedImbalances', type: 'function', detail: '(barsAgo?, { ratio? }, tf?)', info: 'Longest run of same-side imbalances: { count, side, from, to }.' },
  { label: 'book', type: 'function', detail: '() → { bids, asks } | null', info: 'Top 10 levels of the order book: { price, size }[].' },
  { label: 'indicator', type: 'function', detail: "(id, inputs?, { tf? }) → { value(output?, barsAgo?), values(output?, count?) }", info: "Any indicator of the registry, e.g. indicator('vwap').value('vwap')." },
  { label: 'ta.sma', type: 'function', detail: '(values, length) → number', info: 'Simple moving average of the last `length` values.' },
  { label: 'ta.ema', type: 'function', detail: '(values, length) → number', info: 'Exponential moving average.' },
  { label: 'ta.rsi', type: 'function', detail: '(values, length) → number', info: "Wilder's RSI." },
  { label: 'ta.atr', type: 'function', detail: '(bars, length) → number', info: 'Average true range.' },
  { label: 'ta.vwap', type: 'function', detail: '(bars) → number', info: 'Volume-weighted average price of the given bars.' },
  { label: 'ta.highest', type: 'function', detail: '(values, length) → number', info: 'Highest of the last `length` values.' },
  { label: 'ta.lowest', type: 'function', detail: '(values, length) → number', info: 'Lowest of the last `length` values.' },
  { label: 'ta.stdev', type: 'function', detail: '(values, length) → number', info: 'Population standard deviation.' },
  { label: 'ta.crossOver', type: 'function', detail: '(a[], b[]) → boolean', info: 'a crossed above b on the last element.' },
  { label: 'ta.crossUnder', type: 'function', detail: '(a[], b[]) → boolean', info: 'a crossed below b on the last element.' },
  { label: 'log', type: 'function', detail: '(...values)', info: 'Writes to the run log.' },
  { label: 'warn', type: 'function', detail: '(...values)', info: 'Writes a warning to the run log.' },
  { label: 'plot', type: 'function', detail: "(name, value, { color?, overlay? })", info: 'Plots a value at the current bar (overlay: false = own pane).' },
  { label: 'time', type: 'function', detail: '() → ms', info: 'Strategy clock (epoch ms).' },
  { label: 'last', type: 'function', detail: '() → price', info: 'Last traded price.' },
  { label: 'canTrade', type: 'function', detail: '() → boolean', info: 'False during warm-up or after a stop.' },
  { label: 'instrument', type: 'variable', detail: '{ symbol, tickSize, tickValue, pricePrecision }', info: 'Traded instrument.' },
];
