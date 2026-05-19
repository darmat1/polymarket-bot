# Running Strategies

## Overview

Сейчас стратегии запускаются так:

- **Weather strategy** — сервер всегда поднимает weather bot infrastructure, но сами погодные боты активируются **вручную** через UI/API.
- **Scalper strategy** — стартует **автоматически при запуске сервера**, если включен `BOT_ENABLE_SCALPER=true`.

## Main Rule

Перед реальной торговлей проверьте:

- `BOT_DRY_RUN=false` только если хотите реальные ордера
- кошелёк и L2 credentials настроены
- для скальпера хватает баланса под `MAX_BOT_BUDGET`

## Auth Model

Backend использует **только env-based L2 auth**.

Обязательные переменные:

```env
POLYMARKET_PRIVATE_KEY=
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
```

Flow `derive/create api key` больше не используется.

---

## 1. Run only Weather Strategy

В `.env` / `backend/.env`:

```env
BOT_ENABLE_SCALPER=false
BOT_DRY_RUN=true
```

Запуск:

```bash
docker-compose up --build -d
```

Дальше:

- откройте UI
- выберите нужный weather market
- нажмите запуск weather bot

Итог:

- скальпер не стартует
- погодные боты можно включать вручную

---

## 2. Run only Scalper Strategy

В `.env` / `backend/.env`:

```env
BOT_ENABLE_SCALPER=true
BOT_DRY_RUN=true

BUY_PRICE_LIMIT=0.20
SELL_PRICE_LIMIT=0.30
ORDER_SIZE=5
MAX_BOT_BUDGET=3.0
MIN_LIQUIDITY=0
CANCEL_BUY_BEFORE_SEC=30
CANCEL_SELL_BEFORE_SEC=15
SCALPER_SCANNER_POLL_INTERVAL_SEC=5
SCALPER_STATE_FILE=data/scalper-state.json
```

Запуск:

```bash
docker-compose up --build -d
```

Итог:

- сервер поднимется
- скальпер автоматически начнёт сканирование рынков
- weather bot infrastructure будет доступна, но если ничего вручную не активировать, погодная стратегия фактически не работает

---

## 3. Run Weather + Scalper Together

В `.env` / `backend/.env`:

```env
BOT_ENABLE_SCALPER=true
BOT_DRY_RUN=true
```

Запуск:

```bash
docker-compose up --build -d
```

Дальше:

1. скальпер стартует автоматически
2. weather bot активируете вручную через UI/API

Итог:

- обе стратегии работают параллельно
- используют общий backend/runtime auth/trading stack

---

## Useful Commands

### Rebuild and run

```bash
docker-compose up --build -d
```

### Backend typecheck

```bash
cd backend && pnpm run check
```

### Backend build

```bash
cd backend && pnpm run build
```

### Frontend dev

```bash
cd frontend && pnpm run dev
```

---

## Important Notes

### Weather strategy

- polling interval у weather bot должен оставаться **65 секунд**
- weather cache TTL должен оставаться **60 секунд**

### Scalper strategy

- использует state file: `data/scalper-state.json`
- виртуальный бюджет не должен превышать `MAX_BOT_BUDGET`
- при рестарте состояние бюджета/ордеров читается из файла

### Real trading safety

Для реальной торговли:

```env
BOT_DRY_RUN=false
```

Но включайте это только когда уверены в ключах, балансе и настройках.

---

## Current Limitation

Сейчас **weather strategy не имеет отдельного auto-start флага**, а включается вручную через UI/API.

То есть текущая модель такая:

- **weather only** = `BOT_ENABLE_SCALPER=false` + вручную включаете weather bot
- **scalper only** = `BOT_ENABLE_SCALPER=true` + weather bot не активируете
- **both** = `BOT_ENABLE_SCALPER=true` + вручную активируете weather bot
