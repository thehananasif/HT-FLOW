---
id: charts
title: چارٹس
section: تجزیہ
keywords: chart types candles bars line area timeframe drawing tools indicators templates linked windows crosshair scale چارٹ کینڈل انڈیکیٹر ڈرائنگ ٹیمپلیٹ کراس ہیئر
opens: chart, drawing-objects
---

## چارٹ کھولنا اور اس میں گھومنا

چارٹ ربن سے کھولیں (**Chart ▾** ٹیمپلیٹس دکھاتا ہے)، `Ctrl+K` ← `New chart: …` سے، یا موجودہ ونڈو کو تقسیم کر کے۔ ہیڈر میں لنک ڈاٹ، انسٹرومنٹ، ٹائم فریم chips، lots، ٹیمپلیٹ مینو، **Indicators**، اسٹریٹجی کنٹرولز، فیڈ بیج (Live / Sim / Replay)، اسنیپ شاٹ کیمرہ (PNG کاپی کرتا ہے)، بڑا کریں، سیٹنگز اور بند کریں ہیں۔

| عمل                | ماؤس / کی                                                         |
| ------------------ | ----------------------------------------------------------------- |
| وقت زوم کرنا       | وہیل                                                              |
| قیمت زوم کرنا      | `Ctrl` + وہیل، یا قیمت کے محور کو گھسیٹیں                         |
| اسکرول             | `Shift` + وہیل، یا گھسیٹیں                                        |
| عمودی حرکت         | `Shift` + گھسیٹیں                                                 |
| قیمت آٹو اسکیل     | قیمت کے محور پر ڈبل کلک                                           |
| تازہ ترین پر جانا  | وقت کے محور پر ڈبل کلک، یا `Ctrl+R` (اسکیل بھی ری سیٹ ہوتا ہے)    |
| فل اسکرین          | چارٹ پر `Ctrl` + ڈبل کلک                                          |
| رائٹ کلک           | چارٹ مینو (آرڈرز، الرٹس، موڈ، اسکیل، ٹیمپلیٹس، ایکسپورٹ، سیٹنگز)  |

ماؤس موڈز (رائٹ کلک ← Mouse): **Pointer, Crosshair, Zoom** (ڈبہ کھینچیں)، **Scroll, ZoomXY**۔ Crosshair sync بند ہو سکتا ہے، لنک گروپ کے لحاظ سے ہو سکتا ہے، یا تمام ونڈوز میں عالمی۔

![چارٹ کا کانٹیکسٹ مینو](images/chart-context-menu.webp)

## چارٹ کی اقسام

ہیڈر کا ٹیمپلیٹ مینو (یا `New chart: …` کمانڈز) استعمال کریں۔ تمام اقسام ایک ہی ڈیٹا پڑھتی ہیں، اس لیے بدلنے پر آپ کا زوم برقرار رہتا ہے۔

| ٹیمپلیٹ                             | آپ کیا دیکھتے ہیں                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| **Candlesticks + Volume Profile**   | ہر مدت کے volume profile کے ساتھ کینڈلز، vPOC، value area high اور low           |
| **Footprint chart**                 | ہر بار کے اندر ہر قیمت پر Bid x Ask والیوم                                        |
| **Liquidity Map**                   | وقت کے ساتھ آرڈر بک میں رکی ہوئی depth اور ٹریڈ bubbles                           |
| **Order Flow (Dark / Light)**       | بائیں طرف کینڈلز اور heat قطاریں، دائیں طرف bubbles والا ٹیپ چارٹ                 |
| **Imbalance Chart**                 | diagonal اور stacked imbalances کے لیے ٹیون کیا گیا Footprint                     |
| **TPO Chart**                       | مارکیٹ پروفائل کے حروف یا بلاکس، value area، POC، initial balance، single prints  |
| **On-Chart Liquidity Map**          | کینڈلز کے پیچھے heat ساخت                                                         |
| **Multi-timeframe Chart**           | کئی ٹائم فریمز باکسز کی صورت میں، پہلو بہ پہلو یا اوپر نیچے                        |
| **Volume Histogram, Delta Profile** | ہر بار کے والیوم یا delta at price کے ہسٹوگرام                                    |
| **COT Chart**                       | Commitments of Traders (شامل ڈیٹا، نشان زد)                                       |

