'use strict';

/* ================= Telegram ================= */
const tg = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData !== undefined
  ? window.Telegram.WebApp : null;
const inTelegram = !!(tg && tg.initData);
if (tg) {
  tg.ready();
  tg.expand();
  if (inTelegram) document.documentElement.classList.add('tg');
}
const haptic = (kind = 'success') => { try { tg && tg.HapticFeedback.notificationOccurred(kind); } catch (e) {} };
const confirmBox = (text) => new Promise((res) => {
  if (inTelegram && tg.isVersionAtLeast('6.2')) tg.showConfirm(text, res);
  else res(window.confirm(text));
});

/* ================= Доступ =================
 * Приложение открывается только у владельца. Данные и так лежат в CloudStorage
 * конкретного пользователя, это лишь закрывает интерфейс от посторонних.
 */
const OWNER_ID = 800306134;
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const hasAccess = () => isLocal
  || (inTelegram && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.id === OWNER_ID);

/* ================= Справочники ================= */
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Значения хранятся как в Excel, на экране показываются по-русски
const TYPE_LABELS = {
  'salary': 'Зарплата', 'bonus': 'Бонус', 'overtime': 'Переработка', 'weekend recon': 'Выходные',
  'tax refund': 'Возврат налога', 'sertificate': 'Сертификат', 'BD cash': 'BD наличные',
};
const FORM_LABELS = { 'cash': 'Наличные', 'card': 'Карта', 'sertificate': 'Сертификат' };
const SOURCE_LABELS = { 'tax back': 'Возврат налога' };
const label = (map, v) => map[v] || v;

/* ================= Хранилище =================
 * Основная копия — Telegram CloudStorage (привязана к аккаунту, видна на всех устройствах),
 * запасная — localStorage устройства. Значение в CloudStorage до 4096 символов,
 * поэтому данные режутся на части.
 *
 * Запись атомарная: новая версия пишется в свободный слот (a или b), и только потом
 * переключается указатель <prefix>_n = "слот:частей:ревизия". Если приложение закрыли
 * посреди записи, в облаке остаётся прежняя целая версия. При открытии сравниваются
 * ревизии облака и устройства, и берётся более новая.
 */
const CHUNK = 4000;
const LS = 'hamyon_'; // префикс в localStorage: не менять, иначе потеряется копия на устройстве
const cloud = inTelegram && tg.isVersionAtLeast('6.9') ? tg.CloudStorage : null;
const cs = (method, ...args) => new Promise((res, rej) =>
  cloud[method](...args, (err, val) => (err ? rej(err) : res(val))));

const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

// Не-ASCII символы как \uXXXX: длина значения в символах тогда совпадает с длиной в байтах
const ascii = (str) => str.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const PTR = /^([ab]):(\d+):(\d+)$/;

function chunkKeys(prefix, ptr) {
  const m = PTR.exec(ptr || '');
  if (m) return Array.from({ length: +m[2] }, (_, i) => `${prefix}_${m[1]}${i}`);
  return Array.from({ length: parseInt(ptr, 10) || 0 }, (_, i) => prefix + i); // старый формат
}

async function cloudLoad(prefix) {
  const ptr = await cs('getItem', prefix + '_n');
  const keys = chunkKeys(prefix, ptr);
  if (!keys.length) return null;
  const vals = await cs('getItems', keys);
  const data = JSON.parse(keys.map((k) => vals[k] ?? '').join(''));
  const m = PTR.exec(ptr);
  return { data, rev: m ? +m[3] : 0 };
}

async function cloudSave(prefix, data, rev) {
  const ptr = await cs('getItem', prefix + '_n');
  const m = PTR.exec(ptr || '');
  const slot = m && m[1] === 'a' ? 'b' : 'a';
  const str = ascii(JSON.stringify(data));
  const n = Math.max(1, Math.ceil(str.length / CHUNK));
  for (let i = 0; i < n; i++) await cs('setItem', `${prefix}_${slot}${i}`, str.slice(i * CHUNK, (i + 1) * CHUNK));
  await cs('setItem', prefix + '_n', `${slot}:${n}:${rev}`);
  // убрать части прежних версий
  const keep = new Set(chunkKeys(prefix, `${slot}:${n}:${rev}`));
  const own = new RegExp(`^${prefix}(_[ab])?\\d+$`);
  const stale = (await cs('getKeys')).filter((k) => own.test(k) && !keep.has(k));
  if (stale.length) await cs('removeItems', stale).catch(() => {});
}

