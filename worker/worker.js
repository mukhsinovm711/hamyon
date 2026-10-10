/* Hamyoon — бот и очередь импорта (Cloudflare Worker).
 *
 * 1. Вы отправляете боту выписку Revolut или Wise → бот спрашивает «Импортировать?».
 * 2. «Да» → файл (его file_id) встаёт в очередь в KV.
 * 3. Мини-приложение при открытии забирает очередь: GET /inbox, GET /file?id=…,
 *    разбирает файл своими обработчиками и подтверждает POST /inbox/done.
 *
 * Запросы приложения подписаны initData Telegram: подпись проверяется токеном бота,
 * и принимаются только от OWNER_ID. Токен бота хранится в секрете BOT_TOKEN.
 *
 * Переменные окружения: BOT_TOKEN (секрет), WEBHOOK_SECRET (секрет), OWNER_ID, WEBAPP_URL, APP_ORIGIN.
 * KV: INBOX.
 */

const FILE_TYPES = /\.(pdf|xlsx|xls|csv)$/i;
const MAX_BYTES = 20 * 1024 * 1024; // лимит Bot API на скачивание файлов
const INIT_DATA_TTL = 7 * 24 * 3600; // сек.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (url.pathname === '/tg' && request.method === 'POST') return await webhook(request, env);
      if (url.pathname === '/inbox' && request.method === 'GET') return await withUser(request, env, cors, () => listInbox(env));
      if (url.pathname === '/file' && request.method === 'GET') return await withUser(request, env, cors, () => getFile(env, url.searchParams.get('id'), cors));
      if (url.pathname === '/inbox/done' && request.method === 'POST') return await withUser(request, env, cors, () => done(request, env));
      return new Response('Hamyoon worker', { headers: cors });
    } catch (e) {
      console.error(e);
      return json({ error: String(e.message || e) }, 500, cors);
    }
  },
};

/* ---------- Telegram webhook ---------- */

async function webhook(request, env) {
  if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  const update = await request.json();
  const owner = Number(env.OWNER_ID);

  const msg = update.message;
  if (msg) {
    if (msg.from?.id !== owner) return ok(); // бот только для владельца
    if (msg.document) await askImport(env, msg);
    else if ((msg.text || '').startsWith('/start')) await sendOpen(env, msg.chat.id, '💰 Hamyoon — учёт доходов и расходов.\nОтправьте сюда выписку Revolut (PDF, CSV) или Wise (XLSX, CSV), и я добавлю её в приложение.');
    else await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Отправьте выписку Revolut (PDF, CSV) или Wise (XLSX, CSV) файлом — я предложу её импортировать.' });
    return ok();
  }

  const cb = update.callback_query;
  if (cb && cb.from?.id === owner) {
    const [action, key] = (cb.data || '').split(':');
    const askKey = `ask:${key}`;
    const ask = await env.INBOX.get(askKey, 'json');
    const chat = cb.message.chat.id;
    const mid = cb.message.message_id;
    if (!ask) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Этот запрос уже обработан' });
    } else if (action === 'imp') {
      const inbox = (await env.INBOX.get('inbox', 'json')) || [];
      if (!inbox.some((x) => x.file_unique_id === ask.file_unique_id)) inbox.push({ id: key, ...ask, added: Date.now() });
      await env.INBOX.put('inbox', JSON.stringify(inbox));
      await env.INBOX.delete(askKey);
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Добавлено в очередь' });
      await tg(env, 'editMessageText', {
        chat_id: chat, message_id: mid,
        text: `✅ «${ask.name}» добавлен в очередь импорта.\nОткройте Hamyoon — операции появятся в «Ожидают подтверждения».`,
        reply_markup: { inline_keyboard: [[{ text: 'Открыть Hamyoon', web_app: { url: env.WEBAPP_URL } }]] },
      });
    } else {
      await env.INBOX.delete(askKey);
      await tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Отменено' });
      await tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: `✖️ Импорт «${ask.name}» отменён.` });
    }
  }
  return ok();
}

