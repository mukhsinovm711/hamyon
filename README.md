# Hamyoon — Telegram Mini App для учёта доходов

Мини-апп повторяет логику `income.report.xlsx`:

| Лист Excel | В приложении |
|---|---|
| `data` — записи (день, месяц, год, сумма, валюта, тип, форма, источник) | Вкладка «＋» (добавление/редактирование) и «История» |
| `table` — сумма за год, среднее в месяц, Grand total, суммы по дням | «Обзор» и «Отчёты → По годам», «Календарь месяца» |
| `chart` — график по месяцам | График на «Обзоре» (12 мес / всё) |
| `expenses` — доход за период | «Отчёты → Доход за период» (+ расходы и остаток) |
| `BD expenses` — расходы по месяцам | «Ещё → Расходы» |

Среднее в месяц считается как в Excel: сумма за год / число месяцев, в которых был доход.

## Данные

- В Telegram данные хранятся в **Telegram CloudStorage** — привязаны к вашему аккаунту и доступны на всех устройствах, сервер не нужен.
- Вне Telegram (в обычном браузере) — в `localStorage`.
- **Ещё → Импорт из Excel** загружает листы `data` и `BD expenses` из файла такого же формата. Повторный импорт не создаёт дубликатов.
- **Экспорт / Восстановить из JSON** — резервная копия.

## Запуск

1. **Захостить по HTTPS** (Telegram требует https). Проще всего GitHub Pages:
   залейте `index.html`, `app.js`, `styles.css` в репозиторий → Settings → Pages → Deploy from branch.
   Получите адрес вида `https://<user>.github.io/hamyon/`.
   ⚠️ Не заливайте `income.report.xlsx` в публичный репозиторий — это личные данные. Импортируйте его из самого приложения.
2. **Создать бота** в [@BotFather](https://t.me/BotFather): `/newbot`.
3. **Привязать мини-апп** — один из вариантов:
   - в BotFather: `/mybots` → бот → *Bot Settings* → *Menu Button* → указать URL; или `/newapp` для прямой ссылки `t.me/<bot>/<app>`;
   - либо заполнить `BOT_TOKEN` и `WEBAPP_URL` в файле `.env` и запустить `python bot.py` (только стандартная библиотека).
     `.env` добавлен в `.gitignore` — токен не попадёт в репозиторий.
4. Открыть бота → кнопка **Hamyoon** → «Ещё» → «Импорт из Excel» → выбрать `income.report.xlsx`.

## Локальная проверка

```bash
python -m http.server 8765
```
и открыть http://localhost:8765 — работает без Telegram (данные в браузере).

## Импорт выписок через чат с ботом

Бот работает на бесплатном Cloudflare Worker (`worker/`): принимает файл в чате, спрашивает
«Импортировать?», после «Да» кладёт файл в очередь (Cloudflare KV). Приложение при открытии
забирает очередь, разбирает выписки и добавляет операции в «Ожидают подтверждения».
Запросы приложения подписаны initData Telegram и принимаются только от владельца (`OWNER_ID`).

Развёртывание (один раз, из папки `worker`):

```bash
npx wrangler login
npx wrangler kv namespace create INBOX      # id вписать в wrangler.toml
npx wrangler secret put BOT_TOKEN           # токен из @BotFather
npx wrangler secret put WEBHOOK_SECRET      # любая случайная строка
npx wrangler deploy                         # выдаст адрес https://hamyoon-bot.<имя>.workers.dev
```

Затем:
1. Подключить вебхук: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<адрес>/tg&secret_token=<WEBHOOK_SECRET>`.
2. Вписать адрес Worker'а в `INBOX_URL` в `banks.js` и выложить приложение.

После подключения вебхука `bot.py` больше не нужен: `/start` и кнопку открытия обрабатывает Worker.