const Store = {
  status: {},       // prefix -> { ok, error }
  restored: {},     // prefix -> сколько записей восстановлено с устройства
  blocked: new Set(),
  inflight: 0,
  queue: Promise.resolve(),

  readLocal(prefix) {
    try {
      const v = JSON.parse(lsGet(LS + prefix) || 'null');
      if (Array.isArray(v)) return { data: v, rev: 0 };
      return v && Array.isArray(v.data) ? v : null;
    } catch (e) { return null; }
  },
  writeLocal(prefix, data, rev) { lsSet(LS + prefix, JSON.stringify({ rev, data })); },

  async load(prefix) {
    const local = this.readLocal(prefix);
    if (!cloud) return local ? local.data : [];
    let remote;
    try {
      remote = await cloudLoad(prefix);
    } catch (e) {
      console.warn('CloudStorage load failed', e);
      this.status[prefix] = { error: 'не удалось прочитать облако' };
      // без копии на устройстве не перезаписываем облако пустыми данными
      if (!local || !local.data.length) this.blocked.add(prefix);
      return local ? local.data : [];
    }
    if (!remote) {
      if (local && local.data.length) this.save(prefix, local.data);
      return local ? local.data : [];
    }
    if (local && local.rev > remote.rev) {
      // облако отстало: последняя запись не дошла — догоняем копией с устройства
      this.restored[prefix] = local.data.filter((r) => !remote.data.some((x) => x[0] === r[0])).length;
      this.save(prefix, local.data);
      return local.data;
    }
    if (local && !local.rev && !remote.rev) {
      // старый формат без ревизий: добавляем записи, которые есть только на устройстве
      const ids = new Set(remote.data.map((r) => r[0]));
      const extra = local.data.filter((r) => !ids.has(r[0]));
      if (extra.length) {
        const merged = [...remote.data, ...extra];
        this.restored[prefix] = extra.length;
        this.save(prefix, merged);
        return merged;
      }
    }
    this.writeLocal(prefix, remote.data, remote.rev);
    return remote.data;
  },

  save(prefix, data) {
    const rev = Date.now();
    this.writeLocal(prefix, data, rev);
    if (!cloud || this.blocked.has(prefix)) return Promise.resolve();
    // пока идёт запись, Telegram спросит подтверждение перед закрытием
    if (this.inflight++ === 0 && tg.isVersionAtLeast('6.2')) tg.enableClosingConfirmation();
    this.queue = this.queue
      .then(() => cloudSave(prefix, data, rev))
      .then(() => { this.status[prefix] = { ok: true }; })
      .catch((e) => {
        console.error(e);
        this.status[prefix] = { error: String((e && e.message) || e) };
        toast('Не удалось сохранить в облако Telegram. Копия осталась на устройстве');
      })
      .finally(() => {
        if (--this.inflight === 0 && tg.isVersionAtLeast('6.2')) tg.disableClosingConfirmation();
        if (currentView === 'more') renderMore();
      });
    return this.queue;
  },

  summary() {
    if (!cloud) return 'Открыто вне Telegram — данные хранятся только в этом браузере.';
    const errors = Object.entries(this.status).filter(([, v]) => v.error);
    if (this.blocked.size) return '⚠️ Облако Telegram сейчас недоступно, изменения пока не сохраняются. Перезапустите приложение.';
    if (errors.length) return `⚠️ Последнее сохранение в облако не прошло (${errors[0][1].error}). Копия на устройстве цела, при следующем открытии приложение досохранит её.`;
    if (this.inflight) return 'Сохраняю в облако Telegram…';
    return '✓ Данные сохранены в облаке Telegram и доступны на всех ваших устройствах.';
  },
};

/* ================= Модель =================
 * Доход:  [id, 'YYYY-MM-DD', amount, cur, type, form, source]
 * Расход: [id, 'YYYY-MM-DD', amount, cur, note]
 */
let incomes = [];
let expenses = [];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const inc = (r) => ({ id: r[0], date: r[1], amount: r[2], cur: r[3], type: r[4], form: r[5], source: r[6] });
const exp = (r) => ({ id: r[0], date: r[1], amount: r[2], cur: r[3], note: r[4] });
const ym = (d) => d.slice(0, 7);
const year = (d) => +d.slice(0, 4);
const sortByDateDesc = (a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0);
const sum = (arr) => Math.round(arr.reduce((s, r) => s + r[2], 0) * 100) / 100;

function mainCurrency() {
  const cnt = {};
  incomes.forEach((r) => { cnt[r[3]] = (cnt[r[3]] || 0) + 1; });
  return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0] || 'EUR';
}

function fmt(n, cur) {
  cur = cur || mainCurrency();
  try {
    return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
  } catch (e) {
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ' + cur;
  }
}
const fmtShort = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace('.0', '') + 'k' : String(Math.round(n)));
const fmtDate = (d) => { const [y, m, dd] = d.split('-'); return `${+dd} ${MONTHS_SHORT[+m - 1]} ${y}`; };
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s) => document.querySelector(s);

// Доходы только в основной валюте — для всех итогов
const mainIncomes = () => { const c = mainCurrency(); return incomes.filter((r) => r[3] === c); };
const years = () => [...new Set(incomes.map((r) => year(r[1])))].sort((a, b) => a - b);

// Как в Excel: среднее = сумма за год / число месяцев, в которых был доход
function yearStats(y) {
  const rows = mainIncomes().filter((r) => year(r[1]) === y);
  const months = new Set(rows.map((r) => ym(r[1]))).size;
  const total = sum(rows);
  return { total, months, avg: months ? total / months : 0 };
}

/* ================= Навигация ================= */
let currentView = 'home';
let editingId = null;

function show(view) {
  currentView = view;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  if (tg && tg.BackButton) (view === 'home' ? tg.BackButton.hide() : tg.BackButton.show());
  if (view === 'add' && !editingId) resetForm();
  render();
  window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'add') editingId = null;
  show(b.dataset.view);
}));
if (tg && tg.BackButton) tg.BackButton.onClick(() => { editingId = null; show('home'); });

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ================= Обзор ================= */
let chart;
let chartRange = '12';

