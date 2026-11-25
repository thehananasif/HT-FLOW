---
id: keyboard-shortcuts
title: کی بورڈ شارٹ کٹس
section: حوالہ
keywords: hotkeys keys bindings shortcuts rebind scope command registry شارٹ کٹ ہاٹ کیز کی بورڈ
---

HT Flow کا ہر عمل Command Palette (`Ctrl+K`) میں ایک **کمانڈ** ہے۔ کمانڈ کے ساتھ کی بورڈ شارٹ کٹ بھی ہو سکتا ہے۔ نیچے کا جدول ڈیفالٹ شارٹ کٹس دیتا ہے، جو command registry سے بنایا جاتا ہے (`pnpm guide:screenshots` اسے تازہ کرتا ہے)؛ ایپ کے اندر جدول live ہوتا ہے اور **آپ کی** موجودہ بائنڈنگز دکھاتا ہے۔

Settings ← ہاٹ کیز میں کسی بھی کمانڈ کو **دوبارہ بائنڈ** کریں: اسے چنیں، نئی کیز دبائیں، نشان زد تصادم حل کریں، چاہیں تو **scope** محدود کریں (Global، Chart، Trading panel، Replay) اور پری سیٹس ایکسپورٹ / درآمد کریں۔ scope والا شارٹ کٹ صرف تب چلتا ہے جب آپ کا آخری کلک یا فوکس اس قسم کی ونڈو کے اندر ہو۔

| مزید مفید  |                           |
| ---------- | ------------------------- |
| `F1`       | یہ گائیڈ کھولیں           |
| `Shift+F1` | فعال ونڈو کی مدد          |
| `Ctrl+K`   | Command palette           |
| `Esc`      | پیلیٹ یا ڈائیلاگ بند کریں |

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
| `Ctrl+Shift+Z` | Draw: Down Arrow                 | global    |
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
