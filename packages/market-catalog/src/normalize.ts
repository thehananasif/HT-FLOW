const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "BTC-USDT-SWAP" / "PF_XBTUSD" / "BTCUSDT" → "BTCUSDT" / "XBTUSD" (venue decorations removed). */
export function normalizeCryptoSymbol(s: string): string {
  return compact(s.replace(/^PF_/, '').replace(/[-_](SWAP|PERP|PERPETUAL)$/i, '')).replace(
    /PERP(ETUAL)?$/,
    '',
  );
}
