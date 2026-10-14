// СУХ ТЕСТ на новия код: истински данни от Barsy (прочетени сега), но ВСИЧКИ записи са заглушени —
// нищо не стига до Barsy/Telegram/Supabase. Пуска локалния api/cex-plan.js срещу подменен fetch.
const fs = require('fs');
const env = fs.readFileSync('C:/Users/Motamo/.claude/motamo-tokens.env', 'utf8');
const LIVE = /CEX_TOOL_TOKEN=(\S+)/.exec(env)[1];
const realFetch = global.fetch;
const live = async (body) => (await realFetch('https://motamo-api.vercel.app/api/cex-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: LIVE, ...body }) })).json();

(async () => {
  // ── истински данни (само четене) ──
  const st = await live({ action: 'stock', all: true });
  const lf = await live({ action: 'article_form', method: 'Lots_GetListAvailability', id: 1, top: { filters: { has_amount_real_or_reserved: 1 } }, head: 200000 });
  const LOTS = JSON.parse(lf.head).Lots_GetListAvailability;
  const STOCK = {}; for (const r of st.rows) STOCK[r.id] = r.qty;
  console.log('фикстури: склад', Object.keys(STOCK).length, 'артикула; партидни редове', LOTS.length);

  // ── заглушен свят ──
  const W = { prods: [], accounts: [], tg: [], day: {}, sent: {}, plan: {}, sreq: {} };
  const J = (o, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => o, text: async () => JSON.stringify(o) });
  global.fetch = async (url, opt) => {
    url = String(url); const body = opt && opt.body ? JSON.parse(opt.body) : null;
    if (url.includes('barsy.online/endpoints/json/Articles_getlistobject')) {
      const depot = body.filters.depot_id;
      return J({ list: Object.keys(STOCK).map(id => ({ article_id: Number(id), store_amount: depot === 2 ? (Number(id) === 86 ? 19.37 : 0) : STOCK[id] })) });
    }
    if (url.includes('/endpoints/json/Accounts_getlist')) return J([{ account_id: 1, close_date: '2026-09-30' }].concat(W.accounts.map((x, i) => ({ account_id: 9000 + i, close_date: null }))));
    if (url.includes('/endpoints/json/Accounts_place')) { const id = 9000 + W.accounts.length; W.accounts.push(body);
      for (const o of body.orders) { const row = LOTS.find(x => String(x.article_id) === String(o.article_id) && x.lot_value === o.lot_value && Number(x.depot_id) === 1); if (row) row.amount_reserved -= o.amount; }
      return J(id); }
    if (url.endsWith('/endpoints/json?bid=1')) {
      if (body.Lots_GetListAvailability) return J({ Lots_GetListAvailability: LOTS.filter(x => !body.Lots_GetListAvailability.filters.lot_value || x.lot_value === body.Lots_GetListAvailability.filters.lot_value) });
      if (body.Storeproductions_save) { const rows = body.Storeproductions_save.rows; W.prods.push(rows.map(r => r.article_name + ' ' + r.amount + (r.lot_value ? ' [' + r.lot_value + ']' : '')));
        for (const r of rows) { STOCK[r.article_id] = (Number(STOCK[r.article_id]) || 0) + Number(r.amount);
          if (r.lot_value) { let row = LOTS.find(x => String(x.article_id) === String(r.article_id) && x.lot_value === r.lot_value && Number(x.depot_id) === 1); if (!row) { row = { article_id: r.article_id, lot_value: r.lot_value, depot_id: 1, amount_real: 0, amount_reserved: 0 }; LOTS.push(row); } row.amount_real += Number(r.amount); } }
        return J({ Storeproductions_save: 7000 + W.prods.length }); }
    }
    if (url.includes('supabase.co/rest/v1/cex_day_state')) {
      if (!opt || !opt.method || opt.method === 'GET') { const d = /for_date=eq\.([\d-]+)/.exec(url)[1]; return J(W.day[d] ? [W.day[d]] : []); }
      for (const r of body) W.day[r.for_date] = r; return J({});
    }
    if (url.includes('supabase.co/rest/v1/cex_kitchen_plan')) { if (opt && opt.method === 'POST') { for (const r of body) W.plan[r.for_date] = r; return J({}); } const d = /for_date=eq\.([\d-]+)/.exec(url); return J(d && W.plan[d[1]] ? [W.plan[d[1]]] : []); }
    if (url.includes('supabase.co/rest/v1/cex_tg_sent')) { if (opt && opt.method === 'POST') { for (const r of body) W.sent[r.kind + r.for_date] = r; return J({}); } const k = /kind=eq\.(\w+)/.exec(url), d = /for_date=eq\.([\d-]+)/.exec(url); const r = k && d && W.sent[k[1] + d[1]]; return J(r ? [r] : []); }
    if (url.includes('supabase.co/rest/v1/cex_shop_requests')) {
      if (opt && opt.method === 'POST') { for (const r of body) W.sreq[r.for_date + '|' + r.obj_key] = Object.assign({ id: 1, sent_at: '2026-10-01T05:00:00Z' }, W.sreq[r.for_date + '|' + r.obj_key] || {}, r); return J({}); }
      if (opt && opt.method === 'PATCH') { const id = /id=eq\.(\d+)/.exec(url); for (const k of Object.keys(W.sreq)) if (String(W.sreq[k].id) === id[1]) Object.assign(W.sreq[k], body); return J([{}]); }
      const d = /for_date=eq\.([\d-]+)/.exec(url), o = /obj_key=eq\.([^&]+)/.exec(url);
      return J(Object.values(W.sreq).filter(r => (!d || r.for_date === d[1]) && (!o || r.obj_key === decodeURIComponent(o[1]))));
    }
    if (url.includes('supabase.co/rest/v1/cex_docs')) return J([{ inv_id: 501, type_id: 11, doc_date: '2026-09-24', client_id: 2, person_id: 4, is_anulate: 0 }, { inv_id: 502, type_id: 11, doc_date: '2026-09-30', client_id: 2, person_id: 4, is_anulate: 0 }, { inv_id: 503, type_id: 11, doc_date: '2026-09-17', client_id: 2, person_id: 4, is_anulate: 0 }]);
    if (url.includes('supabase.co/rest/v1/cex_doc_rows')) return J([{ inv_id: 501, article_id: 129, qty: 7, line_total: 20, lot_date: '2026-09-24' }, { inv_id: 501, article_id: 81, qty: 6, line_total: 20, lot_date: '2026-09-24' }, { inv_id: 502, article_id: 129, qty: 5, line_total: 15, lot_date: '2026-09-30' }, { inv_id: 503, article_id: 129, qty: 6, line_total: 18, lot_date: '2026-09-17' }, { inv_id: 503, article_id: 81, qty: 4, line_total: 12, lot_date: '2026-09-17' }]);
    if (url.includes('api.telegram.org')) { W.tg.push({ chat: body.chat_id, text: body.text }); return J({ ok: true, result: { message_id: W.tg.length } }); }
    console.log('  !! НЕПОЗНАТА ЗАЯВКА (заглушена):', url.slice(0, 110)); return J({}, false);
  };
  Object.assign(process.env, { PAY_HMAC_SECRET: 't', BARSY_CEX_USER: 'u', BARSY_CEX_PASS: 'p', TELEGRAM_BOT_TOKEN: 'x' });
  const handler = require('C:/motamo-api/api/cex-plan.js');
  const run = async (body, method = 'POST', query = {}) => new Promise((resolve) => {
    const res = { _s: 200, status(c) { this._s = c; return this; }, json(o) { resolve({ status: this._s, j: o }); }, send(t) { resolve({ status: this._s, html: String(t) }); }, setHeader() {}, end(t) { resolve({ status: this._s, html: String(t || '') }); } };
    Promise.resolve(handler({ method, query, headers: { host: 'x' }, body: Object.assign({ token: 't' }, body) }, res)).catch(e => resolve({ status: 599, j: { crash: String(e && e.stack || e) } }));
  });
  const strip = t => String(t || '').replace(/<[^>]+>/g, '');
  const showTable = t => (t || []).filter(r => r.need || r.produce || r.free < 0).map(r => `    ${r.name}: под партидата ${r.real} · запазено ${r.reserved} · свободно ${r.free} · трябва ${r.need} → правя ${r.produce}`).join('\n');
  const D = '2026-10-01';
  const shopA = { client: 'ТЕСТ', rep: 'Магазин А', client_id: 991, person_id: 1, order: { 'Poke MAI': 2, 'НACHI ORO': 2, 'CET KAWA': 1, 'Poke ТОКЕ': 4 } };
  const shopB = { client: 'ТЕСТ', rep: 'Магазин Б', client_id: 991, person_id: 2, order: { 'Poke ТОКЕ': 15, 'НACHI RAY': 3 } };

  console.log('\n══ 1) „Изчисли" за магазин А (партида L.01.10, днешните истински числа) ══');
  let r = await run({ shops: [shopA], publish_kitchen: true, kitchen_date: D });
  console.log('  статус', r.status, '| суровини за зареждане:', JSON.stringify(r.j.preflight && r.j.preflight.load_raw), '| в склад Точка:', JSON.stringify(r.j.preflight && r.j.preflight.in_point), '| стари партиди:', JSON.stringify(r.j.preflight && r.j.preflight.stale), r.j.preflight && r.j.preflight.error ? '| ГРЕШКА ' + r.j.preflight.message : '');
  console.log(showTable(r.j.preflight && r.j.preflight.table));

  console.log('\n══ 2) ② Артикули за магазин А ══');
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopA], prod_date: D });
  console.log('  ok', r.j.ok, r.j.message || '', '| производства:', JSON.stringify(W.prods)); const n1 = W.prods.length;

  console.log('\n══ 3) ② ПАК за магазин А (не трябва да прави нищо) ══');
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopA], prod_date: D });
  console.log('  ok', r.j.ok, '| нови производства:', JSON.stringify(W.prods.slice(n1))); const n2 = W.prods.length;

  console.log('\n══ 4) ③ Сметки за магазин А, после ② ПАК (сметката вече е в „запазено") ══');
  r = await run({ action: 'create_accounts', date: D, shops: [shopA] });
  console.log('  сметка:', JSON.stringify(r.j.created), '| записано на сървъра:', r.j.day_saved);
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopA], prod_date: D });
  console.log('  ② след ③ → нови производства:', JSON.stringify(W.prods.slice(n2)), '| със сметка:', r.j.with_account); const n3 = W.prods.length;

  console.log('\n══ 5) ВЪЛНА: добавям магазин Б, тикнати А+Б → ② прави само за Б ══');
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopA, shopB], prod_date: D });
  console.log('  ok', r.j.ok, '| нови производства:', JSON.stringify(W.prods.slice(n3)));
  console.log(showTable(r.j.table)); const n4 = W.prods.length;

  console.log('\n══ 6) УТРЕШНА партида L.02.10 (празна) за магазин А — прави пълното, днешните сметки не пречат ══');
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopA], prod_date: '2026-10-02' });
  console.log('  ok', r.j.ok, r.j.error || '', r.j.message || '', '| производства:', JSON.stringify(W.prods.slice(n4)));
  console.log('  ↑ ПРЕДПАЗИТЕЛ: ако под по-стара партида има запазени НАЧИ → очаквано ok false, old_lot_reserved, 0 производства');
  const n5 = W.prods.length; const shopP = { client: 'ТЕСТ', rep: 'Магазин П', client_id: 991, person_id: 5, order: { 'Poke ТОКЕ': 3 } };
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopP], prod_date: '2026-10-02' });
  console.log('  6б) без сетове (само поке) под L.02.10 → минава: ok', r.j.ok, '| производства:', JSON.stringify(W.prods.slice(n5)));

  console.log('\n══ 7) Telegram: първо пращане (А), после вълна (А+Б) — на сухо ══');
  await run({ shops: [shopA], publish_kitchen: true, kitchen_date: '2026-10-03', preflight: false });
  r = await run({ action: 'tg_send_plan', date: '2026-10-03' });
  console.log('  пратени съобщения:', W.tg.length, '→ към:', W.tg.map(m => m.chat || 'група').join(', '));
  await run({ shops: [shopA, shopB], publish_kitchen: true, kitchen_date: '2026-10-03', preflight: false });
  const t0 = W.tg.length; r = await run({ action: 'tg_send_plan', date: '2026-10-03' });
  console.log('  вълна №', r.j.wave, r.j.kind); for (const m of W.tg.slice(t0)) console.log('\n--- към ' + (m.chat || 'групата') + ' ---\n' + strip(m.text));
  r = await run({ action: 'tg_send_plan', date: '2026-10-03' }); console.log('\n  трето натискане без промяна →', r.j.unchanged ? 'нищо не е пратено ✓' : JSON.stringify(r.j));

  console.log('\n══ Z) ② БЕЗ ① при заготовка на минус: Ориз Поке = −3 кг, магазин иска Poke ТОКЕ 10 (партида L.05.10) ══');
  STOCK[70] = -3; const nz = W.prods.length; const shopZ = { client: 'ТЕСТ', rep: 'Магазин З', client_id: 991, person_id: 9, order: { 'Poke ТОКЕ': 10 } };
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopZ], prod_date: '2026-10-05' });
  console.log('  ok', r.j.ok, r.j.message || '', '| производства по ред:', JSON.stringify(W.prods.slice(nz)));
  console.log('  Ориз Поке в заглушения склад (без изяждане):', Math.round(STOCK[70] * 100) / 100, '→ очаквано 1.7 (дупка 3 + нужда 1.7 = произведени 4.7)');
  const nz2 = W.prods.length; r = await run({ action: 'produce_plan', only: 'articles', shops: [shopZ], prod_date: '2026-10-05' });
  console.log('  ② пак → нови производства:', JSON.stringify(W.prods.slice(nz2)));

  console.log('\n══ H) СКРИТ МИНУС: под L.06.10 се виждат 3 НАЧИ RAY, но общо свободни в склада са 1 → ② трябва да направи още 2 ══');
  const shopH = { client: 'ТЕСТ', rep: 'Магазин Х', client_id: 991, person_id: 8, order: { 'НACHI RAY': 3 } };
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopH], prod_date: '2026-10-06' });
  const rsv74 = LOTS.filter(x => String(x.article_id) === '74' && Number(x.depot_id) === 1).reduce((s, x) => s + (Number(x.amount_reserved) || 0), 0);
  STOCK[74] = -rsv74 + 1; const nh = W.prods.length;
  r = await run({ action: 'produce_plan', only: 'articles', shops: [shopH], prod_date: '2026-10-06' });
  console.log('  ok', r.j.ok, '| нови производства:', JSON.stringify(W.prods.slice(nh)), '→ очаквано НACHI RAY 2');
  const nh2 = W.prods.length; r = await run({ action: 'produce_plan', only: 'articles', shops: [shopH], prod_date: '2026-10-06' });
  console.log('  ② пак → нови производства:', JSON.stringify(W.prods.slice(nh2)), '→ очаквано нищо');

  console.log('\n══ 8) Страницата на инструмента — валиден ли е вграденият скрипт ══');
  r = await run({}, 'GET', { view: 'tool', k: 't' });
  const scripts = [...(r.html || '').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]); let ok = scripts.length > 0;
  for (const sc of scripts) { try { new Function(sc); } catch (e) { ok = false; console.log('  JS ГРЕШКА:', e.message); } }
  console.log('  статус', r.status, '| скриптове', scripts.length, '| валиден JS:', ok, '| има openDay:', /function openDay/.test(r.html), '| има saveDay:', /function saveDay/.test(r.html));
  console.log('\n══ 9) ФОРМА ЗА ЗАЯВКА на магазин (Граф Игнатиев 2:4): токен, данни, пращане, таб на собственика ══');
  const crypto = require('crypto');
  const okTok = crypto.createHmac('sha256', 't').update('zayavka:2:4:v1').digest('hex').slice(0, 24);
  const TMR = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  r = await run({}, 'GET', { view: 'zayavka', o: '2:4', k: 'wrong' });
  console.log('  грешен ключ → статус', r.status, '(очаквано 403)');
  r = await run({}, 'GET', { view: 'zayavka', o: '2:4', k: okTok });
  console.log('  верен ключ → статус', r.status, '| страницата носи името:', /Граф Игнатиев/.test(r.html || ''));
  { const sc = [...(r.html || '').matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]); let okz = sc.length > 0; for (const x of sc) { try { new Function(x); } catch (e) { okz = false; console.log('  JS ГРЕШКА (zayavka):', e.message); } } console.log('  скриптът на формата е валиден JS:', okz); }
  r = await run({ token: undefined, action: 'shop_form_data', o: '2:4', k: okTok, date: '2026-10-01' });
  const it = (r.j.items || []).map(x => x.name + ' мин.същи=' + (x.last_same ? x.last_same.qty : '-') + ' посл=' + (x.last ? x.last.qty : '-') + ' пр=' + x.suggest);
  console.log('  данни ok', r.j.ok, '| обект', r.j.obj && r.j.obj.name, '| артикули:', JSON.stringify(it));
  r = await run({ token: undefined, action: 'shop_form_send', o: '2:4', k: okTok, for_date: TMR, rows: [{ id: 129, qty: 8 }, { id: 81, qty: 0 }, { id: 999, qty: 3 }], left: { 129: 2 } });
  console.log('  пращане ok', r.j.ok, '| записано:', JSON.stringify(Object.values(W.sreq).map(x => [x.for_date, x.obj_key, x.rows, x.left_qty])));
  { const last = W.tg[W.tg.length - 1]; console.log('  Telegram до собственика:', last ? (String(last.chat) === '1153763325' && /Заявка от СИБИЕС 11/.test(last.text)) : false, '|', last ? last.text.split('\n')[0] : '-'); }
  r = await run({ token: undefined, action: 'shop_form_send', o: '2:4', k: 'wrong', for_date: TMR, rows: [{ id: 129, qty: 1 }] });
  console.log('  пращане с грешен ключ → ok', r.j.ok, 'статус', r.status, '(очаквано 403)');
  r = await run({ action: 'shop_requests', date: TMR });
  console.log('  таб на собственика ok', r.j.ok, '| заявки:', JSON.stringify((r.j.requests || []).map(x => [x.obj_key, x.name, x.rows, x.applied])), '| мълчат:', JSON.stringify(r.j.silent), '| линкът за 2:4 е кратък (zayavka.motamo.bg/sibies-11-<6>):', String((r.j.links || {})['2:4'] || '') === 'https://zayavka.motamo.bg/sibies-11-' + okTok.slice(0, 6));
  r = await run({}, 'GET', { view: 'zayavka', s: 'sibies-11-' + okTok.slice(0, 6) });
  console.log('  кратък адрес sibies-11-<6> → статус', r.status, '| име:', /СИБИЕС 11/.test(r.html || ''));
  r = await run({}, 'GET', { view: 'zayavka', s: 'sibies-11-000000' });
  console.log('  кратък адрес с грешен ключ → статус', r.status, '(очаквано 403)');
  W.day[TMR] = { for_date: TMR, state: { accounts: { '2|4|': { account_id: 4444 } } } };
  r = await run({ action: 'shop_requests', date: TMR });
  console.log('  магазин със сметка за деня → has_account:', (r.j.requests || []).map(x => x.has_account + '/' + x.account_id).join(','), '(очаквано true/4444)');
  r = await run({ action: 'shop_request_applied', id: 1, applied_rows: [{ id: 129, qty: 8 }] });
  console.log('  приложено ok', r.j.ok, '| applied_at записан:', !!Object.values(W.sreq)[0].applied_at);

  console.log('\nзаписи към истинския Barsy/Telegram/Supabase: 0 (всичко беше заглушено)');
})().catch(e => console.log('ХАРНЕС ГРЕШКА', e && e.stack || e));
