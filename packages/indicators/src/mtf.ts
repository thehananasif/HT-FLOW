import { asAny, defineMtf, type AnyIndicator } from '@htflow/indicator-sdk';
import { ATR, Bollinger, Donchian } from './bands';
import { EMA, SMA, VWMA } from './ma';
import { VWAP } from './orderflow';
import { CCI, MACD, RSI, Stochastic } from './oscillators';
import { ADX, Ichimoku, SuperTrend } from './trend';

const m = (base: AnyIndicator, id: string, name: string, short: string): AnyIndicator =>
  defineMtf(base, { id: `mtf-${id}`, name: `MTF ${name}`, short: `MTF ${short}` });

/** The 14 multi-timeframe variants of Appendix B: the base indicator on a higher timeframe. */
export const MTF_SMA = m(asAny(SMA), 'sma', 'SMA', 'SMA');
export const MTF_EMA = m(asAny(EMA), 'ema', 'EMA', 'EMA');
export const MTF_RSI = m(asAny(RSI), 'rsi', 'RSI', 'RSI');
export const MTF_MACD = m(asAny(MACD), 'macd', 'MACD', 'MACD');
export const MTF_BOLLINGER = m(asAny(Bollinger), 'bollinger', 'Bollinger Bands', 'BB');
export const MTF_STOCHASTIC = m(asAny(Stochastic), 'stochastic', 'Stochastic', 'Stoch');
export const MTF_ATR = m(asAny(ATR), 'atr', 'ATR', 'ATR');
export const MTF_SUPERTREND = m(asAny(SuperTrend), 'supertrend', 'SuperTrend', 'ST');
export const MTF_ICHIMOKU = m(asAny(Ichimoku), 'ichimoku', 'Ichimoku Cloud', 'Ichimoku');
export const MTF_CCI = m(asAny(CCI), 'cci', 'CCI', 'CCI');
export const MTF_ADX = m(asAny(ADX), 'adx', 'ADX', 'ADX');
export const MTF_VWMA = m(asAny(VWMA), 'vwma', 'VWMA', 'VWMA');
export const MTF_DONCHIAN = m(asAny(Donchian), 'donchian', 'Donchian Channels', 'Donchian');
export const MTF_VWAP = m(asAny(VWAP), 'vwap', 'VWAP', 'VWAP');
