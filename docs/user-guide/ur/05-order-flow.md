---
id: order-flow
title: آرڈر فلو ٹولز
section: تجزیہ
keywords: footprint volume profile heatmap liquidity map dom time and sales tape big trades imbalance delta poc absorption iceberg آرڈر فلو والیوم پروفائل ہیٹ میپ ٹیپ ڈیلٹا
opens: heatmap, smart-dom, smart-tape, bidask-tape, all-prices
---

آرڈر فلو ٹولز دکھاتے ہیں کہ **کس قیمت پر کس نے ٹریڈ کی** (aggressor کی طرف) اور **بک میں کیا رکا ہوا تھا**۔ HT Flow انفرادی ٹریڈز سے بارز بناتا ہے، اس لیے ہر بار کو ہر قیمت پر ask پر خریدا اور bid پر بیچا گیا والیوم معلوم ہوتا ہے۔

## Footprint

![Delta موڈ والا Footprint](images/footprint-delta.webp)

**Footprint chart** کھولیں (ربن ← Chart ▾، یا `New chart: Footprint chart`)۔ ہر بار قیمت کی قطاروں (clusters) میں بٹی ہوتی ہے۔

**سیل کا مواد** (21 موڈز): بائیں سائیڈ ٹولز کے عمودی ٹیبز (Volume ›، Trades ›، Bid x Ask ›، Delta ›) یا کیز `Alt+V` (Volume)، `Alt+T` (Trades)، `Alt+B` (Bid x Ask)، `Alt+D` (Delta) سے بدلیں۔ مزید موڈز میں Volume x Trade اور Volume x Delta شامل ہیں؛ اسٹائلز میں اعداد، ہسٹوگرام، ladder اور bid/ask یا delta profile ہیں۔

نشانات کا مطلب:

- **Bid x Ask**: بائیں طرف bid پر فروخت، دائیں طرف ask پر خریداری۔
- **Delta** = ask والیوم − bid والیوم۔ سبز کا مطلب خریدار جارحانہ ہیں، سرخ کا مطلب بیچنے والے۔
- **POC باکس**: بار میں سب سے زیادہ والیوم والی قیمت۔ **Value area** (ڈیفالٹ 70 %) شیڈ ہوتا ہے۔
- **Imbalance**: سیل اس وقت نمایاں ہوتا ہے جب کسی قیمت پر ask والیوم، ایک قطار نیچے کے bid والیوم سے ratio (ڈیفالٹ 300 %) اور کم از کم والیوم کے لحاظ سے بڑھ جائے۔ لگاتار N لیولز کے **Stacked imbalances** دائیں طرف بڑھے ہوئے زونز کی صورت میں بنتے ہیں۔
- چارٹ کے نیچے **Statistics قطاریں**: Delta، Session Delta، Volume (ساتھ Trades، Delta %، Max / Min delta)۔
- **Absorption markers** اس بھاری والیوم کی نشاندہی کرتے ہیں جس نے قیمت کو حرکت نہیں دی (Settings ← Footprint)۔

**Quick settings**: سائیڈ ٹولز کا سلائیڈر بٹن (یا `Footprint: Quick settings…`) موڈ، فی قطار ticks (auto، 1، 2، 4، 5، 10)، آٹو کولیپس چوڑائی، POC، value area، imbalance ratio اور رنگ، فلٹرز (کم از کم والیوم / delta) اور پری سیٹس (Imbalance hunter، Value area per bar، Big clusters only؛ اپنے بھی محفوظ کیے جا سکتے ہیں) طے کرتا ہے۔

![Footprint کی Quick settings](images/footprint-quick-settings.webp)

> **ٹِپ** تقریباً 20 px فی بار سے زیادہ زوم آؤٹ کرنے پر footprint خود بخود کینڈلز میں سمٹ جاتا ہے (قابل ترتیب) تاکہ بڑی ہسٹری تیز رہے۔

![Imbalance چارٹ](images/chart-imbalance.webp)

## والیوم پروفائل

- **Candlesticks + Volume Profile** ہر مدت کے لیے vPOC، VAH اور VAL کے ساتھ پروفائل بناتا ہے۔ Footprint چارٹ بائیں طرف نظر آنے والی رینج کا پروفائل اور پچھلے سیشن کا پروفائل بھی دکھاتا ہے۔
- کسی بھی رینج پر **Volume Profile & TPO** (`F3`) یا **Fixed range** (`Ctrl+F3`) اور **Anchored VWAP** (`F4`) بنائیں۔
- **TPO Chart** مارکیٹ پروفائل ہے جس میں حروف یا بلاکس، value area، POC، initial balance اور single prints ہیں۔
- **Delta Profile** اور **Volume Histogram** ہر بار میں قیمت کے لحاظ سے delta یا والیوم دکھاتے ہیں۔

![Delta profile](images/chart-delta-profile.webp)

## Heatmap / لیکویڈیٹی میپ

![Heatmap ونڈو](images/heatmap-window.webp)

Heatmap وقت کے ساتھ آرڈر بک میں رکی ہوئی لیکویڈیٹی بناتا ہے: ہر وقت کے کالم اور قیمت کی قطار کے لیے ایک پکسل، جتنا روشن اتنا زیادہ سائز۔ **Liquidity Map** چارٹ ٹیمپلیٹ، الگ **Heatmap** ونڈو (ربن) یا کینڈلز کے پیچھے **On-Chart Liquidity Map** استعمال کریں۔

