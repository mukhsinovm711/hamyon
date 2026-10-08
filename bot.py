"""Минимальный бот для запуска мини-аппа Hamyoon. Только стандартная библиотека Python.

Запуск: заполните BOT_TOKEN и WEBAPP_URL в файле .env рядом со скриптом, затем
    python bot.py
"""
import json
import os
import time
import urllib.request
from pathlib import Path


def load_env(path=Path(__file__).with_name(".env")):
    """Читает KEY=VALUE из .env; переменные окружения имеют приоритет."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()
TOKEN = os.environ.get("BOT_TOKEN", "")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "")
OWNER_ID = int(os.environ.get("OWNER_ID") or 0)  # 0 — бот отвечает всем
if not TOKEN or not WEBAPP_URL or "your-username" in WEBAPP_URL:
    raise SystemExit("Заполните BOT_TOKEN и WEBAPP_URL в файле .env")
API = f"https://api.telegram.org/bot{TOKEN}/"


def call(method, **params):
    req = urllib.request.Request(
        API + method,
        data=json.dumps(params).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)["result"]


def main():
    # Кнопка «Hamyoon» слева от поля ввода во всех чатах с ботом
    call("setChatMenuButton", menu_button={
        "type": "web_app", "text": "Hamyoon", "web_app": {"url": WEBAPP_URL},
    })
    print("Бот запущен, меню-кнопка установлена:", WEBAPP_URL)

    offset = 0
    while True:
        try:
            updates = call("getUpdates", offset=offset, timeout=50)
        except Exception as e:  # сеть может временно отваливаться
            print("getUpdates error:", e)
            time.sleep(5)
            continue
        for u in updates:
            offset = u["update_id"] + 1
            msg = u.get("message")
            if not msg or not msg.get("text", "").startswith("/start"):
                continue
            if OWNER_ID and msg["from"]["id"] != OWNER_ID:
                continue
            call("sendMessage", chat_id=msg["chat"]["id"],
                 text="💰 Hamyoon — учёт доходов.\nНажмите кнопку ниже, чтобы открыть приложение.",
                 reply_markup={"inline_keyboard": [[
                     {"text": "Открыть Hamyoon", "web_app": {"url": WEBAPP_URL}},
                 ]]})


if __name__ == "__main__":
    main()
