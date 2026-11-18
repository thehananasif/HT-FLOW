---
id: troubleshooting
title: Troubleshooting and FAQ
section: Reference
keywords: faq problem error binance 451 forgot password pin blank chart no data slow performance smartscreen update
opens: logs, connections
---

## Accounts

**I forgot my password.** Login → _Forgot password?_ → username, the 24-word recovery code and a new password. Without the code the data cannot be recovered.

**The PIN stopped working.** After five wrong PINs it is removed. Log in with your password and set a new PIN (account menu → Change PIN…).

**Windows says "Windows protected your PC".** The installer is not code-signed yet: **More info → Run anyway**.

## Data and connections

**A venue pill is red or Binance shows an error.** Open **Connections** and check the status text. Check your internet connection and firewall. Some venues block regions (HTTP 451).

**A connection says "Desktop app only".** Exchange APIs cannot be called from a browser. Use the Windows app.

**The chart is empty or says no data.** Make sure the instrument has a feed (picker status column), wait a moment for history to load, or press `Ctrl+R`. `Chart: Reload all historical data` forces a reload. Instruments marked _No feed_ have no connector yet.

**Older bars look smooth or have no footprint detail.** Venues only serve candles for older days, so buy / sell volumes of those bars are estimated (exact on Binance). Let the recorder store live data for exact history.

**Data looks late.** Amber / red status pills mean latency above the thresholds in Settings → Data delays. Check your network and _Depth conflation_ in Settings → Data.

## Performance

**The app is slow or the fan runs.** Open Settings → Performance: lower the FPS cap, turn on _Disable hidden windows rendering_, reduce **Default load days** and _Maximum candles per chart_, close unused heatmap windows, or switch off 3D heatmap. The footprint collapses to candles when zoomed far out.

**Heatmap is blank.** It needs order-book depth; connect a venue with depth or use the simulator. Depth history accumulates from the moment the window opens.

## Trading

**Orders are rejected or nothing happens.** Check the lock icon (DOM / chart lock), Risk (a locked account shows _Locked_ in the title bar), the selected paper account, and _Order confirmations_. The Trading Activity window states the reason for each rejection.

**A key does nothing.** Hot keys with a scope only work when the last click was in that kind of window. Check for a conflict in Settings → Hot keys.

## Still stuck?

- Open **Logs** and copy or export the lines around the problem.
- Help menu → **Report a problem…**.
- Update with the Help menu → _Check for updates_.
