# HT Flow — User guide (0.1.0)

## Install (Windows 10 / 11, x64)

1. Download `HT Flow_0.1.0_x64-setup.exe` from the latest CI run (Actions → **Build Windows x64** → artifact `HTFlow-windows-x64`) or a GitHub Release.
2. Run it. It installs for your user only — no administrator rights needed.
3. The installer is not code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info → Run anyway**.

Portable mode: put an empty file named `portable` next to `htflow-desktop.exe`; your data then lives in a `data` folder beside the executable instead of `%APPDATA%\HTFlow`.

## First run

1. **Create account** — display name, username, password (at least 10 characters), timezone, theme, optional 6-digit PIN.
2. **Save the 24-word recovery code.** HT Flow has no server: this code is the only way to reset a forgotten password. Copy or print it.
3. The dashboard opens with **DOM | Chart | Panel**: a DOM ladder, a footprint chart and the Trading Panel, on the built-in simulator (badge **Sim**).

Everything — account, settings, layouts, credentials — is encrypted and stored only on this PC. **Export profile** (account menu, top-right) writes an encrypted `.htprofile` you can import on another PC.

## Market data

- **Simulated (MockFeed):** BTCUSDT, CLZ6, GCZ6, ESZ6, NQZ6 — realistic order flow generated on your PC, works offline.
- **Binance Futures (live, free):** pick BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT or DOGEUSDT under _Binance Futures_ in the instrument picker. No API key needed. History starts with the last 30 minutes of trades.
- Futures/stock feeds that need your own account (Rithmic, CQG, dxFeed, IB, Tradovate, Alpaca) are listed in **Connections** and are coming in later versions.

## Layouts

Title bar → **Layout**: DOM | Chart | Panel, Grid 2×2, 1 + 2, Split, Single. Drag a window header to dock it anywhere; drag splitters to resize; **Split right / Split down** duplicates the active window; **Detach window** floats it. Layout tabs at the bottom keep several layouts — **+** adds one, double-click renames. Everything autosaves.

Link groups: click the coloured dot in a window header and pick a colour. Changing the instrument in one window changes every window with the same colour.

## Charts

Header: instrument, timeframe chips (M1 / M5 / H1, **TF** for all presets), lots, template menu (Candlesticks + Volume Profile, Footprint, Liquidity Map, Order Flow (Dark)).

| Action           | Mouse / key                                                                |
| ---------------- | -------------------------------------------------------------------------- |
| Zoom time        | Wheel                                                                      |
| Zoom price       | Ctrl + wheel, or drag the price axis                                       |
| Pan              | Drag; Shift + drag moves vertically                                        |
| Auto-scale price | Double-click the price axis                                                |
| Go to latest     | Double-click the time axis, or ◂▸ in the bottom bar                        |
| Right-click menu | Buy/Sell limit or stop at the cursor price, Mode, Mouse, Reset, Export PNG |

Side tools (left edge): ⚙ footprint quick settings; **Volume › Trades › Bid x Ask › Delta ›** choose one of 21 footprint modes (also Alt+V / Alt+T / Alt+B / Alt+D). Drawing tools are listed but arrive in a later version.

Liquidity Map: column size 250 ms / 1 s / 5 s in the header; **Lots ≥** box filters trade bubbles.

## Trading (paper)

Account **Paper · ••••3505** starts with $50,000.

- **Trading Panel** (T): market, join ask/bid, cancel, reverse, breakeven (H), close; OCO, TIF, reduce-only; **SL/TP** switch attaches a stop and target in ticks.
- **DOM**: left-click Bid/Ask column = buy limit at that price, right-click = sell limit, hold Ctrl for stops. Click your order in _Orders / PnL_ to cancel. Footer: reverse, cancel, market buy/sell, **Flatten all**, lock.
- Tables: ribbon → Accounts, Positions, Orders, Trades.

## Shortcuts

Ctrl+K command palette · T Trading Panel · H breakeven · Ctrl+L lock · Alt+V / T / B / D footprint modes.

## Troubleshooting

- **Binance shows an error / red pill:** check your internet connection. Binance blocks some regions (HTTP 451).
- **Forgot password:** Login → _Forgot password?_ → enter the 24-word recovery code and a new password.
- **PIN stopped working:** after 5 wrong PINs the PIN is removed; log in with your password and set a new one (account menu → Change PIN).
