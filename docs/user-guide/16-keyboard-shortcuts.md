---
id: keyboard-shortcuts
title: Keyboard shortcuts
section: Reference
keywords: hotkeys keys bindings shortcuts rebind scope command registry
---

Every action in HT Flow is a **command** in the Command Palette (`Ctrl+K`). A command can also have a keyboard shortcut. The table below lists the default shortcuts, generated from the command registry (`pnpm guide:screenshots` refreshes it); inside the app the table is live and shows **your** current bindings.

**Rebind** any command in Settings → Hot keys: pick it, press the new keys, resolve flagged conflicts, optionally restrict the **scope** (Global, Chart, Trading panel, Replay) and export / import presets. A shortcut with a scope only fires when your last click or focus was inside that kind of window.

| Also useful |                               |
| ----------- | ----------------------------- |
| `F1`        | Open this guide               |
| `Shift+F1`  | Help for the active window    |
| `Ctrl+K`    | Command palette               |
| `Esc`       | Close the palette or a dialog |

<!-- shortcuts:begin -->

#### Trading

| Keys       | Command                | Active in |
| ---------- | ---------------------- | --------- |
| `C`        | Smart DOM: re-centre   | trading   |
| `PageUp`   | Smart DOM: scroll up   | trading   |
| `PageDown` | Smart DOM: scroll down | trading   |
| `T`        | Toggle Trading Panel   | global    |
| `H`        | Breakeven              | global    |

#### Chart

| Keys      | Command                                 | Active in |
| --------- | --------------------------------------- | --------- |
| `Ctrl+S`  | Chart settings…                         | chart     |
| `Ctrl+G`  | Chart: Go to date…                      | chart     |
| `Ctrl+R`  | Chart: Reset (go to latest, auto-scale) | chart     |
| `Ctrl+D`  | Chart: Data window                      | chart     |
| `Alt+I`   | Chart scale: Invert                     | chart     |
| `Shift+C` | Chart mode: Candles                     | chart     |
| `Shift+B` | Chart mode: Bars                        | chart     |
| `Shift+T` | Chart mode: Transparent candles         | chart     |
| `Shift+L` | Chart mode: Line chart                  | chart     |
| `Shift+M` | Chart mode: Area                        | chart     |
| `Shift+H` | Chart mode: Hidden                      | chart     |
| `Ctrl+I`  | Indicators…                             | global    |
| `Alt+V`   | Footprint: Volume                       | global    |
| `Alt+T`   | Footprint: Trades                       | global    |
| `Alt+B`   | Footprint: Bid x Ask                    | global    |
| `Alt+D`   | Footprint: Delta                        | global    |

#### Platform

| Keys       | Command                           | Active in |
| ---------- | --------------------------------- | --------- |
| `Ctrl+,`   | Settings                          | global    |
| `F1`       | Help: User Guide                  | global    |
| `Shift+F1` | Help: guide for the active window | global    |
| `Ctrl+K`   | Command palette                   | global    |
| `Ctrl+L`   | Lock HT Flow                      | global    |

#### Layout

| Keys           | Command                 | Active in |
| -------------- | ----------------------- | --------- |
| `Ctrl+Shift+S` | Workspace: Save current | global    |

#### Drawing

| Keys           | Command                          | Active in |
| -------------- | -------------------------------- | --------- |
| `F2`           | Draw: Trend Line                 | global    |
| `F7`           | Draw: Vertical Line              | global    |
| `F6`           | Draw: Horizontal Line            | global    |
| `F12`          | Draw: Rectangle                  | global    |
| `F11`          | Draw: Triangle                   | global    |
| `F3`           | Draw: Volume Profile & TPO       | global    |
| `Ctrl+F3`      | Draw: Fixed Volume Profile & TPO | global    |
| `F4`           | Draw: Anchored VWAP              | global    |
| `F8`           | Draw: Fibonacci Retracements     | global    |
| `Ctrl+Shift+W` | Draw: Up Arrow                   | global    |
| `Ctrl+Shift+S` | Draw: Down Arrow                 | global    |
| `Ctrl+Shift+N` | Draw: Dot                        | global    |
| `Ctrl+Shift+Q` | Draw: Diamond                    | global    |
| `Ctrl+Shift+E` | Draw: Square                     | global    |
| `M`            | Drawing: Magnifier               | chart     |
| `Ctrl+Shift+T` | Draw: Text                       | global    |
| `Ctrl+Shift+L` | Draw: Label / Callout            | global    |
| `Ctrl+Shift+D` | Draw: Right Price Label          | global    |
| `Ctrl+Shift+A` | Draw: Left Price Label           | global    |
| `F9`           | Draw: Ruler                      | global    |
| `Ctrl+A`       | Drawing: Select all drawings     | chart     |
| `Del`          | Drawing: Delete selected         | chart     |
| `Ctrl+Z`       | Drawing: Undo                    | chart     |
| `Ctrl+Y`       | Drawing: Redo                    | chart     |

<!-- shortcuts:end -->

> **Note** Two defaults currently share a key (`Ctrl+Shift+S` is both _Workspace: Save current_ and _Draw: Down Arrow_). The Hot keys editor flags this; rebind one of them.