function renderHome() {
  const rows = mainIncomes();
  const now = today();
  const y = year(now);
  const ys = yearStats(y);
  $('#grand-total').textContent = fmt(sum(rows));
  $('#year-total').textContent = fmt(ys.total);
  $('#year-avg').textContent = fmt(Math.round(ys.avg));
  $('#month-total').textContent = fmt(sum(rows.filter((r) => ym(r[1]) === ym(now))));

  const recent = [...incomes].sort(sortByDateDesc).slice(0, 5);
  $('#recent').innerHTML = recent.length ? recent.map(incomeItem).join('')
    : `<div class="empty-state">Пока нет записей.<br>Загрузите свой Excel или добавьте доход через «＋».</div>
       <button class="btn primary" onclick="document.getElementById('file-xlsx').click()">Импорт из Excel (.xlsx)</button>`;
  renderChart();
}

function monthSeries() {
  const rows = mainIncomes();
  if (!rows.length) return [];
  const byMonth = {};
  rows.forEach((r) => { byMonth[ym(r[1])] = (byMonth[ym(r[1])] || 0) + r[2]; });
  const keys = Object.keys(byMonth).sort();
  // непрерывный ряд месяцев, включая месяцы без дохода
  let [cy, cm] = keys[0].split('-').map(Number);
  const [ey, em] = (ym(today()) > keys[keys.length - 1] ? ym(today()) : keys[keys.length - 1]).split('-').map(Number);
  const out = [];
  while (cy < ey || (cy === ey && cm <= em)) {
    const k = `${cy}-${String(cm).padStart(2, '0')}`;
    out.push({ k, label: `${MONTHS_SHORT[cm - 1]} ${String(cy).slice(2)}`, v: Math.round((byMonth[k] || 0) * 100) / 100 });
    if (++cm > 12) { cm = 1; cy++; }
  }
  return chartRange === 'all' ? out : out.slice(-12);
}

function renderChart() {
  if (!window.Chart) return;
  const data = monthSeries();
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue('--accent').trim() || '#2481cc';
  const hint = css.getPropertyValue('--hint').trim() || '#8e8e93';
  const cfg = {
    type: 'line',
    data: {
      labels: data.map((d) => d.label),
      datasets: [{
        data: data.map((d) => d.v), borderColor: accent, backgroundColor: accent + '22',
        fill: true, tension: 0.3, pointRadius: 3, pointBackgroundColor: accent, borderWidth: 2,
      }],
    },
    options: {
      maintainAspectRatio: false, animation: { duration: 300 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => fmt(c.parsed.y) } } },
      scales: {
        x: { ticks: { color: hint, maxRotation: 0, autoSkip: true, font: { size: 10 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { color: hint, callback: fmtShort, font: { size: 10 } }, grid: { color: hint + '22' } },
      },
    },
  };
  if (chart) chart.destroy();
  chart = new Chart($('#chart-monthly'), cfg);
}
document.querySelectorAll('#chart-range button').forEach((b) => b.addEventListener('click', () => {
  chartRange = b.dataset.range;
  document.querySelectorAll('#chart-range button').forEach((x) => x.classList.toggle('on', x === b));
  renderChart();
}));

/* ================= История ================= */
let historyYear = 'all';

function incomeItem(r) {
  const x = inc(r);
  return `<div class="item" data-edit="${esc(x.id)}">
    <div><div class="t">${esc(label(TYPE_LABELS, x.type))}</div>
    <div class="s">${fmtDate(x.date)} · ${esc(label(SOURCE_LABELS, x.source))} · ${esc(label(FORM_LABELS, x.form))}</div></div>
    <div class="a">${fmt(x.amount, x.cur)}</div></div>`;
}

function renderHistory() {
  const ys = years().reverse();
  $('#history-years').innerHTML = ['all', ...ys].map((y) =>
    `<button data-y="${y}" class="${String(historyYear) === String(y) ? 'on' : ''}">${y === 'all' ? 'Все' : y}</button>`).join('');
  const q = $('#history-search').value.trim().toLowerCase();
  const rows = [...incomes].sort(sortByDateDesc).filter((r) => {
    if (historyYear !== 'all' && year(r[1]) !== +historyYear) return false;
    if (!q) return true;
    const x = inc(r);
    return [x.type, x.source, x.form, label(TYPE_LABELS, x.type), label(FORM_LABELS, x.form), label(SOURCE_LABELS, x.source), String(x.amount)]
      .some((s) => String(s).toLowerCase().includes(q));
  });
  const groups = {};
  rows.forEach((r) => (groups[ym(r[1])] = groups[ym(r[1])] || []).push(r));
  $('#history-list').innerHTML = Object.keys(groups).map((k) => {
    const [y, m] = k.split('-');
    const g = groups[k];
    return `<div class="group"><div class="group-head"><span>${MONTHS_RU[+m - 1]} ${y}</span><span>${fmt(sum(g.filter((r) => r[3] === mainCurrency())))}</span></div>
      ${g.map(incomeItem).join('')}</div>`;
  }).join('') || '<div class="empty-state">Ничего не найдено</div>';
}
$('#history-years').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  historyYear = b.dataset.y; renderHistory();
});
$('#history-search').addEventListener('input', renderHistory);
document.addEventListener('click', (e) => {
  const it = e.target.closest('[data-edit]'); if (!it) return;
  openEdit(it.dataset.edit);
});

/* ================= Форма дохода ================= */
const form = $('#income-form');
let formValue = 'cash';

function optionsFor(idx, defaults) {
  const cnt = {};
  defaults.forEach((d) => { cnt[d] = 0; });
  incomes.forEach((r) => { cnt[r[idx]] = (cnt[r[idx]] || 0) + 1; });
  return Object.keys(cnt).filter(Boolean).sort((a, b) => cnt[b] - cnt[a]);
}

