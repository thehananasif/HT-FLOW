---
id: scanners
title: اسکینرز اور واچ لسٹس
section: تجزیہ
keywords: watchlist market pressure price change dom pressure delta divergence scanner options board forward curve واچ لسٹ اسکینر آپشنز
opens: watchlist, market-pressure, price-change, dom-pressure, delta-divergence, options-board, forward-curve
---

## واچ لسٹس

![Watchlist](images/watchlist.webp)

- **ٹیبز** آپ کی فہرستیں رکھتے ہیں؛ سمبلز انسٹرومنٹ پکر سے شامل کریں۔
- کالمز: Last (تبدیلی پر جھپکتا ہے)، Chg %، Volume، Delta، sparkline، اور کرپٹو perps کے لیے **OI / Funding** (جب ایکسچینج شائع نہ کرے تو "—" دکھاتا ہے)۔ کالم چنیں، ترتیب دیں اور گھسیٹ کر ترتیب بدلیں۔
- قطار پر رائٹ کلک کر کے اس کے لیے **Chart، DOM، Heatmap یا Tape** کھولیں؛ لنک گروپ کا رنگ طے کرتا ہے کہ قطار منتخب کرنے پر کون سی ونڈوز پیروی کریں۔
- Live فیڈز صرف ان قطاروں کی رکھی جاتی ہیں جو آپ کو نظر آ رہی ہوں۔

## مارکیٹ اسکینرز

چار مختصر ڈیش بورڈ بیک وقت کئی انسٹرومنٹس (200 تک، ہر سیکنڈ ریفریش) پر نظر رکھتے ہیں۔ ہر ایک کے سیٹنگز مینو میں حدیں ہیں، toast اور beep دکھا سکتا ہے، اور قطار پر کلک فعال چارٹ طے کرتا ہے۔

| ونڈو                 | کیا رینک کرتی ہے                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------- |
| **Market Pressure**  | 1 m، 5 m، 15 m اور سیشن میں والیوم کا Buy %                                              |
| **Price Change**     | % ، ticks یا ڈالر میں تبدیلی، دن کی رینج میں پوزیشن، VWAP سے فاصلہ، sparkline            |
| **DOM Pressure**     | ±5، ±10 اور ±25 ticks کے اندر bid / ask imbalance، pull flashes کے ساتھ                  |
| **Delta Divergence** | M1 سے H1 پر قیمت کے highs / lows جو مجموعی delta سے اختلاف کریں، اختیاری absorption     |

![Market Pressure](images/market-pressure.webp)

![Price Change](images/price-change.webp)

![DOM Pressure](images/dom-pressure.webp)

![Delta Divergence](images/delta-divergence.webp)

> **نوٹ** اسکینر ونڈوز صرف وہ انسٹرومنٹس دیکھتی ہیں جن کی فیڈ ہو (سمیولیٹڈ یا کنیکٹڈ)۔ سیشن 00:00 UTC پر شروع ہوتا ہے، اور یہ ابھی Alerts ماڈیول سے منسلک نہیں۔

## Options Board اور forward curve

![Options Board](images/options-board.webp)

**Options Board** چینز کو series فلٹرز اور expiry بلاکس (calls، IV کے ساتھ strike، puts، in-the-money رنگت، spot لائن) کے ساتھ دکھاتا ہے۔ بیچنے کے لیے bid پر یا خریدنے کے لیے ask پر کلک کریں۔ **Strategy builder** میں 13 ٹیمپلیٹس، expiry اور T+n پر سلائیڈر کے ساتھ payoff چارٹ، breakevens، زیادہ سے زیادہ منافع اور نقصان، منافع کا امکان اور کل Greeks ہیں۔ **Send as paper order** ہر leg کو پیپر انجن میں بُک کرتا ہے؛ پھر آپشنز Positions میں ماڈل mark، P&L اور باقی دنوں کے ساتھ نظر آتے ہیں اور expiry پر intrinsic value پر settle ہوتے ہیں۔ سمیولیٹڈ انسٹرومنٹس کی چینز بنائی جاتی ہیں؛ Deribit کے آپشنز اس کے پبلک ڈیٹا سے آتے ہیں۔

![Forward Curve](images/forward-curve.webp)

**Forward curve** ونڈو CL، NG، GC، ES اور BTC کا term structure دکھاتی ہے، آج کا موازنہ 1 / 7 / 30 دن پہلے سے کرتی ہے، contango یا backwardation کا لیبل لگاتی ہے، اور calendar spreads، basis اور اگلا roll درج کرتی ہے۔ جب تک فیوچرز فیڈ نہ جڑے، قیمتیں سمیولیٹڈ ہیں (بیج **Sim**)۔
