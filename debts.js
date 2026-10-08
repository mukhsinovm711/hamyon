'use strict';

/* ================= Долги =================
 * Отдельно от расходов: деньги, выданные в долг, — не трата, а взятые в долг — не доход.
 * Долг: [id, date, amount, cur, person, note, dir, closedDate, key, details, orig]
 *   dir: 'lent' — я дал в долг (мне должны), 'borrowed' — я взял в долг (я должен)
 *   closedDate: дата возврата или null, пока долг открыт
 *   key, details, orig — для долгов из банковской выписки (ключ операции, подробности, исходная сумма)
 */
const Debts = (() => {
  let debts = [];
  let formDir = 'lent';
  let showClosed = false;
  const DIR = { lent: 'Я дал в долг', borrowed: 'Я взял в долг' };
  const el = (id) => document.getElementById(id);

  const save = () => Store.save('debt', debts);
  const hasKey = (key) => debts.some((d) => d[8] === key);
  const byKey = (key) => debts.find((d) => d[8] === key);

  function add(rec) { debts.push(rec); save(); }

  // Операция из выписки → «я дал в долг» получателю
  function fromPending(p) {
    add([uid(), p[1], p[2], p[3], p[4], p[5], 'lent', null, p[7], p[8] || [], p[9] ?? null]);
  }

  function item(d) {
    const closed = !!d[7];
    const lent = d[6] === 'lent';
    return `<div class="item pressable debt-item${closed ? ' done' : ''}" data-detail="debt:${esc(d[0])}">
      <div class="pmain"><div class="t">${esc(d[4])}</div>
        <div class="s">${lent ? 'Мне должны' : 'Я должен'} · ${fmtDate(d[1])}${d[5] ? ' · ' + esc(d[5]) : ''}${closed ? ` · возвращён ${fmtDate(d[7])}` : ''}</div></div>
      <div class="a ${lent ? 'lent' : 'neg'}">${fmt(d[2], d[3])}</div>
      <div class="pbtns">${closed
        ? `<button class="pb" data-reopen="${esc(d[0])}" aria-label="Вернуть в открытые">↺</button>
           <button class="pb no" data-del-debt="${esc(d[0])}" aria-label="Удалить">✕</button>`
        : `<button class="pb ok" data-close="${esc(d[0])}" aria-label="Долг возвращён">✓</button>`}</div></div>`;
  }

  // Подтверждённый расход → «я дал в долг». Ключ, подробности и исходная сумма сохраняются,
  // поэтому при повторной загрузке выписки операция покажется как «В долгах»
  function fromExpense(r) {
    const [person, bank] = r[5] && / · /.test(r[4]) ? [r[4].slice(0, r[4].lastIndexOf(' · ')), r[4].slice(r[4].lastIndexOf(' · ') + 3)] : [r[4], ''];
    add([uid(), r[1], r[2], r[3], person || 'Без имени', bank, 'lent', null, r[5] || null, r[6] || null, r[7] ?? null]);
  }

  function render() {
    const open = debts.filter((d) => !d[7]).sort(sortByDateDesc);
    const closed = debts.filter((d) => d[7]).sort((a, b) => (a[7] < b[7] ? 1 : -1));
    const cur = mainCurrency();
    const total = (dir) => sum(open.filter((d) => d[6] === dir && d[3] === cur));
    el('debt-summary').innerHTML = `
      <div class="stat"><span class="muted">Мне должны</span><b class="lent">${fmt(total('lent'))}</b></div>
      <div class="stat"><span class="muted">Я должен</span><b class="neg">${fmt(total('borrowed'))}</b></div>`;
    el('debt-list').innerHTML = open.map(item).join('') || '<div class="empty-state">Открытых долгов нет</div>';
    el('debt-closed-toggle').classList.toggle('hidden', !closed.length);
    el('debt-closed-toggle').textContent = showClosed ? 'Скрыть возвращённые' : `Возвращённые (${closed.length})`;
    el('debt-closed').classList.toggle('hidden', !showClosed);
    el('debt-closed').innerHTML = showClosed ? closed.map(item).join('') : '';
    const f = el('debt-form');
    if (!f.elements.date.value) f.elements.date.value = today();
  }

  function detail(id) {
    const d = debts.find((x) => x[0] === id);
    if (!d) return null;
    return {
      title: d[4], amount: d[2], orig: d[10] ?? null, cur: d[3], sign: '', pendingId: null, ref: null,
      fields: [['Тип', DIR[d[6]]], ['Дата', fmtDate(d[1])], ['Статус', d[7] ? `Возвращён ${fmtDate(d[7])}` : 'Не возвращён'],
        ['Комментарий', d[5]], ...(d[9] || [])],
    };
  }

  function setup() {
    el('debt-add-toggle').addEventListener('click', () => {
      const f = el('debt-form');
      f.classList.toggle('hidden');
      el('debt-add-toggle').textContent = f.classList.contains('hidden') ? '＋ Добавить' : 'Отмена';
      if (!f.classList.contains('hidden')) f.elements.person.focus();
    });
    el('debt-dir').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      formDir = b.dataset.dir;
      el('debt-dir').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
    el('debt-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const amount = Math.round(parseFloat(String(f.amount.value).replace(',', '.')) * 100) / 100;
      if (!(amount > 0)) return toast('Введите сумму');
      if (!f.person.value.trim()) return toast('Укажите, кто или кому');
      add([uid(), f.date.value, amount, mainCurrency(), f.person.value.trim(), f.note.value.trim(), formDir, null, null, null, null]);
      f.person.value = ''; f.amount.value = ''; f.note.value = '';
      el('debt-form').classList.add('hidden');
      el('debt-add-toggle').textContent = '＋ Добавить';
      haptic();
      toast('Долг записан');
      render();
    });
    el('debt-closed-toggle').addEventListener('click', () => { showClosed = !showClosed; render(); });
    document.getElementById('debts-card').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-close], button[data-reopen], button[data-del-debt]');
      if (!b) return;
      const id = b.dataset.close || b.dataset.reopen || b.dataset.delDebt;
      const d = debts.find((x) => x[0] === id); if (!d) return;
      if (b.dataset.close) {
        if (!(await confirmBox(`${d[4]}: долг ${fmt(d[2], d[3])} возвращён?`))) return;
        d[7] = today(); toast('Отмечено как возвращённый');
      } else if (b.dataset.reopen) {
        d[7] = null; toast('Долг снова открыт');
      } else {
        if (!(await confirmBox('Удалить долг из истории?'))) return;
        debts = debts.filter((x) => x !== d);
      }
      save(); haptic(); render();
    });
  }

  async function load() { debts = await Store.load('debt'); }

  return { load, setup, render, detail, fromPending, fromExpense, hasKey, byKey, get all() { return debts; } };
})();