function fillSelect(sel, values, labels, selected) {
  sel.innerHTML = values.map((v) => `<option value="${esc(v)}">${esc(label(labels, v))}</option>`).join('')
    + '<option value="__other">Другое…</option>';
  sel.value = values.includes(selected) ? selected : (selected ? '__other' : values[0] || '__other');
  const other = form.elements[sel.name + '_other'];
  other.classList.toggle('hidden', sel.value !== '__other');
  other.value = sel.value === '__other' ? (selected || '') : '';
}

function renderFormSeg(selected) {
  formValue = selected;
  const vals = optionsFor(5, ['cash', 'card']);
  if (!vals.includes(selected)) vals.push(selected);
  $('#form-seg').innerHTML = vals.map((v) =>
    `<button type="button" data-v="${esc(v)}" class="${v === selected ? 'on' : ''}">${esc(label(FORM_LABELS, v))}</button>`).join('');
}
$('#form-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  renderFormSeg(b.dataset.v);
});
form.querySelectorAll('select[data-other]').forEach((s) => s.addEventListener('change', () => {
  const other = form.elements[s.name + '_other'];
  other.classList.toggle('hidden', s.value !== '__other');
  if (s.value === '__other') other.focus();
}));

function fillForm(x) {
  form.elements.amount.value = x.amount ?? '';
  form.elements.cur.value = x.cur || mainCurrency();
  form.elements.date.value = x.date || today();
  fillSelect(form.elements.type, optionsFor(4, Object.keys(TYPE_LABELS)), TYPE_LABELS, x.type);
  fillSelect(form.elements.source, optionsFor(6, []), SOURCE_LABELS, x.source);
  renderFormSeg(x.form || 'cash');
}

function resetForm() {
  editingId = null;
  $('#form-title').textContent = 'Новый доход';
  $('#btn-delete').classList.add('hidden');
  $('#btn-cancel').classList.add('hidden');
  // по умолчанию: самый частый тип, источник и валюта — из последней записи
  const last = [...incomes].sort(sortByDateDesc)[0];
  fillForm(last ? { cur: last[3], form: last[5], source: last[6] } : {});
}

function openEdit(id) {
  const r = incomes.find((x) => x[0] === id); if (!r) return;
  editingId = id;
  show('add');
  $('#form-title').textContent = 'Редактирование';
  $('#btn-delete').classList.remove('hidden');
  $('#btn-cancel').classList.remove('hidden');
  fillForm(inc(r));
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = form.elements;
  const pick = (name) => (f[name].value === '__other' ? f[name + '_other'].value.trim() : f[name].value);
  const amount = Math.round(parseFloat(String(f.amount.value).replace(',', '.')) * 100) / 100;
  const type = pick('type');
  const source = pick('source');
  if (!(amount > 0)) return toast('Введите сумму');
  if (!type) return toast('Укажите тип дохода');
  if (!source) return toast('Укажите источник');
  const rec = [editingId || uid(), f.date.value, amount, f.cur.value.trim().toUpperCase() || 'EUR', type, formValue, source];
  if (editingId) incomes = incomes.map((r) => (r[0] === editingId ? rec : r));
  else incomes.push(rec);
  Store.save('inc', incomes);
  haptic();
  toast(editingId ? 'Изменено' : 'Добавлено: ' + fmt(amount, rec[3]));
  editingId = null;
  show('home');
});

$('#btn-delete').addEventListener('click', async () => {
  if (!editingId || !(await confirmBox('Удалить эту запись?'))) return;
  incomes = incomes.filter((r) => r[0] !== editingId);
  Store.save('inc', incomes);
  haptic('warning');
  toast('Удалено');
  editingId = null;
  show('history');
});
$('#btn-cancel').addEventListener('click', () => { editingId = null; show('history'); });

/* ================= Отчёты ================= */
let calInit = false;
let structBy = 'type';

function yearOptions(sel, list, value) {
  sel.innerHTML = list.map((y) => `<option value="${y}">${y}</option>`).join('');
  sel.value = list.includes(+value) ? value : list[list.length - 1];
}

function renderReports() {
  const ys = years();
  // Таблица по годам (лист "table": сумма за год, среднее, итог)
  let total = 0;
  $('#years-table').innerHTML = '<tr><th>Год</th><th>Сумма</th><th>Среднее / мес</th></tr>'
    + ys.map((y) => { const s = yearStats(y); total += s.total;
      return `<tr><td>${y}</td><td>${fmt(s.total)}</td><td>${fmt(Math.round(s.avg))}</td></tr>`; }).join('')
    + `<tr class="total"><td>Итого</td><td>${fmt(Math.round(total * 100) / 100)}</td><td></td></tr>`;

  // Календарь месяца
  const now = today();
  if (!calInit) {
    $('#cal-month').innerHTML = MONTHS_RU.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
    $('#cal-month').value = +now.slice(5, 7);
    $('#period-to').value = now;
    const from = new Date(now); from.setMonth(from.getMonth() - 3);
    $('#period-from').value = from.toISOString().slice(0, 10);
    calInit = true;
  }
  const yList = ys.includes(year(now)) ? ys : [...ys, year(now)];
  yearOptions($('#cal-year'), yList, $('#cal-year').value || year(now));
  renderCalendar();
  renderPeriod();
  renderStruct();
}

