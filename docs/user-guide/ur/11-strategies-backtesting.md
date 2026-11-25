---
id: strategies
title: اسٹریٹجیز اور بیک ٹیسٹنگ
section: ٹولز
keywords: strategy backtest optimiser grid search walk-forward vps runner monte carlo sharpe sortino اسٹریٹجی بیک ٹیسٹ
opens: strategies
---

## Strategies ونڈو

![Strategies ونڈو](images/strategies-window.webp)

ربن سے **Strategies** کھولیں۔ ایپ کے ساتھ پانچ مثالی اسٹریٹجیز آتی ہیں جو `@htflow/strategy` SDK پر بنی ہیں: typed inputs، بارز، ٹریڈز، بک اپ ڈیٹس اور fills کے ہینڈلرز، انڈیکیٹر تک رسائی، footprint helpers اور brackets، trailing stops اور ATM ٹیمپلیٹس والا آرڈر API۔

1. **اسٹریٹجی** چنیں اور اس کے **inputs** طے کریں۔
2. **ڈیٹاسیٹ** (replay کا ماخذ: سمیولیٹر، tick store یا درآمد شدہ CSV) اور تاریخ کی رینج چنیں۔
3. **slippage** اور **commission** طے کریں۔
4. **Run backtest** دبائیں (`Strategies: Run backtest`)۔

بیک ٹیسٹر deterministic ہے: ایک جیسے inputs اور ڈیٹا ہمیشہ ایک جیسے ٹریڈز دیتے ہیں۔

## نتائج پڑھنا

![بیک ٹیسٹ کے نتائج](images/strategy-results.webp)

خلاصہ شماریات (net profit، جیت کی شرح، profit factor، زیادہ سے زیادہ drawdown، Sharpe، Sortino، Monte-Carlo drawdown)، ٹریڈز کی فہرست، equity curve اور ایک لاگ۔ **Export results to CSV** اور **Send backtest trades to Journal** (ٹیگ `backtest`) بٹن بھی ہیں اور کمانڈز بھی۔

## Optimise

`Optimise inputs (grid search)` آپ کی دی ہوئی رینجز کے ہر امتزاج کو Web Worker میں چلاتی ہے، نتائج کا **heatmap** دکھاتی ہے اور شور کو fit کرنے سے بچنے کے لیے **walk-forward** ٹیسٹنگ (ایک ونڈو پر optimise، اگلی پر ٹیسٹ) کی سہولت دیتی ہے۔

> **ٹِپ** چند ٹریڈز کم ثبوت ہیں۔ کسی ایک بہترین خانے کی بجائے ایسے پیرامیٹر علاقے ترجیح دیں جہاں ہمسایہ قدریں بھی کام کریں۔

## چارٹ پر چلائیں (پیپر)

`Chart: Attach strategy…` اسٹریٹجی کو چارٹ پر entry / exit **markers** کے ساتھ لگاتی ہے؛ `Start / stop live strategy (paper)` اسے پیپر انجن پر ٹریڈ کراتی ہے۔ `Strategies: Show running strategies` انہیں فہرست کرتی ہے اور `Stop all and flatten` ہنگامی بٹن ہے۔

## VPS رنر

آپ بلٹ اِن اسٹریٹجی **اپنے** VPS پر چلا سکتے ہیں (HT Flow کا کوئی سرور نہیں): VPS شامل کریں (host، port، user اور SSH کلید یا پاس ورڈ vault میں؛ پہلی بار host key پن ہو جاتی ہے)، system check چلائیں (Node.js 22+)، اسٹریٹجی کو واحد فائل Node.js bundle کی صورت میں **deploy** کریں، پھر start، stop، restart یا remove کریں۔ ونڈو uptime، P&L، پوزیشن، ٹریڈز اور لاگ لائنیں poll کرتی ہے، ریموٹ کنسول دیتی ہے، اور fills کو "VPS" اکاؤنٹ کے طور پر Journal میں درآمد کرتی ہے۔ Live آرڈر روٹنگ ابھی دستیاب نہیں (اس کے لیے بروکر کنیکٹر چاہیے)۔

## ابھی دستیاب نہیں

اسٹریٹجیز کے لیے کوڈ ایڈیٹر، `.ts` / `.py` / `.htstrat` لوڈنگ، Python رنر اور no-code rule builder۔ انڈیکیٹرز کی اسکرپٹنگ پہلے سے ممکن ہے ([چارٹس](04-charts.md#indicators))۔
