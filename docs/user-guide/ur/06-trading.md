---
id: trading
title: ٹریڈنگ
section: ٹریڈنگ
keywords: paper trading order types limit stop market brackets atm oco positions risk limits hot keys journal flatten reverse breakeven پیپر ٹریڈنگ آرڈر پوزیشن رسک جرنل ہاٹ کیز
opens: accounts, positions, orders, trades, activity, risk, journal
---

> **نوٹ** HT Flow ایک **پیپر انجن** پر ٹریڈ کرتا ہے جو live (یا سمیولیٹڈ) آرڈر بک کے مقابل fill ہوتا ہے۔ ابھی بروکر کنیکٹرز نہیں ہیں، اس لیے کوئی حقیقی آرڈر کبھی نہیں بھیجا جاتا۔

## پیپر اکاؤنٹس

![اکاؤنٹس کا جدول](images/accounts-table.webp)

ڈیفالٹ اکاؤنٹ **Paper · ••••3505** 50,000 USD سے شروع ہوتا ہے۔ اکاؤنٹس بنانے، نام بدلنے، ابتدائی بیلنس اور کرنسی طے کرنے، ری سیٹ یا حذف کرنے کے لیے کمانڈ `Paper accounts…` استعمال کریں؛ `New paper account`، `Reset active paper account` اور `Switch to next paper account` بھی کمانڈز ہیں۔ اکاؤنٹ نمبر چھپائے جا سکتے ہیں (Settings ← رازداری اور سیکیورٹی)۔

![پیپر اکاؤنٹس ڈائیلاگ](images/paper-accounts.webp)

کھلی پوزیشنز، رکے ہوئے آرڈرز (بشمول OCO گروپس، brackets اور ATM مینجمنٹ) اور بیلنس آپ کے انکرپٹڈ پروفائل میں محفوظ ہوتے ہیں اور ری اسٹارٹ کے بعد بحال ہوتے ہیں۔ Fills اور ٹریڈ ہسٹری ابھی اکاؤنٹ کی حالت کے ساتھ محفوظ نہیں ہوتیں۔

## Trading Panel

![Trading Panel](images/trading-panel.webp)

اسے `T` یا **Panel** بٹن سے آن آف کریں۔ اوپر سے نیچے: اکاؤنٹ سلیکٹر (چھپے ہوئے id اور آنکھ کے ٹوگل کے ساتھ)، lot پری سیٹس (1، 2، 5، 10) کے ساتھ مقدار، **BUY MARKET / SELL MARKET**، **BUY ASK / SELL ASK** اور **BUY BID / SELL BID** (بہترین قیمت پر limit آرڈرز)، **Cancel Bids / Asks / All**، **Reverse**، **Breakeven** (`H`)، **Close**، P&L، پوزیشن اور اوسط entry۔ اس کے نیچے: **OCO**، time in force (GTC، DAY، IOC، FOK، GTD)، **Reduce-Only**، ATM ٹیمپلیٹ پکر کے ساتھ **SL/TP** سوئچ، اور آرڈر کی قسم کا سلیکٹر۔

پینل فعال چارٹ یا DOM کے انسٹرومنٹ پر ٹریڈ کرتا ہے۔

## آرڈر کی اقسام

| قسم                         | رویہ                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- |
| **Market**                  | بک میں لیول بہ لیول چلتا ہے؛ کئی قیمتوں پر جزوی fills؛ اختیاری slippage guard           |
| **Limit**                   | رکا رہتا ہے اور جب ٹیپ اس کی قیمت سے گزرے تو fill ہوتا ہے                              |
| **Stop**                    | آخری ٹریڈ stop قیمت تک پہنچنے پر market آرڈر بن جاتا ہے                                 |
| **Stop-limit**              | Stop ٹرگر، پھر limit آرڈر                                                               |
| **MIT** (market if touched) | قیمت کو چھونے پر ٹرگر ہوتا ہے، پھر market                                               |
| **Trailing stop**           | ticks، فیصد یا ATR کے حساب سے قیمت کے پیچھے چلتا ہے اور صرف تنگ ہوتا ہے                 |
| **Iceberg**                 | دکھانے والی مقدار ظاہر کرتا ہے اور چھپی ہوئی کل مقدار سے اسے دوبارہ بھرتا ہے            |

