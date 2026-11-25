---
id: data-manager
title: Data manager، درآمد اور ایکسپورٹ
section: ڈیٹا
keywords: data manager tick store recorder retention import csv export xlsx htprofile htworkspace httemplate htind ڈیٹا درآمد ایکسپورٹ ریکارڈر
opens: data-manager
---

## Data manager

![Data manager](images/data-manager.webp)

**Data manager** ربن سے یا Connections ونڈو کے دوسرے ٹیب سے کھولیں۔ ڈیسک ٹاپ ایپ میں یہ **مقامی tick store** دکھاتا ہے (`%APPDATA%\HTFlow\ticks`، یا پورٹیبل موڈ میں `data\ticks`):

- ہر محفوظ انسٹرومنٹ اپنی تاریخ کی رینج اور فی دن سائز کے ساتھ۔
- انسٹرومنٹ یا کسی ایک دن کو **حذف** کریں؛ ٹریڈز یا depth کو CSV میں **ایکسپورٹ** کریں۔
- **Recorder**: آپ کے سبسکرائب کیے ہوئے انسٹرومنٹس کی tick ریکارڈنگ آن یا آف، **retention days** اور **max disk GB** کے ساتھ۔ جب کوئی حد پوری ہو تو پرانے دن compact اور ہٹا دیے جاتے ہیں۔
- درآمد شدہ فائلیں ("Imported files") اور آپ کی سمبل فہرستیں۔

Store ہر انسٹرومنٹ اور UTC دن کے لیے فائلوں کا ایک سیٹ رکھتا ہے، checksum والے بلاکس میں compressed۔ کریش کے بعد ادھوری تحریر نظر انداز ہوتی ہے اور index دوبارہ بنایا جاتا ہے۔ براؤزر پری ویو میں tick store نہیں ہے۔

## CSV درآمد

![CSV درآمد ڈائیلاگ](images/import-csv.webp)

`Import CSV: trades or OHLCV bars…` چلائیں (Data manager یا Connections ← CSV / Parquet import):

1. فائل چنیں۔ delimiter، header، کالمز اور وقت کی شکل (epoch s / ms / µs / ns، ISO، d/m/y متن) خود پہچانے جاتے ہیں؛ ضرورت ہو تو درست کریں۔
2. **ٹائم زون** اور **side کا مطلب** چنیں (بشمول `is_buyer_maker`)۔
3. ہر قطار کی توثیق کے ساتھ پہلی قطاروں کا پری ویو دیکھیں۔ مسترد قطاریں لائن نمبروں کے ساتھ درج ہوتی ہیں۔
4. **Import**۔ بڑی فائلیں حصوں میں stream ہوتی ہیں۔

ڈیٹا `csv:<name>` انسٹرومنٹ بن جاتا ہے جو چارٹس اور Replay میں کھلتا ہے۔ OHLCV بارز ہر ایک چار مصنوعی ٹریڈز بنتی ہیں، اس لیے بار ڈیٹا سے بنے footprints تخمینی ہوتے ہیں۔ Parquet اور depth CSV ابھی سپورٹ نہیں۔

## آپ کیا ایکسپورٹ کر سکتے ہیں

| کیا                                             | کہاں                                            | فارمیٹ                                        |
| ----------------------------------------------- | ----------------------------------------------- | --------------------------------------------- |
| پروفائل (اکاؤنٹ، سیٹنگز، ورک اسپیسز)            | اکاؤنٹ مینو ← Export profile                    | `.htprofile`، آپ کے پاس ورڈ سے اب بھی انکرپٹڈ |
| ورک اسپیس                                       | Workspaces manager، `Workspace: Export current` | `.htworkspace`                                |
| چارٹ ٹیمپلیٹ                                    | ٹیمپلیٹ مینو، `Chart: Export template JSON`     | `.httemplate` / JSON                          |
| چارٹ ڈیٹا                                       | چارٹ رائٹ کلک ← Export                          | PNG، bars CSV، clusters CSV، bars JSON        |
| جدول                                            | جدول کا ☰ مینو                                 | CSV، XLSX                                     |
| Tick ہسٹری                                      | Data manager                                    | CSV (ٹریڈز یا depth)                          |
| انڈیکیٹر اسکرپٹ                                 | Script Editor                                   | `.htind`                                      |
| ATM ٹیمپلیٹ، DOM ٹیمپلیٹ، سیٹنگز، تھیم، ہاٹ کیز | ان کے ایڈیٹرز                                   | JSON                                          |
| لاگز                                            | Logs ونڈو                                       | `.txt`                                        |

CSV ایکسپورٹس اسپریڈ شیٹ فارمولوں کو بے اثر کر دیتی ہیں تاکہ انہیں اسپریڈ شیٹ میں کھولنا محفوظ رہے۔