function renderCalendar() {
  const y = +$('#cal-year').value;
  const m = +$('#cal-month').value;
  const key = `${y}-${String(m).padStart(2, '0')}`;
  const byDay = {};
  mainIncomes().filter((r) => ym(r[1]) === key).forEach((r) => {
    const d = +r[1].slice(8, 10); byDay[d] = (byDay[d] || 0) + r[2];
  });
  const max = Math.max(0, ...Object.values(byDay));
  const total = Object.values(byDay).reduce((a, b) => a + b, 0);
  $('#cal-total').innerHTML = `Итого за ${MONTHS_RU[m - 1].toLowerCase()}: <b>${fmt(Math.round(total * 100) / 100)}</b>`;
  const days = new Date(y, m, 0).getDate();
  const offset = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  let html = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => `<div class="wd">${d}</div>`).join('');
  html += '<div class="d empty"></div>'.repeat(offset);
  for (let d = 1; d <= days; d++) {
    const v = byDay[d];
    const i = v ? 0.25 + 0.75 * (v / max) : 0;
    html += v
      ? `<div class="d has ${i > 0.55 ? 'dark' : ''}" style="--i:${i.toFixed(2)}" title="${fmt(v)}"><span class="n">${d}</span><span class="v">${fmtShort(v)}</span></div>`
      : `<div class="d"><span class="n">${d}</span></div>`;
  }
  $('#calendar').innerHTML = html;
}
['#cal-year', '#cal-month'].forEach((s) => $(s).addEventListener('change', renderCalendar));

// Лист "expenses": доход за период (здесь — честное сравнение дат включительно)
function renderPeriod() {
  const from = $('#period-from').value;
  const to = $('#period-to').value;
  if (!from || !to) { $('#period-result').innerHTML = ''; return; }
  const c = mainCurrency();
  const inRange = (r) => r[1] >= from && r[1] <= to && r[3] === c;
  const incRows = incomes.filter(inRange);
  const expRows = expenses.filter(inRange);
  const i = sum(incRows);
  const x = sum(expRows);
  const net = Math.round((i - x) * 100) / 100;
  $('#period-result').innerHTML = `
    <div class="stat"><span class="muted">Доход</span><b>${fmt(i)}</b></div>
    <div class="stat"><span class="muted">Расходы</span><b>${fmt(x)}</b></div>
    <div class="stat"><span class="muted">Остаток</span><b class="${net < 0 ? 'neg' : ''}">${fmt(net)}</b></div>
    <div class="stat"><span class="muted">Поступлений</span><b>${incRows.length}</b></div>`;
}
['#period-from', '#period-to'].forEach((s) => $(s).addEventListener('change', renderPeriod));

// Можно выбрать несколько лет: суммы складываются, полоса делится по годам
const YEAR_COLORS = ['#2481cc', '#2eb85c', '#f5a623', '#7b61ff', '#e5484d', '#00a3a3', '#d6409f', '#8d8d8d'];
let structYears = null;

function renderStruct() {
  const all = years();
  if (!structYears) structYears = new Set([all.includes(year(today())) ? year(today()) : all[all.length - 1]]);
  const color = (y) => YEAR_COLORS[all.indexOf(y) % YEAR_COLORS.length];
  const allOn = all.length > 1 && all.every((y) => structYears.has(y));
  $('#struct-years').innerHTML = (all.length > 1 ? `<button data-y="all" class="${allOn ? 'on' : ''}">Все</button>` : '')
    + all.map((y) => `<button data-y="${y}" class="${structYears.has(y) ? 'on' : ''}">${structYears.size > 1 && structYears.has(y)
      ? `<i class="dot" style="background:${color(y)}"></i>` : ''}${y}</button>`).join('');

  const sel = all.filter((y) => structYears.has(y));
  const multi = sel.length > 1;
  const idx = { type: 4, source: 6, form: 5 }[structBy];
  const labels = { type: TYPE_LABELS, source: SOURCE_LABELS, form: FORM_LABELS }[structBy];
  const agg = {};
  mainIncomes().filter((r) => structYears.has(year(r[1]))).forEach((r) => {
    const a = agg[r[idx]] = agg[r[idx]] || { total: 0, by: {} };
    a.total += r[2];
    a.by[year(r[1])] = (a.by[year(r[1])] || 0) + r[2];
  });
  const entries = Object.entries(agg).sort((a, b) => b[1].total - a[1].total);
  const total = entries.reduce((s, e) => s + e[1].total, 0);
  const max = entries.length ? entries[0][1].total : 1;
  $('#struct-bars').innerHTML = entries.map(([k, v]) => `
    <div class="bar"><div class="bar-top"><span>${esc(label(labels, k))}</span>
      <span>${fmt(Math.round(v.total * 100) / 100)} <span class="muted">· ${Math.round((v.total / total) * 100)}%</span></span></div>
      <div class="bar-track">${multi
        ? `<div class="bar-stack" style="width:${(v.total / max) * 100}%">${sel.filter((y) => v.by[y]).map((y) =>
          `<div style="flex:${v.by[y]};background:${color(y)}" title="${y}: ${fmt(Math.round(v.by[y] * 100) / 100)}"></div>`).join('')}</div>`
        : `<div class="bar-fill" style="width:${(v.total / max) * 100}%"></div>`}</div></div>`).join('')
    || `<div class="empty-state">Нет данных за ${multi ? 'выбранные годы' : 'этот год'}</div>`;
}
$('#struct-years').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const all = years();
  if (b.dataset.y === 'all') {
    structYears = all.every((y) => structYears.has(y)) ? new Set([all[all.length - 1]]) : new Set(all);
  } else {
    const y = +b.dataset.y;
    if (structYears.has(y)) { if (structYears.size > 1) structYears.delete(y); } else structYears.add(y);
  }
  renderStruct();
});
document.querySelectorAll('#struct-by button').forEach((b) => b.addEventListener('click', () => {
  structBy = b.dataset.by;
  document.querySelectorAll('#struct-by button').forEach((x) => x.classList.toggle('on', x === b));
  renderStruct();
}));