Time in force: **GTC**، **DAY**، **IOC**، **FOK**، **GTD**۔ **Reduce-only** آرڈرز صرف پوزیشن کم کر سکتے ہیں۔ کمیشن (maker اور taker، rebates کی اجازت) Settings ← کمیشن سے آتا ہے؛ slippage ٹرگر ہونے والے آرڈرز پر ہر اکاؤنٹ کے لیے مقرر ہوتی ہے۔

## Brackets اور ATM

![ATM ٹیمپلیٹس](images/atm-setup.webp)

ہر entry کے ساتھ حفاظتی آرڈرز لگانے کے لیے Trading Panel، DOM یا DOM Trader میں **SL/TP** آن کریں۔ **ATM ٹیمپلیٹ** (`ATM templates…`) یہ طے کرتا ہے:

- ticks، ڈالر، فیصد یا ATR میں **stop loss**، اختیاری طور پر trailing۔
- زیادہ سے زیادہ **آٹھ take-profit اہداف**، ہر ایک اپنی مقدار کے وزن کے ساتھ، ڈالر، فیصد، پوائنٹس یا ticks میں۔
- **Auto-breakeven** اور **trailing steps**۔

پانچ پری سیٹس شامل ہیں: Scalp 1:1، Three targets + BE، Runner (trail steps)، ATR swing اور Trailing stop only (`ATM: use …` کمانڈز)۔ جب کوئی ہدف fill ہوتا ہے تو stop باقی سائز تک سکڑ جاتا ہے؛ stop fill ہونے پر اہداف منسوخ ہو جاتے ہیں۔ ٹیمپلیٹس JSON میں ایکسپورٹ اور درآمد ہوتے ہیں۔

## OCO

**OCO** پر نشان لگائیں (یا `Toggle OCO` چلائیں) تو آپ کے رکھے ہوئے آرڈرز **one-cancels-other** گروپس بناتے ہیں: پہلا fill یا منسوخی باقی کو منسوخ کر دیتی ہے۔ `Start a new OCO group` نیا گروپ شروع کرتا ہے؛ `Link the last two working orders as OCO` موجودہ آرڈرز کو جوڑتا ہے۔ OCO گروپس Trading Panel اور Orders جدول میں نظر آتے ہیں۔

## DOM اور چارٹ ٹریڈنگ

- **DOM**: Bid یا Ask کالم پر بایاں کلک = اس قیمت پر **buy limit**؛ رائٹ کلک = **sell limit**؛ stops کے لیے `Ctrl` دبائیں۔ اپنا آرڈر منسوخ کرنے کے لیے Orders کالم میں اس پر کلک کریں، یا ترمیم کے لیے اسے دوسری قیمت پر گھسیٹیں۔ فُٹر: reverse، cancel all / bids / asks، **MKT** buy اور sell، **Flatten all**، Trading Panel، اور ایک **lock** جو اس DOM سے ہر آرڈر روک دیتا ہے۔ (Settings ← DOM ← _Swap left / right click_ بٹن الٹ دیتا ہے۔)
- **چارٹ**: رائٹ کلک ← کرسر کی قیمت پر **Buy Limit / Sell Stop** یا **Sell Limit / Buy Stop** (پینل کے ATM اور تصدیقوں کے ساتھ)۔ اپنی **position line** (live P&L، بند کرنے کے لیے ✕)، گھسیٹنے والی **آرڈر اور SL / TP لائنیں**، اور B / S **fill markers** دکھانے کے لیے `Toggle trading on chart` آن کریں۔
- ہر آرڈر کی **تصدیقیں** (`Order confirmations…`) اور _Confirm Flatten all_ Settings ← عمومی میں ہیں۔

![چارٹ اور DOM پر کھلی پوزیشن](images/position-open.webp)