![والیوم پروفائل کے ساتھ کینڈلز](images/chart-candles.webp)

![Footprint چارٹ](images/chart-footprint.webp)

![Liquidity map](images/chart-liquidity.webp)

![Order Flow (Dark)](images/chart-orderflow.webp)

![TPO چارٹ](images/chart-tpo.webp)

![Multi-timeframe چارٹ](images/chart-mtf.webp)

رائٹ کلک ← **Mode** (یا `Shift+C / B / T / L / M / H`) Candles، Bars، Transparent candles، Line، Area اور Hidden کے درمیان بدلتا ہے۔ قیمت کا اسکیل linear، logarithmic، percent، 100 پر indexed یا الٹا ہو سکتا ہے۔ بار کی قسم (Renko، Range، Heikin-Ashi، Point & Figure، Kagi …) ٹائم فریم ڈائیلاگ میں چنی جاتی ہے؛ دیکھیں [ڈیٹا کو جوڑنا](03-connecting-data.md#timeframes-and-bar-types)۔

### ٹیمپلیٹس اور اسنیپ شاٹس

![ٹیمپلیٹ مینو](images/template-menu.webp)

- **Built-in ٹیمپلیٹس** مینو میں آتے ہیں؛ اسٹائل پری سیٹس (White, Light, Dark, Black, Dark footprint, Footprint statistic, Imbalance, MarketResearch, MultiTimeFrame) چارٹ کو نیا روپ دیتے ہیں۔
- **Save as template…** آپ کا اپنا `.httemplate` محفوظ کرتا ہے (انڈیکیٹرز، ڈرائنگز کی سیٹنگز، اسٹائل)۔ ٹیمپلیٹس کا نام بدلا، ڈپلیکیٹ، اوور رائٹ، ایکسپورٹ، درآمد، پسندیدہ کیا اور انسٹرومنٹ کلاس کا ڈیفالٹ بنایا جا سکتا ہے۔
- **Take snapshot** چارٹ کی حالت محفوظ کرتا ہے (اسی مینو میں Snapshots کے نیچے درج) تاکہ آپ واپس آ سکیں۔

## انڈیکیٹرز

![Indicators ڈائیلاگ](images/indicators-dialog.webp)

`Ctrl+I` دبائیں یا ہیڈر میں **Indicators** پر کلک کریں۔ 281 انڈیکیٹرز زمروں میں درج ہیں (Volume & OrderFlow، Order Book، Technical، Crypto Metrics …؛ دیکھیں `docs/INDICATORS.md`)۔ تلاش کریں، پسندیدہ پر ستارہ لگائیں، شامل کرنے کے لیے **+** دبائیں، پھر ہر ایک کو اس کے ٹیبز **Inputs / Style / Visibility / Advanced** میں live پری ویو کے ساتھ ٹیون کریں (Cancel واپس پلٹا دیتا ہے)۔ چارٹ پر فہرست سے آپ انہیں چھپا، ترتیب بدل، ڈپلیکیٹ اور ہٹا سکتے ہیں۔

- انڈیکیٹرز قیمت کے پین میں، اپنے sub-pane میں، یا کسی پین میں مل کر رہ سکتے ہیں۔ legend کا ٹائٹل گھسیٹ کر منتقل کریں۔ Sub-panes کا سائز بدلا یا انہیں بڑا کیا جا سکتا ہے۔
- چارٹ پر **legend** کرسر پر قدریں دکھاتی ہے، ساتھ آنکھ، سیٹنگز اور ہٹانے کے بٹن۔
- **Advanced ← timeframe override** انڈیکیٹر کو بلند ٹائم فریم پر کیلکولیٹ کرتا ہے؛ انڈیکیٹر ڈیٹا کے ماخذ کے طور پر کوئی دوسرا سمبل بھی استعمال کر سکتا ہے۔
- **Alerts ٹیب**: جب کوئی آؤٹ پٹ کسی لیول یا دوسرے آؤٹ پٹ کو کراس کرے تو toast، آواز یا activity-log اندراج۔
- **Script Editor** (کمانڈ `Indicators: Script Editor`) HT Script میں آپ کے اپنے انڈیکیٹرز لکھنے دیتا ہے، جو ایک چھوٹی sandboxed زبان ہے؛ ساتھ ذاتی لائبریری اور `.htind` ایکسپورٹ / درآمد۔

![چارٹ پر ایک انڈیکیٹر](images/indicator-on-chart.webp)

## ڈرائنگ ٹولز

بائیں کنارے کے سائیڈ ٹولز میں 67 ڈرائنگ ٹولز گروپس میں ہیں: Lines، Shapes، Volume Analysis، Fibonacci، Measurement، Elliott، Markers، Text، Positions، Gann & Pitchfork۔ ٹول چنیں، چارٹ پر کلک کریں یا گھسیٹیں۔ ڈرائنگز ونڈو کے ساتھ محفوظ ہوتی ہیں اور لے آؤٹ ٹیبز میں اس کے ساتھ جاتی ہیں۔

| کی                  | ٹول                                |
| ------------------- | ---------------------------------- |
| `F2`                | Trend line                         |
| `F6` / `F7`         | افقی / عمودی لائن                  |
| `F12` / `F11`       | Rectangle / triangle               |
| `F8`                | Fibonacci retracements             |
| `F3` / `Ctrl+F3`    | Volume profile & TPO / fixed range |
| `F4`                | Anchored VWAP                      |
| `F9`                | Ruler                              |
| `M`                 | Magnifier                          |
| `Del`               | منتخب حذف کریں                     |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo                        |
| `Ctrl+A`            | تمام ڈرائنگز منتخب کریں            |

![چارٹ پر ڈرائنگز](images/drawings.webp)

- اینکرز گھسیٹ کر ترمیم کریں؛ **magnet** قیمتوں پر snap کرتا ہے (off / weak / strong)۔ Shift+کلک یا `Ctrl`+ڈبہ گھسیٹنے سے کئی ڈرائنگز منتخب ہوتی ہیں تاکہ گروپ میں منتقل، حذف یا اسٹائل کی جا سکیں۔
- اسٹائل بار رنگ، چوڑائی، dash، fill، متن اور ہر ٹائم فریم کے لیے visibility طے کرتا ہے۔ لائنوں، rays، channels اور rectangles پر **قیمت کا الرٹ** (گھنٹی کا آئیکن) لگ سکتا ہے: cross، enter یا exit۔
- **Objects List** (ربن) تمام ڈرائنگز کو lock، hide، clone اور delete کے ساتھ دکھاتی ہے۔
- ڈرائنگز لنک شدہ چارٹس میں sync ہو سکتی ہیں۔

![Objects List](images/objects-list.webp)

## چارٹ سیٹنگز

`Ctrl+S` ہر چارٹ کی سیٹنگز کھولتا ہے جن میں Visual، Footprint، Trading اور Templates ٹیبز ہیں۔ تبدیلیاں live لاگو ہوتی ہیں؛ Cancel واپس پلٹاتا ہے؛ سیٹنگز JSON میں ایکسپورٹ ہوتی ہیں۔ عالمی ڈیفالٹس Settings ← چارٹ اور Footprint میں ہیں۔

![چارٹ سیٹنگز](images/chart-settings.webp)

## لنک شدہ ونڈوز اور متعدد چارٹس

- **لنک گروپس**: ایک رنگ، ایک انسٹرومنٹ۔ کئی ٹائم فریمز ایک ساتھ پڑھنے کے لیے عالمی crosshair sync کے ساتھ ملائیں۔
- ونڈو مینو (⋯) ← **Create linked window** پہلے سے لنک شدہ چارٹ، DOM، ٹیپ، ہیٹ میپ، footprint یا آپشنز ونڈو کھولتا ہے؛ **Clone** ونڈو کو سیٹنگز سمیت نقل کرتا ہے۔
- **Overlay / compare** (رائٹ کلک ← Overlay) ایک اور انسٹرومنٹ فیصد میں normalise کر کے شامل کرتا ہے۔
- **Export** (رائٹ کلک ← Export): PNG، bars CSV، clusters CSV، bars JSON یا ٹیمپلیٹ بطور JSON۔

![گرڈ لے آؤٹ میں چارٹس](images/layout-grid.webp)