/* ================= Расходы ================= */
const expForm = $('#expense-form');

// Лента расходов: по умолчанию последние 5
const EXP_FEED = 5;
let expShowAll = false;
$('#exp-more').addEventListener('click', () => { expShowAll = !expShowAll; renderMore(); });

function renderMore() {
  if (!expForm.elements.date.value) expForm.elements.date.value = today();
  const ys = [...new Set(expenses.map((r) => year(r[1])))].sort((a, b) => a - b);
  const now = year(today());
  if (!ys.includes(now)) ys.push(now);
  yearOptions($('#exp-year'), ys, $('#exp-year').value || now);
  const y = +$('#exp-year').value;
  const rows = expenses.filter((r) => year(r[1]) === y).sort(sortByDateDesc);
  const shown = expShowAll ? rows : rows.slice(0, EXP_FEED);
  const monthTotal = (k) => sum(rows.filter((r) => ym(r[1]) === k));
  const groups = {};
  shown.forEach((r) => (groups[ym(r[1])] = groups[ym(r[1])] || []).push(r));
  $('#exp-more').classList.toggle('hidden', rows.length <= EXP_FEED);
  $('#exp-more').textContent = expShowAll ? 'Свернуть' : `Показать все (${rows.length})`;
  $('#expense-list').innerHTML = Object.keys(groups).map((k) => {
    const g = groups[k];
    return `<div class="group-head"><span>${MONTHS_RU[+k.slice(5) - 1]}</span><span>${fmt(monthTotal(k))}</span></div>`
      + g.map((r) => { const x = exp(r);
        return `<div class="item pressable" data-detail="exp:${esc(x.id)}"><div><div class="t">${esc(x.note || 'Расход')}</div><div class="s">${fmtDate(x.date)}</div></div>
          <div style="display:flex;align-items:center;gap:6px">${amountHtml(x.amount, r[7], x.cur)}<button class="x" data-del-exp="${esc(x.id)}">×</button></div></div>`;
      }).join('');
  }).join('') || '<div class="empty-state">Расходов за этот год нет</div>';

  const cloudInfo = Store.summary();
  $('#storage-info').textContent = `${cloudInfo} Доходов: ${incomes.length}, расходов: ${expenses.length}. Приложение загружено с ${location.host}.`;
}
$('#exp-year').addEventListener('change', () => { expShowAll = false; renderMore(); });

expForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = expForm.elements;
  const amount = Math.round(parseFloat(String(f.amount.value).replace(',', '.')) * 100) / 100;
  if (!(amount > 0)) return toast('Введите сумму');
  expenses.push([uid(), f.date.value, amount, mainCurrency(), f.note.value.trim()]);
  Store.save('exp', expenses);
  f.amount.value = ''; f.note.value = '';
  haptic();
  toast('Расход добавлен');
  renderMore();
});
$('#expense-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-exp]'); if (!b) return;
  e.stopPropagation();
  if (!(await confirmBox('Удалить расход?'))) return;
  expenses = expenses.filter((r) => r[0] !== b.dataset.delExp);
  Store.save('exp', expenses);
  renderMore();
});

/* ================= Подробности операции =================
 * Удержание строки 1,5 секунды открывает окно со всеми данными.
 * Сумму можно изменить: в расчётах участвует новая, исходная хранится отдельно.
 */
const HOLD_MS = 1500;
let sheetData = null;

// rec[2] — сумма для расчётов, rec[origIdx] — исходная сумма (пока не вернули её обратно)
function applyAmount(rec, origIdx, value) {
  if (rec[origIdx] == null) rec[origIdx] = rec[2];
  rec[2] = value;
  if (rec[origIdx] === value) rec[origIdx] = null;
}

const amountHtml = (amount, orig, cur) => `<div class="a neg">−${fmt(amount, cur)}${orig != null
  ? `<s class="orig">−${fmt(orig, cur)}</s>` : ''}</div>`;

function expenseDetail(id) {
  const r = expenses.find((x) => x[0] === id);
  if (!r) return null;
  const x = exp(r);
  return {
    title: x.note || 'Расход', amount: x.amount, orig: r[7] ?? null, cur: x.cur, pendingId: null,
    ref: { type: 'exp', id },
    fields: [['Дата', fmtDate(x.date)], ['Статус', r[5] ? 'Подтверждён из выписки' : 'Добавлен вручную'],
      ...(r[6] && r[6].length ? r[6] : [['Комментарий', x.note || '']])],
  };
}

function detailByRef(ref) {
  return ref.type === 'pend' ? Bank.detailOf('pend', ref.id) : expenseDetail(ref.id);
}