## پوزیشنز، آرڈرز اور جدول

![Positions جدول](images/positions-table.webp)

ربن کے جدول (Accounts، Positions، Orders، Trades، Trading Activity) ایک ہی virtualised گرڈ بانٹتے ہیں: کالم چنیں، ترتیب، ہر کالم کے فلٹرز (متن اور `>` / `<=` / `=`)، گروپنگ، محفوظ ویوز، **CSV** اور **XLSX** ایکسپورٹ۔ **Orders** میں ترمیم کے لیے Price یا Qty پر ڈبل کلک کریں (یا **Modify**)؛ Enter لاگو کرتا ہے۔ **Positions** میں Close، Reverse اور **Flatten all** ہیں۔ **Trading Activity** 90 دن تک fills، منسوخیاں، رد، locks، رسک وارننگز اور الرٹ فائرنگز درج کرتی ہے۔

## رسک کی حدود

![Risk ونڈو](images/risk-window.webp)

**Risk** ونڈو اور Settings ← رسک ہر اکاؤنٹ کی حفاظت طے کرتے ہیں:

- زیادہ سے زیادہ روزانہ نقصان، trailing drawdown، منافع کا ہدف۔
- زیادہ سے زیادہ پوزیشن سائز، آرڈر سائز، فی منٹ آرڈرز، فی دن ٹریڈز۔
- ٹائم زون کے ساتھ ٹریڈنگ کے اوقات؛ قیمت کی حد (price collar)۔
- کسی حد کے 80 % پر وارننگ ملتی ہے (ٹائٹل بار کا **Daily risk** میٹر امبر، پھر سرخ ہو جاتا ہے)۔ حد ٹوٹنے پر HT Flow flatten کر سکتا ہے اور اگلے دن تک ٹریڈنگ **lock** کر سکتا ہے؛ locks ری اسٹارٹ کے بعد بھی رہتے ہیں۔ ایک override پاس ورڈ (hash ہو کر محفوظ) اَن لاک کر سکتا ہے۔
- پراپ فرم طرز اور محتاط پروفائلز کے پری سیٹس؛ _Apply to all accounts_؛ اکنامک کیلنڈر سے چلنے والا **news-flatten** آپشن۔

## ٹریڈنگ جرنل

![Journal](images/journal.webp)

ہر بند ہونے والا round trip جرنل میں درج ہوتا ہے: R multiple، expectancy، long / short جیت کی شرح، زیادہ سے زیادہ drawdown، بہترین setup، drawdown کے ساتھ equity curve، کیلنڈر heatmap، MAE / MFE، ساتھ آپ کے اپنے ٹیگز، نوٹس، ریٹنگز اور تصویری اٹیچمنٹس۔ Entry اور exit پر چارٹ اسنیپ شاٹس لیے جا سکتے ہیں۔ بیک ٹیسٹ ٹریڈز ٹیگ `backtest` کے ساتھ درآمد کیے جا سکتے ہیں۔ CSV میں ایکسپورٹ کریں۔

## ہاٹ کیز

| کی       | عمل                              |
| -------- | -------------------------------- |
| `T`      | Trading Panel دکھائیں / چھپائیں  |
| `H`      | Breakeven                        |
| `Ctrl+L` | HT Flow لاک کریں                 |
| `C`      | DOM کو مرکز پر لائیں (DOM فوکس میں) |

آرڈر کمانڈز (Buy market، Sell market، Close position، Reverse، Cancel all، Cancel last) Command Palette میں بغیر ڈیفالٹ کی کے موجود ہیں تاکہ آپ Settings ← ہاٹ کیز میں اپنی کی لگا سکیں۔ ہاٹ کیز کے **scopes** ہیں (global، chart، trading panel، replay) تاکہ ایک کی مختلف ونڈوز میں مختلف معنی رکھ سکے۔ مکمل فہرست [کی بورڈ شارٹ کٹس](16-keyboard-shortcuts.md) میں ہے۔

![ہاٹ کیز کی سیٹنگز](images/settings-hotkeys.webp)
