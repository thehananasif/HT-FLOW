---
id: alerts
title: الرٹس
section: ٹولز
keywords: alerts notification sound telegram discord price cross big trade delta dom funding liquidation cooldown expiry الرٹ اطلاع آواز قیمت
opens: alerts
---

## Alerts ونڈو

![Alerts ونڈو](images/alerts-window.webp)

ربن سے **Alerts** کھولیں۔ ہر قطار ایک الرٹ ہے جس میں اس کی شرط، انسٹرومنٹ، حالت اور آخری ٹرگر ہے۔ ▾ مینو اور کمانڈز `Alerts: Pause / resume all`، `Enable all`، `Disable all` تمام قطاروں پر ایک ساتھ عمل کرتے ہیں۔

## الرٹ بنانا

1. **New alert** پر کلک کریں (یا چارٹ پر رائٹ کلک ← **Set alert**، یا ڈرائنگ پر گھنٹی)۔
2. **شرط** چنیں:
   - کسی لیول پر **Price cross** (اوپر، نیچے یا کوئی بھی)۔
   - کسی سائز یا اس سے اوپر **Big trade**۔
   - کسی قدر سے آگے **Bar delta**۔
   - قیمت کے N ticks کے اندر **DOM level**۔
   - کرپٹو perps پر **Funding rate** اور **Liquidation** شرائط۔
   - کسی فیڈ پر **Connection lost**۔
   - **Indicator value** (Indicators ڈائیلاگ کے Alerts ٹیب سے)۔
   - **Drawing** الرٹس: لائنوں، rays، channels اور rectangles کے لیے cross، enter یا exit۔
3. طے کریں کہ یہ کیسے دہرایا جائے: **count**، **expiry** اور **cool-down** (ڈیفالٹس Settings ← الرٹس میں)۔
4. چنیں کہ آپ کو کیسے مطلع کیا جائے، پھر محفوظ کریں۔

![الرٹ کا فارم](images/alert-form.webp)

## اطلاعات

- **پاپ اپ** toast، **beep** (بلٹ اِن آواز یا آپ کے پروفائل میں محفوظ مقامی فائل)، **ڈیسک ٹاپ نوٹیفکیشن**، **Trading Activity** میں اندراج، اور جھپکتا ہوا **ونڈو / ٹاسک بار** آئیکن۔
- **Telegram** اور **Discord**: اپنا bot ٹوکن یا webhook دیں؛ یہ آپ کے انکرپٹڈ vault میں رہتا ہے۔ جانچ کے لیے _Send a test to Telegram / Discord_ استعمال کریں۔ پیغامات throttle ہوتے ہیں۔
- الرٹ لائنیں چارٹ پر اپنی قیمت پر نظر آتی ہیں۔

![الرٹس کی سیٹنگز](images/settings-alerts.webp)

> **نوٹ** الرٹس HT Flow کھلا ہونے پر چلتے ہیں۔ ایپلیکیشن بند ہو تو یہ کام نہیں کرتے، اور لاک شدہ ایپ بھی انہیں evaluate کرتی رہتی ہے۔

## حدود اور مشورے

- فعال الرٹس کی زیادہ سے زیادہ تعداد Settings ← الرٹس میں طے ہوتی ہے۔
- **Once per bar** فی الحال _Every time_ کی طرح چلتا ہے؛ تکرار سے بچنے کے لیے cool-down استعمال کریں۔
- تمام آوازیں عالمی طور پر کمانڈ `Mute / unmute all sounds` سے خاموش کی جا سکتی ہیں۔
