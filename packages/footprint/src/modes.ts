export type FootprintContent = 'volume' | 'trades' | 'bidask' | 'delta' | 'voltrade' | 'voldelta';
export type FootprintStyle =
  | 'plain'
  | 'deltaColored'
  | 'histogram'
  | 'digital'
  | 'deltaHistogram'
  | 'ladder'
  | 'profile'
  | 'deltaProfile';

export interface FootprintModeDef {
  id: string;
  label: string;
  group: 'Volume' | 'Trades' | 'Bid x Ask' | 'Delta';
  content: FootprintContent;
  style: FootprintStyle;
  shortcut?: string;
}

/** Side-tools footprint modes (P45) — every renderer reads the same Bar.clusters. */
export const FOOTPRINT_MODES: FootprintModeDef[] = [
  {
    id: 'volume',
    label: 'Volume',
    group: 'Volume',
    content: 'volume',
    style: 'plain',
    shortcut: 'Alt+V',
  },
  {
    id: 'volume-delta-colored',
    label: 'Delta Colored Volume',
    group: 'Volume',
    content: 'volume',
    style: 'deltaColored',
  },
  {
    id: 'volume-histogram',
    label: 'Volume Histogram',
    group: 'Volume',
    content: 'volume',
    style: 'histogram',
  },
  {
    id: 'volume-digital',
    label: 'Volume Digital Histogram',
    group: 'Volume',
    content: 'volume',
    style: 'digital',
  },
  {
    id: 'volume-delta-histogram',
    label: 'Delta Colored Volume Histogram',
    group: 'Volume',
    content: 'volume',
    style: 'deltaHistogram',
  },
  {
    id: 'volume-x-trade',
    label: 'Volume x Trade',
    group: 'Volume',
    content: 'voltrade',
    style: 'plain',
  },
  {
    id: 'trades',
    label: 'Trades',
    group: 'Trades',
    content: 'trades',
    style: 'plain',
    shortcut: 'Alt+T',
  },
  {
    id: 'trades-delta-colored',
    label: 'Delta Colored Trades',
    group: 'Trades',
    content: 'trades',
    style: 'deltaColored',
  },
  {
    id: 'trades-histogram',
    label: 'Trades Histogram',
    group: 'Trades',
    content: 'trades',
    style: 'histogram',
  },
  {
    id: 'trades-digital',
    label: 'Trades Digital Histogram',
    group: 'Trades',
    content: 'trades',
    style: 'digital',
  },
  {
    id: 'trades-delta-histogram',
    label: 'Delta Colored Trades Histogram',
    group: 'Trades',
    content: 'trades',
    style: 'deltaHistogram',
  },
  {
    id: 'bidask',
    label: 'Bid x Ask',
    group: 'Bid x Ask',
    content: 'bidask',
    style: 'plain',
    shortcut: 'Alt+B',
  },
  {
    id: 'bidask-delta-colored',
    label: 'Bid x Ask Delta Colored',
    group: 'Bid x Ask',
    content: 'bidask',
    style: 'deltaColored',
  },
  {
    id: 'bidask-ladder',
    label: 'Bid x Ask Ladder',
    group: 'Bid x Ask',
    content: 'bidask',
    style: 'ladder',
  },
  {
    id: 'bidask-histogram',
    label: 'Bid x Ask Histogram',
    group: 'Bid x Ask',
    content: 'bidask',
    style: 'histogram',
  },
  {
    id: 'bidask-digital',
    label: 'Bid x Ask Digital Histogram',
    group: 'Bid x Ask',
    content: 'bidask',
    style: 'digital',
  },
  {
    id: 'bidask-profile',
    label: 'Bid x Ask Volume Profile',
    group: 'Bid x Ask',
    content: 'bidask',
    style: 'profile',
  },
  {
    id: 'bidask-delta-profile',
    label: 'Bid x Ask Delta Profile',
    group: 'Bid x Ask',
    content: 'bidask',
    style: 'deltaProfile',
  },
  {
    id: 'delta',
    label: 'Delta',
    group: 'Delta',
    content: 'delta',
    style: 'deltaColored',
    shortcut: 'Alt+D',
  },
  {
    id: 'volume-x-delta',
    label: 'Volume x Delta',
    group: 'Delta',
    content: 'voldelta',
    style: 'deltaColored',
  },
  {
    id: 'delta-profile',
    label: 'Delta Profile',
    group: 'Delta',
    content: 'delta',
    style: 'deltaProfile',
  },
];

export const FOOTPRINT_GROUPS = ['Volume', 'Trades', 'Bid x Ask', 'Delta'] as const;

export function footprintMode(id: string): FootprintModeDef {
  return FOOTPRINT_MODES.find((m) => m.id === id) ?? FOOTPRINT_MODES[0]!;
}
