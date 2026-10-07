'use strict';

/* ================= Выписки банков =================
 * Два обработчика: Revolut (PDF, CSV) и Wise (XLSX, CSV).
 * Найденные списания попадают в список ожидания. Подтверждённые записываются
 * в расходы по дате операции вместе с ключом операции, отклонённые просто
 * убираются из списка и при повторной загрузке появятся снова.
 * Операция считается обработанной, пока в расходах есть запись с её ключом.
 */
const Bank = (() => {
  const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
  let pending = [];   // [id, date, amount, cur, note, bank, kind, key, details, сумма по выписке, если изменена]
  let processed = []; // уже записанные операции из последней загруженной выписки

  const KIND_LABELS = { card: 'Покупка', transfer: 'Перевод', fee: 'Комиссия', cash: 'Снятие наличных', other: 'Списание' };
  const pad = (n) => String(n).padStart(2, '0');
  const round2 = (n) => Math.round(n * 100) / 100;
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[\s ]/g, '').replace(',', '.')));
  const hash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };

  function toISO(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null; }
    if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
    return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
  }

  /* ---------- Revolut: PDF-выписка ---------- */
  const RU_MONTHS = { 'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'май': 5, 'мая': 5, 'июн': 6, 'июл': 7, 'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12 };
  const RU_DATE = /^(\d{1,2})\s+([а-яё]+)\.?\s+(\d{4})\s*г?\.?$/i;
  const MONEY = /^(-?)\s*(\d{1,3}(?:[\s  ]\d{3})*,\d{2})\s*([€$£])$/;
  const SIGN = { '€': 'EUR', '$': 'USD', '£': 'GBP' };
  const RV_KINDS = {
    'Торговая точка': 'card', 'Перевод': 'transfer', 'Комиссия': 'fee', 'Снятие наличных': 'cash',
    'Банкомат': 'cash', 'Обмен валюты': 'exchange', 'Пополнение': 'topup',
  };

  function ruDate(s) {
    const m = s.match(RU_DATE);
    const mon = m && RU_MONTHS[m[2].toLowerCase().slice(0, 3)];
    return mon ? `${m[3]}-${pad(mon)}-${pad(m[1])}` : null;
  }

  // Строки PDF с координатами: ячейки одной строки собираются по Y, сортируются по X
  async function pdfRows(buf) {
    await loadScript(PDFJS + 'pdf.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const rows = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const { items } = await (await pdf.getPage(p)).getTextContent();
      const pageRows = [];
      items.forEach((it) => {
        const s = it.str.trim(); if (!s) return;
        const x = it.transform[4]; const y = it.transform[5];
        let r = pageRows.find((row) => Math.abs(row.y - y) < 2.5);
        if (!r) pageRows.push(r = { page: p, y, cells: [] });
        r.cells.push({ x, s });
      });
      pageRows.sort((a, b) => b.y - a.y).forEach((r) => { r.cells.sort((a, b) => a.x - b.x); rows.push(r); });
    }
    return rows;
  }

  function parseRevolutPdf(rows) {
    if (!rows.some((r) => r.cells.some((c) => /Revolut/i.test(c.s)))) return null;
    const ops = [];
    let inOps = false; let catX = null; let last = null; let lastRow = null;
    for (const row of rows) {
      const { cells } = row;
      const line = cells.map((c) => c.s).join(' ');
      if (/Выписка по операциям/.test(line)) { inOps = true; last = null; continue; }
      if (!inOps) continue;
      const head = cells.find((c) => c.s === 'Категория');
      if (head) { catX = head.x; continue; }
      if (/^Итого/.test(cells[0].s)) { inOps = false; last = null; continue; }
      const descCol = (c) => catX == null || c.x < catX - 5;
      const date = ruDate(cells[0].s);
      const mi = cells.findIndex((c) => MONEY.test(c.s));
      if (date && mi > 0) {
        const mid = cells.slice(1, mi);
        const desc = mid.filter(descCol).map((c) => c.s);
        let cat = mid.filter((c) => !descCol(c)).map((c) => c.s).join(' ');
        if (catX == null && desc.length > 1) cat = desc.pop();
        const m = cells[mi].s.match(MONEY);
        const after = cells.slice(mi + 1).map((c) => c.s);
        last = {
          date, desc: desc.join(' '), cat, neg: m[1] === '-', amount: num(m[2]), cur: SIGN[m[3]],
          bal: after[0] || '', fees: after[3] || '',
        };
        lastRow = row;
        ops.push(last);
      } else if (last && mi < 0 && row.page === lastRow.page && lastRow.y - row.y < 16 && cells.every(descCol)) {
        last.desc += ' ' + line; // перенос длинного описания на вторую строку
        lastRow = row;
      } else {
        last = null;
      }
    }
    return ops.filter((o) => o.neg && RV_KINDS[o.cat] !== 'exchange').map((o) => ({
      date: o.date, amount: o.amount, cur: o.cur, note: o.desc, bank: 'Revolut',
      kind: RV_KINDS[o.cat] || (/^Перевод/i.test(o.desc) ? 'transfer' : 'other'),
      key: `rv|${o.date}|${o.desc}|${o.amount}|${o.cur}|${o.bal}`,
      details: [['Категория банка', o.cat], ['Баланс после', o.bal], ['Комиссия', /^0,00/.test(o.fees) ? '' : o.fees]],
    }));
  }

  /* ---------- Revolut: CSV/XLSX-выгрузка (Type, Product, Started Date, …) ---------- */
  function parseRevolutTable(rows) {
    const h = (rows[0] || []).map(norm);
    const ix = (n) => h.indexOf(n);
    if (ix('started date') < 0 || ix('product') < 0 || ix('amount') < 0) return null;
    const kinds = { CARD_PAYMENT: 'card', TRANSFER: 'transfer', FEE: 'fee', ATM: 'cash' };
    const ops = [];
    rows.slice(1).forEach((r) => {
      const type = String(r[ix('type')] || '').toUpperCase();
      const state = String(r[ix('state')] || '').toUpperCase();
      const amount = num(r[ix('amount')]);
      const fee = num(r[ix('fee')]) || 0;
      if (!(amount < 0) || type === 'EXCHANGE' || (state && state !== 'COMPLETED')) return;
      const date = toISO(r[ix('completed date')] || r[ix('started date')]);
      if (!date) return;
      const desc = String(r[ix('description')] || '').trim();
      ops.push({
        date, amount: round2(-amount + fee), cur: String(r[ix('currency')] || 'EUR').toUpperCase(), note: desc,
        bank: 'Revolut', kind: kinds[type] || 'other',
        key: `rvc|${r[ix('started date')]}|${desc}|${amount}|${r[ix('balance')]}`,
        details: [['Тип операции', type], ['Счёт', r[ix('product')]], ['Начата', r[ix('started date')]],
          ['Завершена', r[ix('completed date')]], ['Комиссия', fee ? fee : ''], ['Баланс после', r[ix('balance')]]],
      });
    });
    return ops;
  }

  /* ---------- Wise: XLSX/CSV-выписка (русские или английские заголовки) ---------- */
  const WISE_COLS = {
    id: ['удостоверение личности', 'transferwise id', 'id'], date: ['дата', 'date'], amount: ['сумма', 'amount'],
    cur: ['валюта', 'currency'], desc: ['описание', 'description'], payee: ['имя получателя', 'payee name'],
    merchant: ['поставщик услуг', 'merchant'], det: ['тип деталей транзакции', 'transaction details type'],
    datetime: ['дата и время', 'date time'], ref: ['пояснение к переводу', 'payment reference'],
    account: ['номер счета получателя', 'payee account number'], card: ['последние 4 цифры карты', 'card last four digits'],
    fee: ['итоговая комиссия', 'total fees'], balance: ['текущий баланс', 'running balance'], memo: ['примечание', 'note'],
  };

  function wiseTime(v) {
    if (typeof v === 'number') { const d = XLSX.SSF.parse_date_code(v); return d ? `${pad(d.H)}:${pad(d.M)}` : ''; }
    const m = String(v ?? '').match(/(\d{1,2}):(\d{2})/);
    return m ? `${pad(m[1])}:${m[2]}` : '';
  }

  function parseWise(rows) {
    const h = (rows[0] || []).map(norm);
    const C = {};
    Object.entries(WISE_COLS).forEach(([k, names]) => { C[k] = h.findIndex((x) => names.includes(x)); });
    if (C.id < 0 || C.date < 0 || C.amount < 0 || C.desc < 0) return null;
    const kindOf = (det) => (det === 'CARD' ? 'card' : det === 'TRANSFER' ? 'transfer' : /FEE|CHARGE/.test(det) ? 'fee' : 'other');
    const str = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
    const ops = [];
    rows.slice(1).forEach((r) => {
      const amount = num(r[C.amount]);
      const det = str(r, C.det).toUpperCase();
      if (!(amount < 0) || det === 'CONVERSION') return;
      const date = toISO(r[C.date]);
      if (!date) return;
      const kind = kindOf(det);
      const note = (kind === 'transfer' ? str(r, C.payee) : str(r, C.merchant)) || str(r, C.desc);
      ops.push({
        date, amount: round2(-amount), cur: (str(r, C.cur) || 'EUR').toUpperCase(), note, bank: 'Wise', kind,
        key: `wise|${str(r, C.id) || date + str(r, C.desc) + amount}`,
        details: [['ID операции', str(r, C.id)], ['Время', wiseTime(r[C.datetime])], ['Получатель', str(r, C.payee)],
          ['Счёт получателя', str(r, C.account)], ['Магазин', str(r, C.merchant)], ['Пояснение', str(r, C.ref)],
          ['Карта', str(r, C.card) ? '•••• ' + str(r, C.card) : ''], ['Комиссия', num(r[C.fee]) ? String(num(r[C.fee])) : ''],
          ['Баланс после', str(r, C.balance)], ['Тип в Wise', det], ['Примечание', str(r, C.memo)]],
      });
    });
    return ops;
  }

  /* ---------- Загрузка файла ---------- */
  async function importFile(file) {
    const buf = await file.arrayBuffer();
    const isPdf = new TextDecoder().decode(buf.slice(0, 5)) === '%PDF-';
    let ops;
    if (isPdf) {
      ops = parseRevolutPdf(await pdfRows(buf));
    } else {
      const wb = XLSX.read(buf, { type: 'array', raw: /\.csv$/i.test(file.name) });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true });
      ops = parseWise(rows) || parseRevolutTable(rows);
    }
    if (!ops) throw new Error('Файл не похож на выписку Revolut или Wise');
    let added = 0; let waiting = 0; let backfilled = false;
    processed = [];
    ops.forEach((o) => {
      const details = [['Описание', o.note], ...(o.details || []), ['Файл', file.name]]
        .filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]);
      const rec = [uid(), o.date, round2(o.amount), o.cur, o.note || 'Без описания', o.bank, o.kind, hash(o.key), details];
      // записям, загруженным до появления подробностей, дописываем их
      const old = pending.find((p) => p[7] === rec[7]);
      const done = expenses.find((e) => e[5] === rec[7]);
      if (done) { if (!done[6] || !done[6].length) { done[6] = details; backfilled = true; } processed.push(rec); }
      else if (old) { if (!old[8]) old[8] = details; waiting++; }
      else { pending.push(rec); added++; }
    });
    persist(backfilled);
    return { found: ops.length, added, waiting, processed: processed.length };
  }

  function persist(withExpenses) {
    Store.save('pend', pending);
    if (withExpenses) Store.save('exp', expenses);
  }

  // Расход: [id, date, amount, cur, note, ключ банковской операции, детали из выписки, сумма по выписке]
  function resolve(ids, accept) {
    const set = new Set(ids);
    if (accept) {
      pending.filter((p) => set.has(p[0]))
        .forEach((p) => expenses.push([uid(), p[1], p[2], p[3], `${p[4]} · ${p[5]}`, p[7], p[8] || [], p[9] ?? null]));
    }
    pending = pending.filter((p) => !set.has(p[0]));
    persist(accept);
    haptic(accept ? 'success' : 'warning');
  }

  /* ---------- Отрисовка ---------- */
  function pendingItem(p, done) {
    return `<div class="pitem pressable${done ? ' done' : ''}" data-detail="${done ? 'proc' : 'pend'}:${esc(p[0])}">
      <div class="pmain"><div class="t">${esc(p[4])}</div>
        <div class="s">${fmtDate(p[1])} · <span class="tag ${p[5].toLowerCase()}">${esc(p[5])}</span> ${KIND_LABELS[p[6]] || ''}</div></div>
      ${amountHtml(p[2], done ? null : p[9], p[3])}
      ${done ? '<span class="status">✓ Обработан</span>' : `<div class="pbtns">
        <button class="pb ok" data-ok="${esc(p[0])}" aria-label="Подтвердить">✓</button>
        <button class="pb no" data-no="${esc(p[0])}" aria-label="Отклонить">✕</button>
      </div>`}</div>`;
  }

  function render() {
    const n = pending.length;
    const badge = document.getElementById('tab-badge');
    badge.textContent = n; badge.classList.toggle('hidden', !n);
    const banner = document.getElementById('pending-banner');
    banner.classList.toggle('hidden', !n);
    banner.querySelector('b').textContent = n;
    const card = document.getElementById('pending-card');
    card.classList.toggle('hidden', !n && !processed.length);
    document.getElementById('pending-count').textContent = n ? `(${n})` : '';
    document.getElementById('pending-list').innerHTML = n
      ? [...pending].sort(sortByDateDesc).map((p) => pendingItem(p)).join('')
      : '<div class="empty-state">Новых расходов нет</div>';
    document.getElementById('pending-actions').classList.toggle('hidden', !n);
    document.getElementById('processed-box').classList.toggle('hidden', !processed.length);
    document.getElementById('processed-count').textContent = processed.length;
    document.getElementById('processed-list').innerHTML = [...processed].sort(sortByDateDesc)
      .map((p) => pendingItem(p, true)).join('');
  }

  function setup() {
    document.getElementById('file-statement').addEventListener('change', async (e) => {
      const file = e.target.files[0]; if (!file) return;
      e.target.value = '';
      const btn = document.getElementById('statement-label');
      btn.classList.add('busy');
      try {
        const r = await importFile(file);
        const parts = [];
        if (r.added) parts.push(`новых: ${r.added}`);
        if (r.waiting) parts.push(`уже в ожидании: ${r.waiting}`);
        if (r.processed) parts.push(`обработано ранее: ${r.processed}`);
        toast(r.found ? 'Расходы в выписке — ' + parts.join(', ') : 'Расходов в выписке не найдено');
        window.render();
        if (r.found) document.getElementById('pending-card').scrollIntoView({ behavior: 'smooth' });
      } catch (err) {
        console.error(err);
        toast(err.message);
      } finally { btn.classList.remove('busy'); }
    });
    document.getElementById('pending-list').addEventListener('click', (e) => {
      const ok = e.target.closest('[data-ok]'); const no = e.target.closest('[data-no]');
      if (!ok && !no) return;
      const p = pending.find((x) => x[0] === (ok || no).dataset[ok ? 'ok' : 'no']);
      resolve([(ok || no).dataset[ok ? 'ok' : 'no']], !!ok);
      toast(ok ? `Записано в расходы: ${fmtDate(p[1])}` : 'Отклонено');
      window.render();
    });
    document.getElementById('pend-all-ok').addEventListener('click', async () => {
      if (!(await confirmBox(`Записать в расходы все ${pending.length}?`))) return;
      resolve(pending.map((p) => p[0]), true);
      toast('Все расходы записаны');
      window.render();
    });
    document.getElementById('pend-all-no').addEventListener('click', async () => {
      if (!(await confirmBox(`Отклонить все ${pending.length}?`))) return;
      resolve(pending.map((p) => p[0]), false);
      toast('Список ожидания очищен');
      window.render();
    });
    document.getElementById('processed-hide').addEventListener('click', () => { processed = []; window.render(); });
    document.getElementById('pending-banner').addEventListener('click', () => {
      show('more');
      document.getElementById('pending-card').scrollIntoView({ behavior: 'smooth' });
    });
  }

  async function load() {
    pending = await Store.load('pend');
  }

  // Данные для окна подробностей: { title, amount, cur, fields, pending }
  function detailOf(kind, id) {
    const p = (kind === 'pend' ? pending : processed).find((x) => x[0] === id);
    if (!p) return null;
    return {
      title: p[4], amount: p[2], orig: kind === 'pend' ? p[9] ?? null : null, cur: p[3],
      pendingId: kind === 'pend' ? p[0] : null, ref: kind === 'pend' ? { type: 'pend', id } : null,
      fields: [['Дата', fmtDate(p[1])], ['Банк', p[5]], ['Вид', KIND_LABELS[p[6]] || ''],
        ['Статус', kind === 'pend' ? 'Ожидает подтверждения' : '✓ Обработан'],
        ...(p[8] || [['Описание', p[4]]])],
    };
  }

  function setAmount(id, value) {
    const p = pending.find((x) => x[0] === id); if (!p) return;
    applyAmount(p, 9, value);
    persist(false);
  }

  // Ключ операции из блока «Уже обработаны» — чтобы найти подтверждённый расход
  const keyOf = (id) => (processed.find((x) => x[0] === id) || [])[7];

  function decide(id, accept) {
    const p = pending.find((x) => x[0] === id); if (!p) return;
    resolve([id], accept);
    toast(accept ? `Записано в расходы: ${fmtDate(p[1])}` : 'Отклонено');
    window.render();
  }

  return { load, setup, render, detailOf, decide, setAmount, keyOf, KIND_LABELS, importFile, parseRevolutPdf, parseWise, parseRevolutTable, pdfRows, get pending() { return pending; } };
})();