function openSheet(d) {
  sheetData = d;
  $('#sheet-title').textContent = d.title;
  $('#sheet-amount').textContent = (d.sign ?? '−') + fmt(d.amount, d.cur);
  $('#sheet-amount').classList.toggle('plain', d.sign === '');
  $('#sheet-orig').classList.toggle('hidden', d.orig == null);
  if (d.orig != null) $('#sheet-orig-val').textContent = (d.sign ?? '−') + fmt(d.orig, d.cur);
  $('#sheet-edit').classList.toggle('hidden', !d.ref);
  $('#sheet-edit').textContent = '✎ Изменить сумму';
  $('#sheet-editbox').classList.add('hidden');
  $('#sheet-fields').innerHTML = d.fields.filter(([, v]) => v).map(([k, v]) =>
    `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('#sheet-decide').classList.toggle('hidden', !d.pendingId);
  $('#sheet-debt').classList.toggle('hidden', !d.pendingId);
  $('#sheet').classList.remove('hidden');
  requestAnimationFrame(() => $('#sheet').classList.add('open'));
}

function closeSheet() {
  sheetData = null;
  $('#sheet').classList.remove('open');
  setTimeout(() => $('#sheet').classList.add('hidden'), 200);
}

function saveAmount(value) {
  const { ref } = sheetData;
  if (ref.type === 'pend') Bank.setAmount(ref.id, value);
  else {
    const r = expenses.find((x) => x[0] === ref.id);
    applyAmount(r, 7, value);
    Store.save('exp', expenses);
  }
  haptic();
  render();
  openSheet(detailByRef(ref));
}

$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') closeSheet(); });
$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet-edit').addEventListener('click', () => {
  const box = $('#sheet-editbox');
  const opening = box.classList.contains('hidden');
  box.classList.toggle('hidden', !opening);
  $('#sheet-edit').textContent = opening ? 'Отмена' : '✎ Изменить сумму';
  if (opening) { $('#sheet-input').value = sheetData.amount; $('#sheet-input').focus(); $('#sheet-input').select(); }
});
$('#sheet-editbox').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = Math.round(parseFloat(String($('#sheet-input').value).replace(',', '.')) * 100) / 100;
  if (!(v >= 0)) return toast('Введите сумму');
  saveAmount(v);
  toast('Сумма изменена');
});
$('#sheet-restore').addEventListener('click', () => {
  if (sheetData.orig == null) return;
  saveAmount(sheetData.orig);
  toast('Возвращена сумма из выписки');
});
$('#sheet-ok').addEventListener('click', () => { const id = sheetData.pendingId; closeSheet(); Bank.decide(id, true); });
$('#sheet-no').addEventListener('click', () => { const id = sheetData.pendingId; closeSheet(); Bank.decide(id, false); });
$('#sheet-debt').addEventListener('click', () => { const id = sheetData.pendingId; closeSheet(); Bank.toDebt(id); });

// Удержание: строка заполняется подсветкой, через 1,5 секунды открывается окно
(function setupLongPress() {
  let timer = null; let el = null; let sx = 0; let sy = 0;
  const cancel = () => { clearTimeout(timer); if (el) el.classList.remove('pressing'); el = null; };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest('.pressable[data-detail]');
    if (!t || e.target.closest('button')) return;
    cancel();
    el = t; sx = e.clientX; sy = e.clientY;
    t.classList.add('pressing');
    timer = setTimeout(() => {
      const [kind, id] = el.dataset.detail.split(':');
      cancel();
      // обработанная операция показывается как её подтверждённый расход, чтобы её можно было править
      const done = kind === 'proc' && expenses.find((x) => x[5] === Bank.keyOf(id));
      const debt = kind === 'proc' && Debts.byKey(Bank.keyOf(id));
      const d = kind === 'exp' ? expenseDetail(id) : kind === 'debt' ? Debts.detail(id)
        : done ? expenseDetail(done[0]) : debt ? Debts.detail(debt[0]) : Bank.detailOf(kind, id);
      if (!d) return;
      try { tg && tg.HapticFeedback.impactOccurred('medium'); } catch (err) {}
      openSheet(d);
    }, HOLD_MS);
  });
  document.addEventListener('pointermove', (e) => { if (el && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) cancel(); });
  ['pointerup', 'pointercancel'].forEach((ev) => document.addEventListener(ev, cancel));
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('.pressable')) e.preventDefault(); });
})();

/* ================= Скачать поступления =================
 * Excel в формате листа data из income.report.xlsx: заголовки с B2,
 * дата разбита на «day N» / месяц / год. Файл можно снова загрузить через импорт.
 */
async function downloadIncomes() {
  const rows = [[], [null, 'data: day', 'data: month', 'data: year', 'amount', 'curriency', 'type', 'monetary form', 'income type']];
  [...incomes].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).forEach((r) => {
    const [y, m, d] = r[1].split('-');
    rows.push([null, `day ${+d}`, MONTHS_EN[+m - 1], +y, r[2], r[3], r[4], r[5], r[6]]);
  });
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [2, 9, 11, 7, 9, 9, 13, 14, 12].map((wch) => ({ wch }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'data');
  const name = `hamyoon-data-${today()}.xlsx`;
  const file = new File([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], name,
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  // на телефоне — системное меню «Поделиться / Сохранить в файлы», иначе обычная загрузка
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast(`Скачивается ${name}`);
}
window.hamyonBuildIncomesFile = downloadIncomes; // для отладки
$('#btn-download').addEventListener('click', () => downloadIncomes().catch((e) => toast('Не удалось скачать: ' + e.message)));

/* ================= Импорт / экспорт ================= */
const recKey = (r) => [r[1], r[2], r[3], r[4] ?? '', r[5] ?? '', r[6] ?? ''].join('|');

function mergeInto(target, rows) {
  const seen = new Set(target.map(recKey));
  let added = 0;
  rows.forEach((r) => { if (!seen.has(recKey(r))) { target.push(r); seen.add(recKey(r)); added++; } });
  return added;
}

// Разбор книги в формате income.report.xlsx
function parseWorkbook(wb) {
  const out = { incomes: [], expenses: [] };
  const ws = wb.Sheets.data || wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const h = rows.findIndex((r) => r.some((c) => norm(c) === 'amount'));
  if (h < 0) throw new Error('Не найден лист с колонкой «amount»');
  const col = (...names) => rows[h].findIndex((c) => names.includes(norm(c)));
  const C = {
    day: col('data: day', 'day'), month: col('data: month', 'month'), year: col('data: year', 'year'),
    amount: col('amount'), cur: col('curriency', 'currency'), type: col('type'),
    form: col('monetary form', 'form'), source: col('income type', 'source'),
  };
  const str = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  for (const r of rows.slice(h + 1)) {
    const amount = +r[C.amount];
    const y = +r[C.year];
    const m = MONTHS_EN.indexOf(norm(r[C.month])) + 1;
    const d = parseInt(String(r[C.day] ?? '').replace(/\D+/g, ''), 10);
    if (!(amount > 0) || !y || !m || !d) continue;
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    out.incomes.push([uid(), date, Math.round(amount * 100) / 100, (str(r, C.cur) || 'EUR').toUpperCase(),
      str(r, C.type) || 'salary', str(r, C.form) || 'cash', str(r, C.source) || '—']);
  }
  // Лист "BD expenses": строки — месяцы, колонки — годы
  const be = wb.Sheets['BD expenses'];
  if (be) {
    const g = XLSX.utils.sheet_to_json(be, { header: 1, defval: null });
    const head = g[0] || [];
    g.slice(1).forEach((r) => {
      const m = MONTHS_EN.indexOf(norm(r[0])) + 1;
      if (!m) return;
      head.forEach((y, i) => {
        if (i && +y && +r[i] > 0) out.expenses.push([uid(), `${+y}-${String(m).padStart(2, '0')}-01`, +r[i], 'EUR', 'BD expenses']);
      });
    });
  }
  return out;
}

async function importXlsxBuffer(buf) {
  const data = parseWorkbook(XLSX.read(buf, { type: 'array' }));
  const a = mergeInto(incomes, data.incomes);
  const b = mergeInto(expenses, data.expenses);
  await Promise.all([Store.save('inc', incomes), Store.save('exp', expenses)]);
  haptic();
  toast(`Импортировано: доходов ${a}, расходов ${b}`);
  render();
  return { incomes: a, expenses: b };
}
window.hamyonImportXlsx = importXlsxBuffer; // для отладки

$('#file-xlsx').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try { await importXlsxBuffer(await file.arrayBuffer()); } catch (err) { toast('Ошибка импорта: ' + err.message); }
  e.target.value = '';
});

let jsonMode = 'export';
function openJson(mode) {
  jsonMode = mode;
  $('#json-box').classList.remove('hidden');
  const ta = $('#json-text');
  if (mode === 'export') {
    ta.value = JSON.stringify({ app: 'hamyon', v: 1, incomes, expenses });
    $('#json-action').textContent = 'Скопировать';
    ta.select();
  } else {
    ta.value = '';
    ta.placeholder = 'Вставьте сюда JSON резервной копии';
    $('#json-action').textContent = 'Восстановить';
    ta.focus();
  }
  $('#json-box').scrollIntoView({ behavior: 'smooth' });
}
$('#btn-export').addEventListener('click', () => openJson('export'));
$('#btn-import-json').addEventListener('click', () => openJson('import'));
$('#json-close').addEventListener('click', () => $('#json-box').classList.add('hidden'));
$('#json-action').addEventListener('click', async () => {
  const ta = $('#json-text');
  if (jsonMode === 'export') {
    try { await navigator.clipboard.writeText(ta.value); toast('Скопировано'); }
    catch (e) { ta.select(); document.execCommand('copy'); toast('Скопировано'); }
    return;
  }
  try {
    const data = JSON.parse(ta.value);
    const a = mergeInto(incomes, data.incomes || []);
    const b = mergeInto(expenses, data.expenses || []);
    await Promise.all([Store.save('inc', incomes), Store.save('exp', expenses)]);
    toast(`Восстановлено: доходов ${a}, расходов ${b}`);
    $('#json-box').classList.add('hidden');
    render();
  } catch (e) { toast('Неверный JSON'); }
});

$('#btn-clear').addEventListener('click', async () => {
  if (!(await confirmBox('Удалить ВСЕ доходы и расходы? Сначала сделайте экспорт.'))) return;
  incomes = []; expenses = [];
  await Promise.all([Store.save('inc', incomes), Store.save('exp', expenses)]);
  toast('Данные удалены');
  render();
});

/* ================= Запуск ================= */
function render() {
  ({ home: renderHome, history: renderHistory, reports: renderReports, more: renderMore, add: () => {} })[currentView]();
  Bank.render();
  Debts.render();
}

(async function init() {
  if (!hasAccess()) {
    document.querySelector('.tabbar').remove();
    $('#app').innerHTML = '<div class="empty-state" style="padding-top:35vh">🔒 Нет доступа</div>';
    return;
  }
  [incomes, expenses] = await Promise.all([Store.load('inc'), Store.load('exp'), Bank.load(), Debts.load()]);
  Bank.setup();
  Debts.setup();
  resetForm();
  render();
  const back = Object.values(Store.restored).reduce((a, b) => a + b, 0);
  if (back) toast(`Восстановлено записей с устройства: ${back}`);
})();