async function askImport(env, msg) {
  const doc = msg.document;
  const name = doc.file_name || 'файл';
  if (!FILE_TYPES.test(name)) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, reply_to_message_id: msg.message_id, text: 'Поддерживаются выписки Revolut (PDF, CSV) и Wise (XLSX, CSV).' });
    return;
  }
  if (doc.file_size > MAX_BYTES) {
    await tg(env, 'sendMessage', { chat_id: msg.chat.id, reply_to_message_id: msg.message_id, text: 'Файл больше 20 МБ — Telegram не даёт боту его скачать.' });
    return;
  }
  const key = String(msg.message_id);
  // callback_data ограничен 64 байтами, поэтому file_id хранится в KV, а в кнопке — только ключ
  await env.INBOX.put(`ask:${key}`, JSON.stringify({ file_id: doc.file_id, file_unique_id: doc.file_unique_id, name }), { expirationTtl: 7 * 24 * 3600 });
  await tg(env, 'sendMessage', {
    chat_id: msg.chat.id, reply_to_message_id: msg.message_id,
    text: `📄 ${name}\nИмпортировать данные из этой выписки?`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Да, импортировать', callback_data: `imp:${key}` }, { text: '✖️ Нет', callback_data: `no:${key}` }]] },
  });
}

const sendOpen = (env, chatId, text) => tg(env, 'sendMessage', {
  chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: 'Открыть Hamyoon', web_app: { url: env.WEBAPP_URL } }]] },
});

/* ---------- API для мини-приложения ---------- */

async function listInbox(env) {
  const inbox = (await env.INBOX.get('inbox', 'json')) || [];
  return { items: inbox.map(({ id, name, added }) => ({ id, name, added })) };
}

async function getFile(env, id, cors) {
  const inbox = (await env.INBOX.get('inbox', 'json')) || [];
  const item = inbox.find((x) => x.id === id);
  if (!item) return json({ error: 'not found' }, 404, cors);
  const info = await tg(env, 'getFile', { file_id: item.file_id });
  const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${info.file_path}`);
  if (!res.ok) return json({ error: 'telegram download failed' }, 502, cors);
  return new Response(res.body, { headers: { ...cors, 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(item.name) } });
}

async function done(request, env) {
  const { id, found = 0, added = 0, processed = 0, error } = await request.json();
  const inbox = (await env.INBOX.get('inbox', 'json')) || [];
  const item = inbox.find((x) => x.id === id);
  await env.INBOX.put('inbox', JSON.stringify(inbox.filter((x) => x.id !== id)));
  if (item) {
    const text = error
      ? `⚠️ «${item.name}» не удалось разобрать: ${error}`
      : `📥 «${item.name}» импортирован: найдено расходов ${found}, новых ${added}${processed ? `, уже обработано ранее ${processed}` : ''}.`;
    await tg(env, 'sendMessage', { chat_id: Number(env.OWNER_ID), text });
  }
  return { ok: true };
}

// Проверка подписи initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
async function withUser(request, env, cors, handler) {
  const auth = request.headers.get('Authorization') || '';
  const initData = auth.startsWith('tma ') ? auth.slice(4) : '';
  const user = await verifyInitData(initData, env.BOT_TOKEN);
  if (!user || user.id !== Number(env.OWNER_ID)) return json({ error: 'unauthorized' }, 401, cors);
  const result = await handler();
  return result instanceof Response ? result : json(result, 200, cors);
}

export async function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), botToken);
  const sign = toHex(await hmac(secret, check));
  if (!timingSafeEqual(sign, hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_TTL) return null;
  try { return JSON.parse(params.get('user')); } catch (e) { return null; }
}

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- Общее ---------- */

async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.APP_ORIGIN, 'http://localhost:8765'];
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : env.APP_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-File-Name',
    Vary: 'Origin',
  };
}

const ok = () => new Response('ok');
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