- **Trade bubbles** ایگزیکیوٹ شدہ والیوم دکھاتے ہیں (سادہ، buy / sell کا pie، یا غالب سائیڈ)۔ **Lots ≥** سے فلٹر کریں۔
- بہترین bid / ask لائنیں، دائیں طرف **DOM کالم**، والیوم بارز (والیوم یا delta کے لحاظ سے)۔
- **Column size** 250 ms سے 5 s؛ رنگوں کے gradients (Thermal، Classic، Ruby، Monochrome، Ocean، Blue to red، Viridis)، contrast، اوپری / نچلی percentile حد، linear / log / sqrt اسکیل، فی کالم یا عالمی normalisation۔
- **بڑے آرڈرز کے outlines**، **آرڈر کی عمر** کے رنگ، اور قابل ترتیب حدوں کے ساتھ **iceberg** اور **spoof** کی شناخت۔
- **3D موڈ** بک کو سطح کی صورت میں بناتا ہے (WebGL کے بغیر 2D isometric منظر پر لوٹ جاتا ہے)۔
- Quick settings پاپ اوور، مکمل سیٹنگز ڈائیلاگ، اسنیپ شاٹ (PNG) اور منظر ری سیٹ سب کمانڈز ہیں (`Heatmap: …`)۔ بائیں ٹول بار میں trend line، افقی / عمودی لائن، rectangle، ellipse، channel، measure اور text ہیں۔

![Heatmap کی Quick settings](images/heatmap-quick-settings.webp)

## Smart DOM

![Smart DOM ladder](images/smart-dom.webp)

DOM قیمتوں کی ایک سیڑھی (ladder) ہے جس میں بک اور آپ کے آرڈرز ہوتے ہیں۔ اسے ربن سے کھولیں (**Smart DOM ▾** میں Basic سے لے کر risk strip والے Prop DOM تک 13 ٹیمپلیٹس ہیں) یا کسی بھی چارٹ کے ساتھ ڈاک ہونے والا DOM Trader استعمال کریں (چارٹ کی نچلی بار)۔

- کالمز میں Orders / P&L، قیمت پر والیوم (سیشن یا rolling)، Price، تبدیلی، Bid، Sells، Buys، Ask، Σ bid / Σ ask، delta، آخری سائز، value area / POC، نوٹس اور stop / iceberg markers شامل ہیں۔ انہیں **Columns** مینو یا ٹیمپلیٹ ڈیزائنر (`Smart DOM: template designer…`) سے آن آف، ترتیب، سائز اور رنگ دیں۔
- **Centering**: auto-centre قیمت کے ساتھ چلتا ہے؛ وہیل اسکرول کرتا ہے؛ `C` یا ڈبل کلک دوبارہ مرکز پر لاتا ہے؛ `PageUp` / `PageDown` اسکرول کرتے ہیں۔
- **Grouping**: فی قطار 1، 2، 5 یا 10 ticks۔
- **ایک کلک ٹریڈنگ** کی تفصیل [ٹریڈنگ](06-trading.md#dom-and-chart-trading) میں ہے۔

## Time and sales (Smart Tape)

![Smart Tape](images/smart-tape.webp)

- **Smart Tape** پرنٹس کو سائز کے بکٹ رنگوں کے ساتھ دکھاتا ہے۔ ایک ہی ٹائم اسٹیمپ (یا وقت کی کھڑکی) کے پرنٹس VWAP، fill گنتی اور مجموعی delta کے ساتھ ایک لائن میں جمع کیے جا سکتے ہیں۔ سائز، سائیڈ اور وقت پر فلٹرز؛ **pause on hover**؛ وہیل پیچھے اسکرول کرتا ہے؛ فی سیکنڈ پرنٹس اور فی سیکنڈ والیوم دکھائے جاتے ہیں۔
- **Bid/Ask Tape** فروخت (بائیں)، قیمت اور خریداری (دائیں) کو سائز chips اور اسپیڈ میٹر کے ساتھ الگ کرتا ہے۔
- **All Prices** قیمت بہ قیمت سیشن والیوم کا جدول ہے جس میں delta، قیمت پر وقت، POC اور والیوم بار ہیں؛ کسی بھی کالم سے ترتیب دیں، قطاروں کو گروپ کریں، اور Session / Visible / Week چنیں۔

![Bid/Ask Tape](images/bidask-tape.webp)

![All Prices](images/all-prices.webp)

ہر ٹیپ فعال چارٹ یا DOM کی پیروی کرتا ہے، یا آپ کوئی انسٹرومنٹ پن کر سکتے ہیں۔

## بڑے ٹریڈز

بڑے پرنٹس کئی جگہ نمایاں ہوتے ہیں، سب آپ کی مقرر کردہ حدوں سے چلتے ہیں:

- **Smart Tape**: _Big-trade threshold_ قطار کو نمایاں کرتا ہے اور beep بھی کر سکتا ہے (Settings ← ٹیپ)۔
- **Heatmap**: bubbles سائز کے ساتھ بڑھتے ہیں؛ **Lots ≥** چھوٹے چھپا دیتا ہے۔
- **DOM**: _Big-lot threshold_ (Settings ← DOM) بڑے رکے ہوئے آرڈرز کو نمایاں کرتا ہے۔
- **Alerts**: _big trade_ شرط آپ کو مطلع کرتی ہے (دیکھیں [Alerts](08-alerts.md))۔
- **Big Trades** انڈیکیٹر (Indicators ← Favourites) انہیں چارٹ پر نشان زد کرتا ہے۔
