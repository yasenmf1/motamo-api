// api/cex-plan.js — Цех Фаза 1: производствен калкулатор (ЕДНА функция, 3 режима).
// Обединено, за да се спази лимитът от 12 serverless функции на Vercel Hobby.
//
//   GET  /api/cex-plan?view=tool                 → страница за собственика (въвежда/коригира)
//   GET  /api/cex-plan?view=today&k=<токен>      → ЧЕТЯЩ екран за цеха („какво да готвим днес")
//   POST /api/cex-plan  (JSON, токен)            → изчисление: {shops|orders|seed_date} → план
//
// Разбива заявката (меню, вкл. сетове) до РОЛИ/ПОКЕ и ЗАГОТОВКИ за производство.
// Суровините Barsy ги тегли сам при производство. Рецептата е от _cexdata.js
// (генериран от експорта). Само ЧЕТЕ Barsy (сметки/поръчки на цеха). Гейт за JSON:
// RECONCILE_TOKEN / PAY_HMAC_SECRET / PREVIEW_TOKEN. За view=today и CEX_VIEW_TOKEN.

const crypto = require("crypto");
const DATA = require("./_cexdata.js");
const ARTS = DATA.articles, NAME2ID = DATA.name2id;
const MENU = Object.values(ARTS).filter(a => a.is_menu)
  .sort((a, b) => (a.is_set - b.is_set) || (a.id - b.id))
  .map(a => ({ id: a.id, name: a.name, is_set: !!a.is_set }));

const CEX_API = "https://motamo.barsy.online", CEX_BID = 1, CEX_DEPOT = 1, TIMEOUT_MS = 9000;

// ── Цех лист (ЧЕРНОВА): срок (дни) + препоръчителна наличност + доставчик, по
// ръчния лист на собственика (числата за проверка/корекция). Наличността се тегли
// от Barsy по id. производство/заявка = препоръчителна − наличност.
const CEX_SHEET = {
  sushi: [ // {id, зад име, срок(дни), preporuka, ед}
    { id: 65, срок: 46, preporuka: 0.2, ед: "кг" },   // заг. Сос Манго с мед
    { id: 59, срок: 15, preporuka: 6, ед: "бр" },     // заг. Крем/Смес рулца раци
    { id: 36, срок: 46, preporuka: 2, ед: "кг" },     // Крема сирене
    { id: 56, срок: 46, preporuka: 4.5, ед: "кг" },   // Краставици
    { id: 66, срок: 46, preporuka: 7, ед: "кг" },     // заг. Марината за ориз
    { id: 67, срок: 46, preporuka: 15, ед: "кг" }     // заг. Сварен суши ориз
  ],
  poke: [
    { id: 68, срок: 15, preporuka: 6, ед: "кг" },     // заг. Соево чеснова майонеза
    { id: 131, срок: 24, preporuka: 3, ед: "кг" },    // Зеле овкусено
    { id: 123, срок: 24, preporuka: 3, ед: "кг" },    // Сладка Царевица
    { id: 87, срок: 48, preporuka: 1, ед: "кг" },     // Уакаме
    { id: 52, срок: 12, preporuka: 2, ед: "пакета" }, // Авокадо
    { id: 53, срок: 24, preporuka: 1, ед: "кг" },     // Унаги сос
    { id: 98, срок: 96, preporuka: 2, ед: "кг" },     // Сусам бял печен
    { id: 146, срок: 24, preporuka: 0.1, ед: "кг" }   // Фурикаке Микс Мотамо (~100г/ден)
  ],
  order: [ // поръчки към доставчик: {id?, name, доставчик, дни, preporuka, ед}
    { id: 148, доставчик: "Алекс", дни: "пон/четв", preporuka: 10, ед: "пакета" }, // Сьомга Сурова
    { name: "Раци рулца", доставчик: "Алекс", дни: "пон/четв", preporuka: 20, ед: "пакета" },
    { id: 52, доставчик: "АйсБокс", дни: "пон/четв", preporuka: 5, ед: "пакета" }, // Авокадо
    { id: 123, доставчик: "АйсБокс", дни: "пон/четв", preporuka: 5, ед: "пакета" }, // Царевица
    { id: 86, доставчик: "Фишекспрес", дни: "пон/четв", preporuka: 10, ед: "пакета" }, // Едамаме
    { id: 127, доставчик: "Брадърс", дни: "пон/четв", preporuka: 20, ед: "пакета" }, // Пиле
    { id: 37, доставчик: "Брадърс", дни: "пон/четв", preporuka: 3, ед: "кофи" }, // Майонеза
    { id: 29, доставчик: "Брадърс", дни: "пон/четв", preporuka: 3, ед: "кофи" }, // Олио
    { id: 36, доставчик: "Брадърс", дни: "пон/четв", preporuka: 3, ед: "кофи" }, // Крема сирене
    { name: "Скарида", доставчик: "Фишекспрес", дни: "пон/петък", preporuka: 20, ед: "пакета" },
    { id: 98, доставчик: "Фишекспрес", дни: "пон/петък", preporuka: 2, ед: "кг" } // Сусам
  ]
};
const byId = id => ARTS[String(id)] || null;
const resolve = k => ARTS[String(k)] || (NAME2ID[k] != null ? ARTS[String(NAME2ID[k])] : null);

function withTimeout(run) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  return Promise.resolve(run(c.signal)).finally(() => clearTimeout(t));
}
function cexCall(action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${CEX_API}/endpoints/json/${action}?bid=${CEX_BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
// Записът на производство е недокументиран вътрешен метод: праща се на
// /endpoints/json?bid=1 (БЕЗ действие в пътя), а тялото е обвито под ключа
// „Storeproductions_save". Затова обикновените извиквания не хващаха склада —
// depot_id живее в values, вътре в обвивката. (Разбито живо, S12.)
function cexCallRoot(bodyObj, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${CEX_API}/endpoints/json?bid=${CEX_BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(bodyObj || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
// Създава ЕДНО производство (save_and_close → произведеното влиза в наличност).
// rows: [{article_id, amount, lot?, lot_exp?}]. Числата се пращат като низове.
async function createProduction(rows, opts, user, pass) {
  const o = opts || {};
  const body = { Storeproductions_save: {
    id: null, action_type: "save_and_close",
    values: { depot_id: String(o.depot_id || CEX_DEPOT), doc_date: o.doc_date || null, description: o.description || "", notes: o.notes || "" },
    rows: (rows || []).map((r, i) => ({
      row_id: "", article_id: r.article_id, article_name: r.article_name || "",
      amount: String(r.amount), amount_prod: String(r.amount_prod != null ? r.amount_prod : r.amount),
      prod_user: "", lot_value: r.lot != null ? String(r.lot) : (o.lot != null ? String(o.lot) : ""),
      lot_exp_date: r.lot_exp || o.lot_exp || null, notes: "", requested_qty: "",
      item_status: "0", prod_reason_id: "", sort_order: String(i)
    }))
  }};
  const r = await cexCallRoot(body, user, pass);
  // Barsy връща новото id като СТОЙНОСТ на ключа: {"Storeproductions_save": <id>}.
  const id = r.data && (r.data.Storeproductions_save || r.data.store_production_id || r.data.id || (r.data.data && r.data.data.store_production_id)) || null;
  return { ok: !!r.ok && !!id, status: r.status, store_production_id: id, data: r.data, error: r.ok && id ? undefined : String(r.raw || "").slice(0, 300) };
}
// Паралелно с ограничение (за да не надхвърлим лимита при много заявки).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
// Наличности на всички СУРОВИНИ + ЗАГОТОВКИ (за ежедневния репорт „кое е на изчерпване").
// ЕДНА заявка: Articles_getlistobject с depots + extra_properties:["store_amount"]
// връща store_amount за всеки артикул (~2 сек), вместо по една заявка на артикул.
async function readStock(user, pass) {
  const r = await cexCall("Articles_getlistobject", { filters: {}, depots: [CEX_DEPOT], extra_properties: ["store_amount"] }, user, pass);
  const L = r.data && (r.data.list || r.data) || {};
  const list = Array.isArray(L) ? L : Object.values(L);
  const rows = [];
  for (const a of list) {
    const id = a && (a.article_id || a.id); if (id == null) continue;
    const meta = ARTS[String(id)]; if (!meta || (meta.cat !== "Суровини" && meta.cat !== "Заготовки")) continue;
    const q = Number(a.store_amount);
    rows.push({ id: id, name: a.article_name || meta.name, cat: meta.cat, qty: isNaN(q) ? null : Math.round(q * 1000) / 1000 });
  }
  rows.sort((x, y) => (x.qty == null ? 1 : y.qty == null ? -1 : x.qty - y.qty));
  return rows;
}
// Карта {article_id: наличност} за всички артикули (една заявка).
async function stockMap(user, pass) {
  const r = await cexCall("Articles_getlistobject", { filters: {}, depots: [CEX_DEPOT], extra_properties: ["store_amount"] }, user, pass);
  const L = r.data && (r.data.list || r.data) || {};
  const list = Array.isArray(L) ? L : Object.values(L);
  const m = {};
  for (const a of list) { const id = a && (a.article_id || a.id); if (id != null) { const q = Number(a.store_amount); m[String(id)] = isNaN(q) ? null : Math.round(q * 1000) / 1000; } }
  return m;
}
async function seedShops(date, user, pass) {
  const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 900 }, user, pass);
  let all = list.data || [];
  if (!Array.isArray(all)) all = Object.values(all);
  // Групираме по ДЕНЯ НА ДОСТАВКА = close_date (сметките се правят по-рано, но се
  // затварят в деня на разноса; create_date размесва два дни). Fallback: ref_date.
  // Затворените се групират по ден на доставка (close_date/ref_date). ОТВОРЕНИТЕ
  // (още незатворени, напр. току-що създадените за понеделник) нямат close_date →
  // ползваме create_date, за да се виждат веднага в кухненския екран/плана.
  const accts = all.filter(a => String(a.close_date || a.ref_date || a.create_date || "").startsWith(date));
  // Паралелно по сметка — иначе ~13 последователни заявки надхвърлят лимита на функцията.
  const shops = await Promise.all(accts.map(async (a) => {
    const rows = await cexCall("Orders_getlist", { filters: { account_id: a.account_id } }, user, pass);
    const order = {};
    for (const o of (rows.data || [])) {
      const art = byId(o.article_id) || resolve(o.article_name);
      if (art && art.is_menu) order[art.name] = (order[art.name] || 0) + (Number(o.amount) || 0);
    }
    const group = (cexObj(a) || {}).group || "adhoc";
    return { account_id: a.account_id, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null, rep: a.person_name || null, group, order };
  }));
  return { shops, accounts: accts.length };
}
// Кухненски екран ПО РАЗНОС ДЕН (работим ден напред): за разнос ден D показваме
// сметките, направени в навечерието (create_date == D−1, още отворени), плюс вече
// затворените за D (close_date/ref_date == D). Barsy не пуска бъдеща дата на сметка,
// затова разнос-денят се извежда от деня на правене + 1, не от датата на сметката.
async function seedRazos(razosDate, user, pass, includeSameDay) {
  const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 900 }, user, pass);
  let all = list.data || []; if (!Array.isArray(all)) all = Object.values(all);
  const prev = isoPlusDays(razosDate, -1);
  const accts = all.filter(a => {
    const cd = String(a.create_date || "").slice(0, 10);
    const cl = String(a.close_date || "").slice(0, 10);
    const rf = String(a.ref_date || "").slice(0, 10);
    // затворени/реф. за деня, или отворени направени в навечерието; при „Изтегли сметки"
    // (includeSameDay) и отворените, направени същата сутрин на разноса.
    return cl === razosDate || rf === razosDate || (!cl && (cd === prev || (includeSameDay && cd === razosDate)));
  });
  const shops = await Promise.all(accts.map(async (a) => {
    const rows = await cexCall("Orders_getlist", { filters: { account_id: a.account_id } }, user, pass);
    const order = {};
    let total = 0; // обща сума С ДДС (current_price вече е с ДДС) — за връзка към стокова
    for (const o of (rows.data || [])) {
      const art = byId(o.article_id) || resolve(o.article_name);
      const amt = Number(o.amount) || 0, pr = Number(o.current_price) || 0;
      if (amt && pr) total += Math.round(amt * pr * 100) / 100;
      if (art && art.is_menu) order[art.name] = (order[art.name] || 0) + amt;
    }
    const group = (cexObj(a) || {}).group || "adhoc";
    return { account_id: a.account_id, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null, rep: a.person_name || null, group, order, total: Math.round(total * 100) / 100 };
  }));
  return { shops, accounts: accts.length };
}

// Barsy справка „Продажби по артикули" (Reports_sales_by_articles) — ЕДНА заявка връща
// на артикул: cnt (бройки), total_no_dds (оборот без ДДС) и delivery_total (себестойност
// без ДДС, от AVG_DELIVERY_PRICE). Заменя крехкото Orders-страниране за COGS/маржин.
// Данните идват през „values" извикване (action_type:values + active_struct_id).
async function reportSalesByArticles(from, to, user, pass) {
  const by = {};   // article_id → { name, units, revenue, cost }
  let ok = false, incomplete = false;
  const PAGE = 50, MAXPG = 30;
  for (let pg = 1; pg <= MAXPG; pg++) {
    let rows = null;
    for (let t = 0; t < 3 && rows === null; t++) {
      try {
        const r = await cexCall("Reports_sales_by_articles",
          { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { ref_date: [from, to] } }, user, pass);
        if (r && r.ok && r.data && Array.isArray(r.data.rows)) { rows = r.data.rows; ok = true; }
      } catch (e) {}
      if (rows === null) await new Promise(res => setTimeout(res, 250 * (t + 1)));
    }
    if (rows === null) { incomplete = true; break; }
    for (const x of rows) {
      const id = String(x.article_id);
      const a = by[id] || (by[id] = { article_id: Number(x.article_id), name: x.article_name || ("#" + id), units: 0, revenue: 0, cost: 0 });
      a.units += Number(x.cnt) || 0;
      a.revenue += Number(x.total_no_dds) || 0;       // без ДДС
      a.cost += Number(x.delivery_total) || 0;        // себестойност без ДДС
    }
    if (rows.length < PAGE) break;                    // последна страница
  }
  return { ok, incomplete, articles: Object.values(by) };
}

// Маржин по клиент: справка „Продажби по сметки" (Reports_sales_by_accounts) приема
// filters.client = client_id и връща сборен ред totals за този клиент (без страниране!).
// Викаме по веднъж за всеки клиент (≤13). cost = delivery_total_dds/1.2 (то е С ДДС).
async function reportMarginByClient(from, to, clientIds, user, pass) {
  const out = {};
  const one = async cid => {
    for (let t = 0; t < 3; t++) {
      try {
        const r = await cexCall("Reports_sales_by_accounts",
          { active_struct_id: "eStructList_1", action_type: "values", page_num: 1, filters: { ref_date: [from, to], client: cid } }, user, pass);
        if (r && r.ok && r.data && r.data.totals && r.data.totals.total) {
          const tt = r.data.totals.total;
          const rev = Number(tt.total_no_dds) || 0;
          const cost = (Number(tt.delivery_total_dds) || 0) / VAT_CONST;
          return { rev: Math.round(rev * 100) / 100, cost: Math.round(cost * 100) / 100 };
        }
      } catch (e) {}
      await new Promise(res => setTimeout(res, 200 * (t + 1)));
    }
    return null;
  };
  // последователно (≤13 клиента) — да не претоварваме Barsy паралелно
  for (const cid of clientIds) { const v = await one(cid); if (v) out[cid] = v; }
  return out;
}
const VAT_CONST = 1.2;

// ── ДАШБОРД агрегатор (Фаза 1): оборот по ден + по клиент, издадени фактури, разлика.
// Оборот = сумата на ЗАТВОРЕНИТЕ сметки (`total_sum` е с ДДС → нето = /1.2), групиран по
// ден на затваряне и по клиент. Фактури = Invoices type_id 1 (не стокови 11), неанулирани.
async function dashData(from, to, expenses, user, pass) {
  const VAT = 1.2;
  const inRange = d => d && d >= from && d <= to;
  const arrOf = x => { let d = x && x.data; d = Array.isArray(d) ? d : (d && (d.list || (typeof d === "object" ? Object.values(d) : []))) || []; return Array.isArray(d) ? d : []; };
  // Оборотът и COGS по артикул идват от Barsy справката „Продажби по артикули"
  // (reportSalesByArticles) — авторитетна: оборотът ѝ съвпада със затворените сметки, а
  // себестойността е историческата (не крехкото Orders-страниране). Всичко паралелно.
  const [accR, invR, artR, stoR, salesRep, lotsRep] = await Promise.all([
    cexCall("Accounts_getlist", { order_by: "account_id desc", length: 8000 }, user, pass),
    cexCall("Invoices_getlist", { order_by: "inv_id desc", length: 5000 }, user, pass).catch(() => ({ data: [] })),
    cexCall("Articles_getlistobject", { filters: {}, depots: [1], extra_properties: ["avg_delivery_price", "store_amount"] }, user, pass).catch(() => ({ data: [] })),
    cexCall("Storeloads_getlist", { order_by: "store_load_id desc", length: 2000, extra_properties: ["all"] }, user, pass).catch(() => ({ data: [] })),
    reportSalesByArticles(from, to, user, pass).catch(() => ({ ok: false, incomplete: true, articles: [] })),
  ]);
  let all = arrOf(accR);
  const byDay = {};        // "YYYY-MM-DD" → нето оборот
  const byClient = {};     // client_id → { name, neto, n }
  let totalNeto = 0, accountsN = 0;
  for (const a of all) {
    if (String(a.account_alias || "").includes("CLTEST")) continue;
    const day = String(a.close_date || "").slice(0, 10);
    if (!inRange(day)) continue;                       // само затворени в периода
    const gross = Number(a.total_sum) || 0;
    if (!gross) continue;
    const neto = Math.round((gross / VAT) * 100) / 100;
    const cid = a.client_id != null ? a.client_id : 0;
    byDay[day] = Math.round(((byDay[day] || 0) + neto) * 100) / 100;
    const c = byClient[cid] || (byClient[cid] = { name: a.client_name || ("клиент " + cid), neto: 0, n: 0, last: "" });
    c.neto = Math.round((c.neto + neto) * 100) / 100; c.n++;
    if (day > c.last) c.last = day;
    totalNeto = Math.round((totalNeto + neto) * 100) / 100; accountsN++;
  }
  // издадени ФАКТУРИ (type_id 1) по клиент в периода (нето)
  const invByClient = {};
  let invTotalNeto = 0;
  for (const x of arrOf(invR)) {
    if (String(x.type_id) !== "1" || String(x.is_anulate) === "1") continue;
    if (!inRange(String(x.create_date || "").slice(0, 10))) continue;
    const cid = x.client_id != null ? x.client_id : 0;
    const neto = Number(x.total_neto) || 0;
    invByClient[cid] = Math.round(((invByClient[cid] || 0) + neto) * 100) / 100;
    invTotalNeto = Math.round((invTotalNeto + neto) * 100) / 100;
  }
  // клиентска таблица: оборот, фактурирано, разлика (липсва фактура)
  // ИТТ (служители ИТТ) НЕ се фактурира през този цех → изключен от „без фактура".
  const noInvoice = n => /итт/i.test(String(n || ""));
  const clients = Object.entries(byClient).map(([cid, c]) => {
    const invoiced = invByClient[cid] || 0;
    const exempt = noInvoice(c.name);
    return { client_id: Number(cid), name: c.name, turnover: c.neto, accounts: c.n, invoiced,
      gap: exempt ? 0 : Math.round((c.neto - invoiced) * 100) / 100, exempt, last: c.last,
      avg_check: c.n ? Math.round((c.neto / c.n) * 100) / 100 : 0 };
  }).sort((a, b) => b.turnover - a.turnover);
  // общо „без фактура" = сумата на разликите БЕЗ освободените клиенти (ИТТ)
  const gapNeto = Math.round(clients.reduce((s, c) => s + c.gap, 0) * 100) / 100;
  // МАРЖИН ПО КЛИЕНТ (от справка „Продажби по сметки", filters.client) — реален
  const marginRep = await reportMarginByClient(from, to, clients.map(c => c.client_id), user, pass).catch(() => ({}));
  for (const c of clients) {
    const mr = marginRep[c.client_id];
    if (mr && mr.rev > 0) {
      c.cost = mr.cost; c.profit = Math.round((mr.rev - mr.cost) * 100) / 100;
      c.margin = Math.round((c.profit / mr.rev) * 1000) / 10;   // %
    }
  }

  // ── ФАЗА 2: себестойност + печалба по артикул (от справка „Продажби по артикули") ──
  // СКЛАД в пари: наличност (store_amount) × средна себестойност/бр, само положителните
  // (суровини със знак минус са незаписани зареждания и биха обезсмислили сумата).
  let stockValue = 0, stockItems = 0;
  for (const a of arrOf(artR)) {
    const id = a && (a.article_id || a.id); if (id == null) continue;
    const c = Number(a.avg_delivery_price) || 0;
    const q = Number(a.store_amount) || 0;
    if (q > 0 && c > 0) { stockValue += q * c; stockItems++; }
  }
  stockValue = Math.round(stockValue * 100) / 100;
  // Продадени артикули + себестойност — директно от Barsy справката (авторитетно).
  const unitsTrunc = !!(salesRep && salesRep.incomplete);
  const products = (salesRep && salesRep.articles || []).map(a => {
    const un = Math.round(a.units * 1000) / 1000;
    const rev = Math.round(a.revenue * 100) / 100;
    const tc = Math.round(a.cost * 100) / 100;
    return { article_id: a.article_id, name: a.name, units: un,
      unit_cost: un ? Math.round((a.cost / un) * 100) / 100 : 0,
      total_cost: tc, revenue: rev, profit: Math.round((rev - tc) * 100) / 100 };
  }).filter(p => p.units > 0).sort((a, b) => b.revenue - a.revenue);
  const cogs = Math.round(products.reduce((s, p) => s + p.total_cost, 0) * 100) / 100;
  const exp = Math.round((Number(expenses) || 0) * 100) / 100;
  const result = Math.round((totalNeto - cogs - exp) * 100) / 100;

  // ── ФАЗА 3: зареждания (доставки) за периода — суми без ДДС, по доставчик ──
  // Storeloads с extra:["all"] носят doc_date/supplier_name/total_sum/has_tax.
  const loadsBySupplier = {};
  const loadsByMonth = {};   // "YYYY-MM" → нето
  let loadsNeto = 0, loadsN = 0;
  for (const s of arrOf(stoR)) {
    if (Number(s.operation_type) !== 1) continue;          // само зареждания (не ревизии/връщания)
    const day = String(s.doc_date || s.date || "").slice(0, 10);
    if (!inRange(day)) continue;
    const gross = Number(s.total_sum) || 0; if (!gross) continue;
    const neto = Number(s.has_tax) === 1 ? Math.round((gross / VAT) * 100) / 100 : gross;
    const sup = s.supplier_name || ("доставчик " + (s.supplier_id || ""));
    loadsBySupplier[sup] = Math.round(((loadsBySupplier[sup] || 0) + neto) * 100) / 100;
    const ym = day.slice(0, 7);
    loadsByMonth[ym] = Math.round(((loadsByMonth[ym] || 0) + neto) * 100) / 100;
    loadsNeto = Math.round((loadsNeto + neto) * 100) / 100; loadsN++;
  }
  const suppliers = Object.entries(loadsBySupplier).map(([name, neto]) => ({ name, neto })).sort((a, b) => b.neto - a.neto);
  const avgCheck = accountsN ? Math.round((totalNeto / accountsN) * 100) / 100 : 0;

  // ── СЪВЕТИ / НАБЛЮДЕНИЯ (автоматични изводи от данните) ──────────────────────
  const insights = [];
  const money = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  // 1) последен пълен месец спрямо предходния (по оборот)
  const byMonth = {};
  for (const d in byDay) { const ym = d.slice(0, 7); byMonth[ym] = (byMonth[ym] || 0) + byDay[d]; }
  const months = Object.keys(byMonth).sort();
  const curYm = to.slice(0, 7);
  const full = months.filter(m => m < curYm);          // изключваме текущия (непълен) месец
  if (full.length >= 2) {
    const a = byMonth[full[full.length - 1]], b = byMonth[full[full.length - 2]];
    if (b) { const d = (a - b) / b * 100;
      insights.push({ t: d >= 0 ? "good" : "bad", text: `Оборот ${full[full.length - 1]}: ${money(a)} — ${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}% спрямо ${full[full.length - 2]} (${money(b)}).` }); }
  }
  // 2) обща рентабилност
  if (totalNeto > 0 && !unitsTrunc) {
    const m = result / totalNeto * 100;
    insights.push({ t: m >= 35 ? "good" : m >= 20 ? "warn" : "bad", text: `Обща рентабилност за периода: ${m.toFixed(1)}% (резултат ${money(result)}).` });
  }
  // 3) чакат фактура
  const wait = clients.filter(c => !c.exempt && c.gap > 0.5);
  if (wait.length) insights.push({ t: "warn", text: `${wait.length} клиента чакат фактура — общо ${money(gapNeto)}. Най-много: ${wait.sort((x, y) => y.gap - x.gap)[0].name} (${money(wait[0].gap)}).` });
  // 4) спрели клиенти (>14 дни без поръчка спрямо края на периода)
  const toDate = new Date(to + "T12:00:00Z");
  const stopped = clients.filter(c => c.last).map(c => ({ c, ago: Math.round((toDate - new Date(c.last + "T12:00:00Z")) / 864e5) })).filter(o => o.ago >= 14).sort((a, b) => b.ago - a.ago);
  if (stopped.length) insights.push({ t: "bad", text: `${stopped.length} клиента не са поръчвали ≥14 дни. Най-дълго: ${stopped[0].c.name} (${stopped[0].ago} дни, оборот ${money(stopped[0].c.turnover)}) — струва си обаждане.` });
  // 5) най-печеливш / най-нисък маржин клиент (реален, от справката)
  const withM = clients.filter(c => c.margin != null && c.turnover > 100);
  if (withM.length >= 2) {
    const best = withM.slice().sort((a, b) => b.margin - a.margin)[0];
    const worst = withM.slice().sort((a, b) => a.margin - b.margin)[0];
    insights.push({ t: "info", text: `Най-печеливш клиент: ${best.name} (${best.margin.toFixed(1)}% маржин). Най-нисък: ${worst.name} (${worst.margin.toFixed(1)}%) — виж цените му.` });
  }
  const bigC = clients.filter(c => !c.exempt).sort((a, b) => b.turnover - a.turnover)[0];
  if (bigC) insights.push({ t: "info", text: `Най-голям клиент: ${bigC.name} — ${money(bigC.turnover)} (${totalNeto ? Math.round(bigC.turnover / totalNeto * 100) : 0}% от оборота).` });
  // 6) артикул с най-нисък и най-висок маржин
  const pm = products.filter(p => p.revenue > 50).map(p => ({ p, m: p.profit / p.revenue * 100 }));
  if (pm.length) { const low = pm.slice().sort((a, b) => a.m - b.m)[0]; const hi = pm.slice().sort((a, b) => b.m - a.m)[0];
    insights.push({ t: low.m < 25 ? "warn" : "info", text: `Маржин по артикул: най-нисък ${low.p.name} (${low.m.toFixed(1)}%), най-висок ${hi.p.name} (${hi.m.toFixed(1)}%).` }); }
  // 7) склад
  if (stockValue > 0) insights.push({ t: "info", text: `В склада стоят ${money(stockValue)} по себестойност (${stockItems} артикула).` });

  return { from, to, total_neto: totalNeto, accounts: accountsN, by_day: byDay, invoiced_neto: invTotalNeto, clients,
    gap_neto: gapNeto, stock_value: stockValue, stock_items: stockItems, avg_check: avgCheck,
    cogs, expenses: exp, result, products, units_truncated: unitsTrunc, insights,
    loads_neto: loadsNeto, loads_count: loadsN, suppliers, loads_by_month: loadsByMonth };
}

// ── Зареждане ПО ГРАФИК (не по дата на затваряне, която закъснява). Обектът и
// групата се разпознават ПО ID от регистъра CEX_OBJECTS (виж по-долу), не по име;
// количествата = ПОСЛЕДНАТА реална заявка на обекта към датата. Графикът е на
// собственика (виж memory motamo-cex-delivery-schedule).
// dow: 0 нд .. 6 сб. Сибиес=всеки ден · Мерканто=вт(2)/пт(5) · Хасково=пн(1)/ср(3)/пт(5).
function cexDueOn(group, dow) {
  if (group === "sibies") return true;
  if (group === "merkanto") return dow === 2 || dow === 5;
  if (group === "haskovo") return dow === 1 || dow === 3 || dow === 5;
  return false; // adhoc — само по заявка (нетикнато)
}

// ── РЕГИСТЪР НА ОБЕКТИТЕ ПО ID (ключ „client_id:person_id"; празен person = клиент
// без под-обект). „По график" хваща обектите ОТ ТУК — по id, не по име, за да няма
// никога грешка. Обект извън регистъра НЕ се показва (клиентският ред „СИБИЕС ООД"
// без обект, тестови/непознати обекти). group sibies/merkanto/haskovo имат график;
// adhoc се показва, но не се тика (излиза само при реална поръчка). Собственикът
// потвърди списъка 2026-09-07 (вкл. СИБИЕС „Три чучура 13а" pid 7 и Казанлък pid 13).
const CEX_OBJECTS = {
  // Хасково — ХАЙ ЛЕВЕЛ ЛИМИТЕД (клиент 9, без под-обект)
  "9:": { group: "haskovo" },
  // Стара Загора и региона — СИБИЕС ООД (клиент 2)
  "2:1": { group: "sibies" },  "2:2": { group: "sibies" },  "2:3": { group: "sibies" },
  "2:4": { group: "sibies" },  "2:5": { group: "sibies" },  "2:6": { group: "sibies" },
  "2:7": { group: "sibies" },  "2:8": { group: "sibies" },  "2:9": { group: "sibies" },
  "2:10": { group: "sibies" }, "2:11": { group: "sibies" }, "2:12": { group: "sibies" },
  "2:13": { group: "sibies" }, "2:14": { group: "sibies" }, "2:15": { group: "sibies" },
  // Сливен — Мерканто / АНТОНИЙ ЕООД (клиент 11)
  "11:23": { group: "merkanto" }, "11:25": { group: "merkanto" }, "11:26": { group: "merkanto" },
  "11:27": { group: "merkanto" }, "11:28": { group: "merkanto" }, "11:29": { group: "merkanto" },
  "11:30": { group: "merkanto" }, "11:31": { group: "merkanto" }, "11:32": { group: "merkanto" },
  // Ад-хок / по заявка (показват се, но не се тикат)
  "4:": { group: "adhoc" }, "8:": { group: "adhoc" }, "8:21": { group: "adhoc" }, "8:22": { group: "adhoc" },
  "5:": { group: "adhoc" }, "5:16": { group: "adhoc" }, "5:17": { group: "adhoc" }, "5:18": { group: "adhoc" },
  "12:": { group: "adhoc" }, "7:": { group: "adhoc" }, "10:": { group: "adhoc" }, "13:": { group: "adhoc" }, "3:": { group: "adhoc" }
};
function cexKey(a) { return (a.client_id != null ? a.client_id : "") + ":" + (a.person_id != null ? a.person_id : ""); }
function cexObj(a) { return CEX_OBJECTS[cexKey(a)] || null; }

async function scheduleSeed(dateIso, user, pass) {
  const dow = new Date(dateIso + "T12:00:00Z").getUTCDay();
  const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 2000 }, user, pass);
  let all = list.data || []; if (!Array.isArray(all)) all = Object.values(all);
  // „По график <дата>" гледа историята КЪМ тази дата: броим само сметки от/преди нея.
  // Така обект без сметка до тази дата НЕ се показва (напр. по-късни тестови сметки не
  // изкарват обекти, които никога не сме зареждали), а количествата са последната
  // реална поръчка на обекта към деня.
  // Стъпваме на ЗАТВОРЕНИ сметки = реалният разнос (отворените чернови/тестове се
  // игнорират). Броим само затворени с `close_date` ≤ избраната дата.
  const closedOf = a => String(a.close_date || "").slice(0, 10);
  all = all.filter(a => { const cd = closedOf(a); return cd && cd <= dateIso; });
  // Най-скорошната ЗАТВОРЕНА сметка на всеки ОБЕКТ (по дата на затваряне).
  // Показваме САМО обекти от регистъра (по id) — непознати/клиентски редове отпадат.
  const seen = {};
  for (const a of all) {
    if (String(a.account_alias || "").includes("CLTEST")) continue;
    const key = cexKey(a);
    if (!CEX_OBJECTS[key]) continue;
    if (!seen[key] || closedOf(a) > closedOf(seen[key])) seen[key] = a;
  }
  const entries = Object.values(seen);
  // Резерва за ПЛАНИРАНЕ НАПРЕД: ако денят още няма затворени сметки (утрешен разнос),
  // тикаме активните от последните N дни — последната им затворена поръчка като база.
  const cutoff = new Date(dateIso + "T00:00:00Z"); cutoff.setUTCDate(cutoff.getUTCDate() - 14);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let shops = await mapLimit(entries, 6, async (a) => {
    const g = (cexObj(a) || {}).group || "adhoc";
    const rows = await cexCall("Orders_getlist", { filters: { account_id: a.account_id } }, user, pass);
    const order = {};
    for (const o of (rows.data || [])) {
      const art = byId(o.article_id) || resolve(o.article_name);
      if (art && art.is_menu) order[art.name] = (order[art.name] || 0) + (Number(o.amount) || 0);
    }
    const lastStr = closedOf(a);
    const hasOrder = Object.values(order).some(v => v > 0);
    const onDate = lastStr === dateIso;            // затворена ТОЧНО на деня = реален разнос
    const recent = lastStr >= cutoffStr;           // активен в последните 14 дни (за прогноза)
    return { account_id: a.account_id, last_date: lastStr, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null, rep: a.person_name || null, group: g, onDate, recent, hasOrder, order };
  });
  // Ако денят ИМА затворени сметки (минал/реален ден) → тикаме само точните за деня.
  // Иначе (планиране напред) → тикаме активните от последните 14 дни като прогноза.
  const anyOnDate = shops.some(s => s.onDate && s.hasOrder);
  for (const s of shops) s.scheduled = s.hasOrder && (anyOnDate ? s.onDate : s.recent);
  // Скриваме обекти без поръчка от >30 дни (за да не се тъпче решетката със стари справки).
  // Тикнатите остават винаги; стар обект се появява пак сам, щом му дойде затворена сметка.
  const staleCut = new Date(dateIso + "T00:00:00Z"); staleCut.setUTCDate(staleCut.getUTCDate() - 30);
  const staleCutStr = staleCut.toISOString().slice(0, 10);
  shops = shops.filter(s => s.scheduled || s.last_date >= staleCutStr);
  // Подредба: първо дължимите днес, после по група, после по име.
  const grank = { sibies: 0, merkanto: 1, haskovo: 2, adhoc: 3 };
  shops.sort((x, y) => (Number(y.scheduled) - Number(x.scheduled)) || ((grank[x.group] || 9) - (grank[y.group] || 9)) || String(x.rep || x.client || "").localeCompare(String(y.rep || y.client || ""), "bg"));
  return { shops, dow };
}
// UUID за идемпотентност — един и същ за (ден+магазин), за да не се дублира сметка.
function uuidFor(date, s) {
  const key = `${date}|${s.client_id || ""}|${s.person_id || ""}|${s.rep || ""}`;
  const h = crypto.createHash("sha1").update(key).digest("hex");
  const v = "5" + h.slice(13, 16), a = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return [h.slice(0, 8), h.slice(8, 12), v, a, h.slice(20, 32)].join("-");
}
// Създава ОТВОРЕНИ сметки-чернови по магазин (без затваряне → без фискален бон, без склад).
async function createAccounts(shops, date, user, pass, lotOverride) {
  const out = [];
  // Партида на реда = същата като производството (L.<дата>), за да се роди сметката
  // ВЕЧЕ с партида (Accounts_place приема lot_value на реда). Празна → без партида.
  const lot = (typeof lotOverride === "string") ? lotOverride : lotFor(date).lot;
  for (const s of shops) {
    const orders = Object.entries(s.order || {})
      .map(([name, qty]) => { const art = resolve(name); return art ? (lot ? { article_id: art.id, amount: Number(qty), lot_value: lot } : { article_id: art.id, amount: Number(qty) }) : null; })
      .filter(o => o && o.amount > 0);   // цена НЕ подаваме → Barsy слага по ценово правило на клиента
    if (!orders.length) { out.push({ client: s.client, rep: s.rep, skipped: "празна" }); continue; }
    const account = {
      uuid: uuidFor(date, s),
      account_alias: [s.client, s.rep].filter(Boolean).join(" · ") || "ОНЛАЙН"
    };
    if (s.client_id) account.client_id = s.client_id;
    if (s.person_id) account.person_id = s.person_id;
    let r;
    try { r = await cexCall("Accounts_place", { account, orders, flag_close_account: 0 }, user, pass); }
    catch (e) { out.push({ client: s.client, rep: s.rep, ok: false, error: String(e && e.message) }); continue; }
    const accId = typeof r.data === "number" ? r.data : (r.data && (r.data.account_id || r.data.id)) || null;
    out.push({ client: s.client, rep: s.rep, ok: !!r.ok, account_id: accId, items: orders.length,
      error: r.ok ? undefined : String(r.raw || "").slice(0, 200) });
  }
  return out;
}
function explodeToRolls(order) {
  const rolls = {};
  const add = (name, qty) => {
    const art = resolve(name);
    if (!art) { rolls[name] = (rolls[name] || 0) + qty; return; }
    if (art.is_set) { for (const c of art.components) { const cart = c.id != null ? byId(c.id) : resolve(c.name); if (cart && cart.is_menu) add(cart.name, qty * c.qty); } }
    else rolls[art.name] = (rolls[art.name] || 0) + qty;
  };
  for (const [k, v] of Object.entries(order || {})) add(k, Number(v) || 0);
  return rolls;
}
function rollsToZag(rolls) {
  const zag = {};
  const walk = (name, qty) => {
    const art = resolve(name); if (!art) return;
    for (const c of art.components) { const cart = c.id != null ? byId(c.id) : resolve(c.name); if (cart && cart.cat === "Заготовки") { zag[cart.name] = (zag[cart.name] || 0) + qty * c.qty; walk(cart.name, qty * c.qty); } }
  };
  for (const [k, v] of Object.entries(rolls || {})) walk(k, Number(v) || 0);
  return zag;
}
// Пълна разбивка на дневната заявка до ВСЯКА заготовка+суровина (консумация по
// рецепти, всички нива). Връща {article_id: количество}. Това е „произв. по
// стокови разписки" за цех-листа.
function fullBOM(orderMap) {
  const need = {};
  const add = (art, qty) => {
    if (!art || !(qty > 0)) return;
    if (art.cat === "Заготовки" || art.cat === "Суровини") need[art.id] = (need[art.id] || 0) + qty;
    for (const c of (art.components || [])) { const ca = c.id != null ? byId(c.id) : resolve(c.name); if (ca) add(ca, qty * (Number(c.qty) || 0)); }
  };
  for (const [name, qty] of Object.entries(orderMap || {})) add(resolve(name), Number(qty) || 0);
  return need;
}
const round = n => Math.round(n * 1000) / 1000;
function sortObj(o, d) { const out = {}; Object.keys(o || {}).sort().forEach(k => out[k] = Math.round(o[k] * 10 ** d) / 10 ** d); return out; }
const sofiaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());
const sofiaTime = () => new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit" }).format(new Date());
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function compute(shops) {
  const agg = {};
  for (const s of shops) for (const [k, v] of Object.entries(s.order || {})) agg[k] = (agg[k] || 0) + (Number(v) || 0);
  return { agg, rolls: explodeToRolls(agg), zag: rollsToZag(explodeToRolls(agg)) };
}
// Партида/срок: партида = L.<деня на производство>, срок = +3 дни (правилото на цеха).
function isoToDDMMYYYY(iso) { const p = String(iso).split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso; }
function isoPlusDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lotFor(prodDateIso) { return { lot: "L." + isoToDDMMYYYY(prodDateIso), lot_exp: isoToDDMMYYYY(isoPlusDays(prodDateIso, 3)) }; }

// ── HTML: екран за цеха (само четене) ────────────────────────────────────────
function todayPage(inner) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="180">
<title>Цех · днес за производство</title><style>
:root{color-scheme:light}*{box-sizing:border-box}
body{font:17px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#eef0f3;color:#14171a}
header{background:linear-gradient(135deg,#b3121b,#7a0c12);color:#fff;padding:18px 20px;position:sticky;top:0;z-index:5;box-shadow:0 2px 12px rgba(0,0,0,.18)}
header h1{margin:0;font-size:26px;font-weight:800;letter-spacing:.3px}
header .d{font-size:15px;opacity:.93;margin-top:4px}
.wrap{padding:16px;max-width:860px;margin:0 auto;display:grid;gap:16px}
.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(20,23,26,.08)}
.card>h2{margin:0;font-size:16px;font-weight:800;color:#fff;padding:13px 18px;letter-spacing:.6px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
.card>h2 .cnt{font-size:13px;font-weight:600;opacity:.9;background:rgba(255,255,255,.22);padding:2px 10px;border-radius:20px}
.card.sets>h2{background:#b8860b}.card.rolls>h2{background:#b3121b}.card.zag>h2{background:#2b7a78}.card.route>h2{background:#374151}
.card table{width:100%;border-collapse:collapse}
.card td{padding:13px 18px;font-size:21px;border-top:1px solid #f1f2f4}
.card tr:first-child td{border-top:0}
.card td.q{text-align:right;font-weight:800;font-size:27px;white-space:nowrap;font-variant-numeric:tabular-nums}
.card.sets td.q{color:#8a6608}.card.rolls td.q{color:#b3121b}.card.zag td.q{color:#1f5b59}
.card tr:nth-child(even) td{background:#fafbfc}
.card.route .scroll{overflow-x:auto}
.card.route th{padding:11px 14px;font-size:14px;font-weight:800;color:#374151;background:#eef0f3;text-align:right;white-space:nowrap;position:sticky;top:0}
.card.route th.n{text-align:left}
.card.route td{padding:11px 14px;font-size:17px}
.card.route td.n{font-weight:600;white-space:nowrap}
.card.route td.q{font-size:20px;color:#111827}
.card.route td.q.zero{color:#c9ced4;font-weight:500}
.card.route th.tot,.card.route td.q.tot{color:#b3121b;border-left:2px solid #e6e8eb}
.empty{background:#fff;border-radius:16px;padding:34px 20px;text-align:center;color:#555;box-shadow:0 2px 8px rgba(20,23,26,.08)}
.empty h2{margin:0 0 8px;font-size:23px;color:#14171a}
.note{color:#7a8087;font-size:13px;text-align:center;margin:2px 0 20px}
@media (max-width:520px){header h1{font-size:22px}.wrap{padding:12px;gap:13px}.card td{font-size:19px;padding:12px 15px}.card td.q{font-size:24px}}
</style></head><body>${inner}</body></html>`;
}

// ── HTML: ЦЕХ ДАШБОРД (красив + интерактивен, Chart.js) ───────────────────────
function dashboardPage(data, k) {
  const bg = n => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const err = data && data.error;
  const mcol = c => c.margin != null ? `<td class="q" style="color:${c.margin >= 45 ? "#0a6b2e" : c.margin >= 30 ? "#b06a00" : "#b3121b"};font-weight:800">${c.margin.toLocaleString("bg-BG", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%</td>` : `<td class="c">—</td>`;
  const rows = err ? "" : (data.clients || []).map(c => `<tr><td class="n">${esc(c.name)}${c.exempt ? ' <span class="tag">не се фактурира</span>' : ""}</td><td class="q">${bg(c.turnover)}</td>${mcol(c)}<td class="q inv">${bg(c.invoiced)}</td><td class="q gap${!c.exempt && c.gap > 0.5 ? " bad" : ""}">${c.exempt ? "—" : bg(c.gap)}</td><td class="c">${c.accounts}</td></tr>`).join("");
  const tips = err ? "" : (data.insights || []).map(x => `<li class="${x.t}"><span class="ic">${x.t === "good" ? "✅" : x.t === "warn" ? "⚠️" : x.t === "bad" ? "🔴" : "💡"}</span><span>${esc(x.text)}</span></li>`).join("");
  const gapNeto = err ? 0 : (data.gap_neto != null ? data.gap_neto : (data.total_neto - data.invoiced_neto));
  const waiting = err ? [] : (data.clients || []).filter(c => !c.exempt && c.gap > 0.5).sort((a, b) => b.gap - a.gap);
  const waitRows = waiting.map(c => `<tr><td class="n">${esc(c.name)}</td><td class="q">${bg(c.turnover)}</td><td class="q inv">${bg(c.invoiced)}</td><td class="q gap bad">${bg(c.gap)}</td></tr>`).join("");
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Цех · Дашборд</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script><style>
:root{color-scheme:light}*{box-sizing:border-box}
body{font:15px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#eef0f3;color:#14171a}
header{background:linear-gradient(135deg,#374151,#1f2937);color:#fff;padding:16px 20px;position:sticky;top:0;z-index:5;box-shadow:0 2px 12px rgba(0,0,0,.18)}
header h1{margin:0;font-size:22px;font-weight:800}
header .d{font-size:14px;opacity:.9;margin-top:3px}
.wrap{padding:16px;max-width:960px;margin:0 auto;display:grid;gap:16px}
form.period{display:flex;gap:8px;align-items:end;flex-wrap:wrap;background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 2px 8px rgba(20,23,26,.08)}
form.period label{font-size:12px;color:#555;display:block}
form.period input{font:14px system-ui;padding:6px 8px;border:1px solid #d7dade;border-radius:7px}
form.period button{font:14px system-ui;font-weight:700;padding:7px 14px;border:0;border-radius:7px;background:#374151;color:#fff;cursor:pointer}
.quick{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.quick a{font:12px system-ui;font-weight:700;text-decoration:none;color:#374151;background:#e7eaef;border-radius:20px;padding:5px 12px}
.quick a:hover{background:#d7dbe2}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:#fff;border-radius:12px;padding:14px 16px;box-shadow:0 2px 8px rgba(20,23,26,.08);border-left:5px solid #cfd4da;transition:transform .12s}
.kpi:hover{transform:translateY(-2px)}
.kpi .l{font-size:12px;color:#7a8087;text-transform:uppercase;letter-spacing:.4px}
.kpi .v{font-size:26px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi.turn{border-color:#1f5b59}.kpi.turn .v{color:#1f5b59}
.kpi.inv{border-color:#8a6608}.kpi.inv .v{color:#8a6608}
.kpi.gap{border-color:#b3121b}.kpi.gap .v{color:#b3121b}
.kpi.cost{border-color:#b06a00}.kpi.cost .v{color:#b06a00}
.kpi.exp{border-color:#7a4b8a}.kpi.exp .v{color:#7a4b8a}
.kpi.res{border-color:#0a6b2e}.kpi.res .v{color:#0a6b2e}
.kpi.load{border-color:#2b6ca3}.kpi.load .v{color:#2b6ca3}
.kpi.stock{border-color:#0d7a6f}.kpi.stock .v{color:#0d7a6f}
.kpi .s{font-size:11px;color:#9aa0a6;margin-top:2px}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(20,23,26,.08)}
.card>h2{margin:0;font-size:15px;font-weight:800;color:#fff;background:#374151;padding:11px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.card>h2>span:not(.seg){font-size:12px;font-weight:600;opacity:.85}
.seg{display:flex;gap:4px}.seg button{font:12px system-ui;font-weight:700;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:rgba(255,255,255,.2);color:#fff}
.seg button.on{background:#fff;color:#374151}
.chartbox{padding:14px 16px 6px}.chartbox.donut{display:flex;justify-content:center}
.chartbox canvas{max-height:300px}
details.tbl{border-top:1px solid #eef0f3}details.tbl>summary{cursor:pointer;padding:9px 16px;font-size:12px;font-weight:700;color:#7a8087;text-transform:uppercase;letter-spacing:.3px;list-style:none}
details.tbl>summary::-webkit-details-marker{display:none}details.tbl>summary::before{content:"▸ ";}details.tbl[open]>summary::before{content:"▾ ";}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 14px;font-size:14px;border-top:1px solid #f1f2f4;text-align:left}
th{background:#f7f8fa;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.3px}
td.q,th.q{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td.q{font-weight:700}td.inv{color:#8a6608}td.gap{color:#1f7a3a}td.gap.bad{color:#b3121b;font-weight:800}
td.c{text-align:right;color:#7a8087}
.tag{display:inline-block;font-size:10px;font-weight:700;color:#7a4b8a;background:#f0e8f5;border-radius:10px;padding:1px 7px;vertical-align:1px;text-transform:uppercase;letter-spacing:.3px}
.tips{list-style:none;margin:0;padding:8px 10px;display:grid;gap:8px}
.tips li{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;font-size:14px;line-height:1.35;background:#f7f8fa;border-left:5px solid #9aa0a6}
.tips li .ic{font-size:16px;flex:0 0 auto;line-height:1.2}
.tips li.good{background:#eaf6ee;border-color:#0a6b2e}.tips li.warn{background:#fdf3e3;border-color:#b06a00}
.tips li.bad{background:#fdecec;border-color:#b3121b}.tips li.info{background:#eef3f8;border-color:#2b6ca3}
tr:nth-child(even) td{background:#fafbfc}
.note{color:#7a8087;font-size:12px;text-align:center;margin:2px 0 20px}
.err{background:#fff;border-radius:12px;padding:24px;text-align:center;color:#b3121b}
@media(max-width:520px){th,td{padding:8px 10px;font-size:13px}.kpi .v{font-size:22px}}
</style></head><body>
<header><h1>🍣 Цех · Дашборд</h1><div class="d">${err ? "грешка" : esc(data.from) + " – " + esc(data.to) + " · " + (data.accounts || 0) + " сметки · оборот без ДДС"}</div></header>
<div class="wrap">
<form class="period" method="get">
  <input type="hidden" name="view" value="dashboard">${k ? `<input type="hidden" name="k" value="${esc(k)}">` : ""}
  <div><label>от</label><input type="date" name="from" lang="bg-BG" value="${esc((data && data.from) || "")}"></div>
  <div><label>до</label><input type="date" name="to" lang="bg-BG" value="${esc((data && data.to) || "")}"></div>
  <div><label>разходи €</label><input type="number" step="0.01" name="exp" value="${err ? "" : (data.expenses || 0)}" style="width:90px"></div>
  <button type="submit">Покажи</button>
  <div class="quick" id="quick"></div>
</form>
${err ? `<div class="err"><h2>Грешка</h2><p>${esc(String(err))}</p></div>` : `
<div class="kpis">
  <div class="kpi turn"><div class="l">Оборот (без ДДС)</div><div class="v">${bg(data.total_neto)} €</div></div>
  <div class="kpi cost"><div class="l">Себестойност${data.units_truncated ? " ⚠" : ""}</div><div class="v">${data.units_truncated ? "~" : ""}${bg(data.cogs)} €</div></div>
  <div class="kpi exp"><div class="l">Разходи</div><div class="v">${bg(data.expenses)} €</div></div>
  <div class="kpi res"><div class="l">Резултат${data.units_truncated ? " ⚠" : ""}</div><div class="v">${data.units_truncated ? "~" : ""}${bg(data.result)} €</div></div>
  <div class="kpi inv"><div class="l">Фактурирано</div><div class="v">${bg(data.invoiced_neto)} €</div></div>
  <div class="kpi gap"><div class="l">Без фактура</div><div class="v">${bg(gapNeto)} €</div><div class="s">ИТТ изключен</div></div>
  <div class="kpi load"><div class="l">Зареждания</div><div class="v">${bg(data.loads_neto)} €</div></div>
  <div class="kpi stock"><div class="l">Склад (в пари)</div><div class="v">${bg(data.stock_value)} €</div><div class="s">${data.stock_items || 0} артикула · себест.</div></div>
  <div class="kpi"><div class="l">Сметки</div><div class="v">${data.accounts || 0}</div><div class="s">среден чек ${bg(data.avg_check)} €</div></div>
</div>
${tips ? `<div class="card"><h2>💡 Съвети / Наблюдения</h2><ul class="tips">${tips}</ul></div>` : ""}
<div class="card"><h2>Оборот по период<span class="seg" id="seg"><button data-g="day">Ден</button><button data-g="week">Седмица</button><button data-g="month" class="on">Месец</button></span></h2>
  <div class="chartbox"><canvas id="cTrend" height="150"></canvas></div>
  <details class="tbl" open><summary>таблица · сравнение спрямо предходния</summary>
  <table><thead><tr><th>Период</th><th class="q">Оборот без ДДС</th><th class="q">Δ предх.</th></tr></thead><tbody id="bkt"></tbody></table></details></div>
<div class="card"><h2>Оборот по клиент<span>дял от оборота</span></h2>
  <div class="chartbox donut"><canvas id="cClients" height="260" style="max-width:420px"></canvas></div>
  <details class="tbl" open><summary>таблица</summary>
  <table><thead><tr><th>Клиент</th><th class="q">Оборот</th><th class="q">Маржин</th><th class="q">Фактурирано</th><th class="q">Без фактура</th><th class="q">Сметки</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="note">Няма затворени сметки в периода.</td></tr>'}</tbody></table></details></div>
<div class="card"><h2>📄 Чакат фактура<span>${waiting.length} клиента · общо ${bg(gapNeto)} €</span></h2>
  <table><thead><tr><th>Клиент</th><th class="q">Оборот</th><th class="q">Фактурирано</th><th class="q">Без фактура</th></tr></thead>
  <tbody>${waitRows || '<tr><td colspan="4" class="note">Всичко е фактурирано 🎉</td></tr>'}</tbody></table></div>
<div class="card"><h2>⚠️ Спрели клиенти<span class="seg" id="stopseg">от <input id="stopdays" type="number" value="14" min="1" style="width:52px;font:12px system-ui;border:0;border-radius:6px;padding:3px 6px;text-align:center"> дни</span></h2>
  <table><thead><tr><th>Клиент</th><th class="q">Оборот</th><th class="q">Последна</th><th class="q">Преди</th></tr></thead><tbody id="stoprows"></tbody></table></div>
<div class="card"><h2>🏆 Топ артикули · оборот · печалба<span class="seg" id="prodseg"><button data-s="revenue" class="on">по оборот</button><button data-s="profit">по печалба</button></span></h2>
  <table><thead><tr><th>Артикул</th><th class="q">Бройки</th><th class="q">Оборот</th><th class="q">Себест.</th><th class="q">Печалба</th><th class="q">Маржин</th></tr></thead>
  <tbody id="prodrows"></tbody></table></div>
<div class="card"><h2>🚚 Зареждания<span>${(data.suppliers || []).length} доставчика · ${data.loads_count || 0} документа · ${bg(data.loads_neto)} €</span></h2>
  <div class="chartbox"><canvas id="cLoads" height="130"></canvas></div>
  <details class="tbl" open><summary>по доставчик</summary>
  <table><thead><tr><th>Доставчик</th><th class="q">Сума без ДДС</th></tr></thead>
  <tbody>${(data.suppliers || []).map(s => `<tr><td class="n">${esc(s.name)}</td><td class="q">${bg(s.neto)}</td></tr>`).join("") || '<tr><td colspan="2" class="note">Няма зареждания в периода.</td></tr>'}</tbody></table></details></div>
<div class="note">Всичко е <b>без ДДС</b>. Оборот = затворените сметки (total_sum/1.2). Маржин по клиент = справка „Продажби по сметки" (себест. без ДДС). Себестойност и печалба по артикул идват от Barsy справка „Продажби по артикули" (историческа себестойност). „Без фактура" = оборот − фактури (тип 1), <b>без клиенти които не се фактурират (ИТТ)</b>; стоковите (тип 11) не са фактури. <b>Внимание:</b> фактурите не са календарен месец (част от края на месеца влизат в следващия). Склад = наличност × средна себестойност/бр (само положителни). Резултат = оборот − себестойност − разходи.${data.units_truncated ? " ⚠ Справката не се зареди докрай — числата може да са частични, презареди." : ""}</div>
<script>
var BYDAY=${err ? "{}" : JSON.stringify(data.by_day || {})};
var CLIENTS=${err ? "[]" : JSON.stringify((data.clients || []).map(c => ({ name: c.name, t: c.turnover, last: c.last, n: c.accounts })))};
var LOADSM=${err ? "{}" : JSON.stringify(data.loads_by_month || {})};
var PRODUCTS=${err ? "[]" : JSON.stringify(data.products || [])};
var TO="${err ? "" : esc(data.to || "")}";
function bgn(n){return (Math.round((n||0)*100)/100).toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2})}
function wk(iso){var d=new Date(iso+'T12:00:00Z');var day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);return d.toISOString().slice(0,10)}
function bucketize(g){var b={};Object.keys(BYDAY).forEach(function(d){var key=g==='day'?d:g==='week'?wk(d):d.slice(0,7);b[key]=(b[key]||0)+BYDAY[d]});return b}
var trendChart=null;
function dpct(cur,prev){return (prev!=null&&prev!==0)?((cur-prev)/prev*100):null}
function dcell(d){if(d==null)return '<td class="c">—</td>';var c=d>=0?'#0a6b2e':'#b3121b';return '<td class="q" style="color:'+c+';font-weight:800">'+(d>=0?'▲ ':'▼ ')+Math.abs(d).toFixed(1)+'%</td>'}
function render(g){var b=bucketize(g);var keys=Object.keys(b).sort();
  var vals=keys.map(function(k){return Math.round((b[k]||0)*100)/100});
  var deltas=keys.map(function(k,i){return dpct(b[k],i>0?b[keys[i-1]]:null)});
  var h='';for(var i=keys.length-1;i>=0;i--){var lab=g==='week'?'седм. от '+keys[i]:keys[i];h+='<tr><td>'+lab+'</td><td class="q">'+bgn(b[keys[i]])+' €</td>'+dcell(deltas[i])+'</tr>'}
  var bkt=document.getElementById('bkt');if(bkt)bkt.innerHTML=h||'<tr><td colspan="3" class="note">няма данни</td></tr>';
  if(window.Chart){var ctx=document.getElementById('cTrend');
    if(trendChart)trendChart.destroy();
    trendChart=new Chart(ctx,{type:'line',data:{labels:keys,datasets:[{label:'Оборот без ДДС',data:vals,borderColor:'#1f5b59',backgroundColor:'rgba(31,91,89,.12)',fill:true,tension:.3,pointRadius:2,pointHoverRadius:5,borderWidth:2}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return bgn(c.parsed.y)+' €'},afterLabel:function(c){var d=deltas[c.dataIndex];return d==null?'':'спрямо предх.: '+(d>=0?'+':'')+d.toFixed(1)+'%'}}}},scales:{y:{ticks:{callback:function(v){return bgn(v)}}},x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:14}}}}});}
}
document.querySelectorAll('#seg button').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('#seg button').forEach(function(x){x.className=''});b.className='on';render(b.getAttribute('data-g'))})});
render('month');
if(window.Chart){var scl=CLIENTS.slice().sort(function(a,b){return b.t-a.t});var lead=scl.slice(0,7);var rest=scl.slice(7).reduce(function(s,c){return s+c.t},0);
  var labels=lead.map(function(c){return c.name});var vals=lead.map(function(c){return Math.round(c.t*100)/100});
  if(rest>0){labels.push('други');vals.push(Math.round(rest*100)/100)}
  var cols=['#1f5b59','#2b6ca3','#b06a00','#7a4b8a','#0a6b2e','#b3121b','#8a6608','#9aa0a6'];
  new Chart(document.getElementById('cClients'),{type:'doughnut',data:{labels:labels,datasets:[{data:vals,backgroundColor:cols,borderWidth:2,borderColor:'#fff'}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'58%',plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:12}}},tooltip:{callbacks:{label:function(c){var s=c.dataset.data.reduce(function(a,b){return a+b},0);return c.label+': '+bgn(c.parsed)+' € ('+(s?Math.round(c.parsed/s*100):0)+'%)'}}}}}});}
// топ артикули по оборот/печалба (#5)
function renderProducts(s){var body=document.getElementById('prodrows');if(!body)return;
  var arr=PRODUCTS.slice().sort(function(a,b){return (b[s]||0)-(a[s]||0)});
  var h=arr.map(function(p){var m=p.revenue>0?Math.round(p.profit/p.revenue*1000)/10:0;
    var mc=m>=40?'#0a6b2e':m>=25?'#b06a00':'#b3121b';
    return '<tr><td class="n">'+p.name+'</td><td class="c">'+bgn(p.units)+'</td><td class="q">'+bgn(p.revenue)+' €</td><td class="q inv">'+bgn(p.total_cost)+' €</td><td class="q" style="color:#0a6b2e">'+bgn(p.profit)+' €</td><td class="q" style="color:'+mc+';font-weight:800">'+m.toLocaleString('bg-BG',{minimumFractionDigits:1,maximumFractionDigits:1})+'%</td></tr>'}).join('');
  body.innerHTML=h||'<tr><td colspan="6" class="note">Няма продажби в периода.</td></tr>'}
document.querySelectorAll('#prodseg button').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('#prodseg button').forEach(function(x){x.className=''});b.className='on';renderProducts(b.getAttribute('data-s'))})});
renderProducts('revenue');
// спрели клиенти (#7)
function renderStopped(){var inp=document.getElementById('stopdays');var body=document.getElementById('stoprows');if(!body)return;
  var days=Math.max(1,parseInt(inp&&inp.value,10)||14);var to=TO?new Date(TO+'T12:00:00Z'):new Date();
  var rows=CLIENTS.filter(function(c){return c.last}).map(function(c){var d=new Date(c.last+'T12:00:00Z');var ago=Math.round((to-d)/864e5);return{c:c,ago:ago}})
    .filter(function(o){return o.ago>=days}).sort(function(a,b){return b.ago-a.ago});
  var h=rows.map(function(o){return '<tr><td class="n">'+o.c.name+'</td><td class="q">'+bgn(o.c.t)+' €</td><td class="c">'+o.c.last+'</td><td class="q" style="color:#b3121b">'+o.ago+' дни</td></tr>'}).join('');
  body.innerHTML=h||'<tr><td colspan="4" class="note">Няма спрели клиенти 🎉</td></tr>'}
var sd=document.getElementById('stopdays');if(sd)sd.addEventListener('input',renderStopped);renderStopped();
// зареждания по месеци (#9)
if(window.Chart){var mk=Object.keys(LOADSM).sort();if(mk.length){
  new Chart(document.getElementById('cLoads'),{type:'bar',data:{labels:mk,datasets:[{label:'Зареждания',data:mk.map(function(m){return LOADSM[m]}),backgroundColor:'#2b6ca3',borderRadius:5}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return bgn(c.parsed.y)+' €'}}}},scales:{y:{ticks:{callback:function(v){return bgn(v)}}}}}});}}
// бързи периоди
(function(){var q=document.getElementById('quick');if(!q)return;var y=new Date().getFullYear();var t=new Date().toISOString().slice(0,10);
  var m0=t.slice(0,7)+'-01';var d=new Date();var qs=[[y+' г.',y+'-01-01',t],['този месец',m0,t],['30 дни',new Date(Date.now()-30*864e5).toISOString().slice(0,10),t],['7 дни',new Date(Date.now()-7*864e5).toISOString().slice(0,10),t]];
  qs.forEach(function(o){var a=document.createElement('a');a.textContent=o[0];a.href='?view=dashboard${k ? "&k=" + encodeURIComponent(k) : ""}&from='+o[1]+'&to='+o[2];q.appendChild(a)})})();
</script>`}
</div></body></html>`;
}

// ── HTML: репорт за наличности (суровини+заготовки) ───────────────────────────
function stockPage(inner) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Цех · наличности</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:16px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#fff;color:#111}
header{background:#b3121b;color:#fff;padding:14px 18px}header h1{margin:0;font-size:22px}header .d{font-size:14px;opacity:.9;margin-top:2px}
.wrap{padding:16px;max-width:760px;margin:0 auto}h2{font-size:18px;margin:20px 0 8px;border-bottom:3px solid #b3121b;padding-bottom:4px}
table{border-collapse:collapse;width:100%}th,td{padding:9px 12px;border-bottom:1px solid #eee;text-align:left;font-size:16px}
th{background:#f0f1f3}td.q,th.q{text-align:right;font-weight:800;white-space:nowrap}td.c{color:#888;font-size:13px;text-align:center}
tr.lo td{background:#fde8e8}tr.lo td.q{color:#9b1c1c}.ok{color:#1b5e20;font-weight:600}.note{color:#666;font-size:13px;margin-top:18px}
</style></head><body>${inner}</body></html>`;
}

// ── HTML: цех лист (наличност + производство + поръчки), четящ ────────────────
function sheetPage(inner) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Цех лист</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:16px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#eef0f3;color:#14171a}
header{background:linear-gradient(135deg,#b3121b,#7a0c12);color:#fff;padding:16px 18px;position:sticky;top:0;z-index:5;box-shadow:0 2px 12px rgba(0,0,0,.18)}
header h1{margin:0;font-size:22px;font-weight:800}header .d{font-size:14px;opacity:.92;margin-top:3px}
.wrap{padding:14px;max-width:900px;margin:0 auto;display:grid;gap:16px}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(20,23,26,.08)}
.card>h2{margin:0;font-size:15px;font-weight:800;color:#fff;padding:11px 16px;letter-spacing:.5px;text-transform:uppercase}
.card.sushi>h2{background:#b3121b}.card.poke>h2{background:#2b7a78}.card.order>h2{background:#b8860b}
table{border-collapse:collapse;width:100%}th,td{padding:9px 10px;font-size:15px;border-top:1px solid #f1f2f4;text-align:right;white-space:nowrap}
th{background:#f7f8fa;color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.3px;border-top:0}
td.n,th.n{text-align:left;white-space:normal}
td.prod{font-weight:800;color:#b3121b}td.prod.zero{color:#9aa0a6}
td.blank{background:#fbfcfd;min-width:52px;border-left:1px dashed #d7dade;border-right:1px dashed #d7dade}
.low{background:#fff7ed}.draft{color:#9a6a00;font-size:12px;background:#fff8e1;padding:8px 14px;border-radius:8px;margin-top:4px}
.note{color:#7a8087;font-size:12px;text-align:center;margin:4px 0 16px}
</style></head><body>${inner}</body></html>`;
}

// ── HTML: страница за собственика (въвеждане/коригиране) ──────────────────────
function toolPage() {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOTAMO цех — производствен калкулатор</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:14px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#eef0f3;color:#1a1a1a}
header{background:linear-gradient(135deg,#c8151f,#7a0c12);color:#fff;padding:9px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:5;box-shadow:0 2px 12px rgba(122,12,18,.35)}
header .brand{display:flex;align-items:center;gap:10px;margin-right:6px}
header .brand img{width:36px;height:36px;border-radius:9px;background:#fff;padding:3px;box-shadow:0 2px 6px rgba(0,0,0,.25);flex:0 0 auto}
header h1{font-size:16px;margin:0;font-weight:800;letter-spacing:.4px;line-height:1.1}
header h1 small{display:block;font-size:10px;font-weight:600;opacity:.82;letter-spacing:1px;text-transform:uppercase;margin-top:2px}
header input{font:13px system-ui;padding:6px 8px;border:0;border-radius:6px;box-shadow:inset 0 1px 2px rgba(0,0,0,.12)}
button{font:13px system-ui;font-weight:600;padding:7px 13px;border:0;border-radius:7px;background:#111;color:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.18);transition:transform .05s ease,filter .15s ease}
button:hover{filter:brightness(1.09)}button:active{transform:translateY(1px)}
button.alt{background:#fff;color:#1a1a1a;border:1px solid rgba(0,0,0,.12)}
button.prod{background:linear-gradient(135deg,#12a244,#0a7d33)}button.acc{background:linear-gradient(135deg,#a01019,#7a0c12)}
header .grp{display:flex;gap:6px;align-items:center}header label{font-size:12px;opacity:.9}
header .dlab{background:#fff;color:#b3121b;border-radius:5px;padding:3px 8px;font-size:13px;white-space:nowrap}
@media (max-width:760px){
 body{font-size:16px}
 header{gap:8px;padding:10px}header .brand{flex:1 1 100%;margin:0 0 2px}header h1{font-size:18px}header .brand img{width:40px;height:40px}
 header .grp{flex:1 1 100%;justify-content:flex-start;flex-wrap:wrap}
 header .dlab{flex:0 0 auto}
 header input{font-size:16px;padding:9px 10px;flex:1}
 header button{font-size:16px;padding:11px 12px;flex:1}
 header label{min-width:64px}
 th,td{font-size:14px;padding:6px}td input{width:44px;font-size:16px;padding:6px}
 #grid td.shop input.selbox,#grid th.shop #selall{width:24px;height:24px;padding:0}
 .plan{gap:12px}.plan table{min-width:100%}
 h2{font-size:17px}
}
.wrap{padding:14px;max-width:1400px;margin:0 auto}.msg{padding:8px 12px;border-radius:6px;margin:8px 0;display:none}.msg.err{background:#fde8e8;color:#9b1c1c;display:block}.msg.ok{background:#e8f5e9;color:#1b5e20;display:block}
table{border-collapse:collapse;background:#fff}
.scroll{overflow:auto;max-height:74vh;border:1px solid #d7dade;border-radius:8px;margin:8px 0}
#grid{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
#grid th,#grid td{border-bottom:1px solid #eef0f2;border-right:1px solid #eef0f2;padding:7px 8px;text-align:center;white-space:nowrap}
#grid th{background:#2b2f36;color:#fff;position:sticky;top:0;z-index:2;font-weight:600;font-size:12px;letter-spacing:.02em}
#grid tr:nth-child(even) td{background:#fafbfc}
#grid th.shop,#grid td.shop{position:sticky;left:0;text-align:left;min-width:210px;max-width:250px;overflow:hidden;text-overflow:ellipsis;background:#fff;box-shadow:1px 0 0 #d7dade}
.stok{display:inline-block;background:#c8151f;color:#fff;font-weight:800;font-size:11px;line-height:16px;width:16px;text-align:center;border-radius:4px;margin-left:4px}
#grid td.shop{z-index:1;font-weight:500}#grid th.shop{z-index:3;background:#2b2f36}
#grid td input{width:46px;text-align:center;border:1px solid #cfd3d8;border-radius:5px;padding:5px 3px;font-size:14px}
#grid td input:focus{outline:2px solid #0a7d33;border-color:#0a7d33}
#grid td.shop input.selbox,#grid th.shop #selall{width:17px;height:17px;margin-right:6px;vertical-align:-3px;cursor:pointer;accent-color:#0a7d33}
#grid tr.off td{opacity:.4}#grid tr.off td.shop{opacity:.6}
#grid td.set input{background:#fff7e6}#grid th.set{background:#4a3d1a;color:#ffe6a3}
h2{font-size:15px;margin:18px 0 6px}.plan{display:flex;gap:24px;flex-wrap:wrap}.plan table{width:auto;min-width:260px}.plan table td,.plan table th{border:1px solid #e2e4e8;padding:7px 12px;text-align:left}.plan table th{background:#f0f1f3}.plan td.q{font-weight:700;color:#b3121b;text-align:right}
@media print{header,.noprint{display:none}.wrap{padding:0}}
</style></head><body>
<header><div class="brand"><img src="https://motamo.bg/icons/icon-192.png" alt="MOTAMO" onerror="this.style.display='none'"><h1>MOTAMO цех<small>производство · сметки · стокова</small></h1></div>
<span id="tokwrap"><input id="tok" type="password" placeholder="токен" size="16"></span>
<span class="grp"><label>Зареди</label><input id="date" type="date" lang="bg-BG"><b class="dlab" id="dlab"></b><button onclick="seed()">По ден</button><button class="alt" onclick="schedSeed()">По график</button></span>
<span class="grp"><button class="alt" onclick="calc()">Изчисли</button><button class="alt" onclick="window.print()">Печат</button></span>
<span class="grp"><label>Партида</label><input id="pdate" type="date" lang="bg-BG" title="Партида L.<тази дата>, срок +3 дни"><b class="dlab" id="plab"></b></span>
<span class="grp"><button class="prod" onclick="doProduce()">① Производство</button><button class="acc" onclick="doAccounts()">② Сметки</button><button class="alt" onclick="loadAccounts()" title="Изтегля реалните сметки за разнос-деня от „Зареди" (с текущите количества) — за ③ Стокова">↻ Изтегли сметки</button><button class="acc" onclick="doStokova()">③ Стокова</button></span></header>
<div class="wrap"><div id="msg" class="msg"></div><div class="scroll"><table id="grid"></table></div><div id="planbox"></div></div>
<script>
var MENU=${JSON.stringify(MENU)};var shops=[];var LASTACC=[];var $=function(id){return document.getElementById(id)};
(function(){var urlk='';try{urlk=new URLSearchParams(location.search).get('k')||new URLSearchParams(location.search).get('token')||''}catch(e){}
var saved='';try{saved=localStorage.getItem('cex_tok')||''}catch(e){}
var t=urlk||saved;$('tok').value=t;if(urlk){try{localStorage.setItem('cex_tok',urlk)}catch(e){}}
// щом има токен от линк/памет — крием полето (телефон); иначе го показваме
if(t){$('tokwrap').style.display='none'}})();
$('tok').addEventListener('change',function(){try{localStorage.setItem('cex_tok',$('tok').value)}catch(e){}});
(function(){var t=new Date().toISOString().slice(0,10);$('date').value=t;$('pdate').value=t})();
var BGM=['янв.','февр.','март','апр.','май','юни','юли','авг.','септ.','окт.','ноем.','дек.'];
function fmtBg(iso){if(!iso||iso.split('-').length<3)return '';var p=iso.split('-');return BGM[(+p[1])-1]+' '+p[2]}
function updLabs(){$('dlab').textContent=fmtBg($('date').value);$('plab').textContent=$('pdate').value?('партида L.'+$('pdate').value.split('-').reverse().join('.')):''}
$('date').addEventListener('change',updLabs);$('date').addEventListener('input',updLabs);
$('pdate').addEventListener('change',updLabs);$('pdate').addEventListener('input',updLabs);updLabs();
function msg(t,k){var m=$('msg');m.textContent=t;m.className='msg '+(k||'')}
function api(p){return fetch('/api/cex-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:$('tok').value},p))}).then(function(r){return r.json()})}
function seed(){msg('Зареждам…');api({seed_date:$('date').value}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||'')+' '+(j.hint||''),'err');return}shops=j.shops||[];renderGrid();renderPlan(j);if(j.note){msg(j.note,'err')}else{msg('Заредени '+(j.seeded_accounts||0)+' сметки. Коригирай и „Изчисли план".','ok')}}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function schedSeed(){msg('Зареждам по график…');api({action:'schedule_seed',date:$('date').value}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}shops=j.shops||[];renderGrid();$('planbox').innerHTML='';var dn=['нд','пн','вт','ср','чт','пт','сб'][j.dow];var adhoc=(j.seeded_accounts||0)-(j.scheduled_count||0);msg('График за '+dn+': '+(j.scheduled_count||0)+' по график (тикнати) + '+adhoc+' по заявка (нетикнати). Тикни каквото има заявка, коригирай и „Сметки".','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function shortName(client,rep){var r=(rep||client||'');r=r.replace(/[„“”"'']/g,'').replace(/^\\s*(ул\\.|бул\\.|ж\\.к\\.|жк|пл\\.)\\s*/i,'').replace(/\\s{2,}/g,' ').trim();return r||(client||'')}
function renderGrid(){var h='<tr><th class="shop"><input type="checkbox" id="selall" checked title="Избери/махни всички"> Магазин</th>';MENU.forEach(function(m){h+='<th class="'+(m.is_set?'set':'')+'">'+m.name.replace('НACHI','')+'</th>'});h+='</tr>';
shops.forEach(function(s,i){var full=(s.client||'')+(s.rep?(' · '+s.rep):'');var label=shortName(s.client,s.rep);var stok=s.has_stokova?' <span class="stok" title="Вече има издадена стокова">С</span>':'';h+='<tr><td class="shop" title="'+esc(full)+'"><input type="checkbox" class="selbox" data-i="'+i+'" '+(s.scheduled===false?'':'checked')+'> '+esc(label)+stok+'</td>';
MENU.forEach(function(m){var v=(s.order&&s.order[m.name])||0;h+='<td class="'+(m.is_set?'set':'')+'"><input data-i="'+i+'" data-n="'+esc(m.name)+'" value="'+v+'" inputmode="numeric"></td>'});h+='</tr>'});$('grid').innerHTML=h;
var sa=$('selall');if(sa){sa.addEventListener('change',function(){document.querySelectorAll('#grid .selbox').forEach(function(cb){cb.checked=sa.checked});syncRows()})}
document.querySelectorAll('#grid .selbox').forEach(function(cb){cb.addEventListener('change',syncRows)});syncRows()}
function syncRows(){document.querySelectorAll('#grid .selbox').forEach(function(cb){var tr=cb.closest('tr');if(tr)tr.className=cb.checked?'':'off'})}
function collect(){document.querySelectorAll('#grid input[data-n]').forEach(function(inp){var i=+inp.getAttribute('data-i'),n=inp.getAttribute('data-n'),v=parseFloat(inp.value)||0;if(!shops[i].order)shops[i].order={};if(v)shops[i].order[n]=v;else delete shops[i].order[n]})}
// Взима САМО избраните магазини (тикнати), след като събере числата от решетката.
function selShops(){collect();var out=[];document.querySelectorAll('#grid .selbox').forEach(function(cb){if(cb.checked){var i=+cb.getAttribute('data-i');if(shops[i])out.push(shops[i])}});return out}
function calc(){var sel=selShops();if(!sel.length){msg('Избери поне един магазин (тикчето отляво).','err');return}msg('Смятам…');api({shops:sel}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}renderPlan(j);msg('Планът е готов за '+sel.length+' магазина.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function tbl(t,o){var ks=Object.keys(o||{});if(!ks.length)return '';var h='<table><tr><th class="shop">'+t+'</th><th>кол.</th></tr>';ks.forEach(function(k){h+='<tr><td class="shop">'+esc(k)+'</td><td class="q">'+o[k]+'</td></tr>'});return h+'</table>'}
function renderPlan(j){$('planbox').innerHTML='<h2>За производство</h2><div class="plan">'+tbl('Сетове',j.produce_sets)+tbl('Ролки / поке',j.produce_rolls)+tbl('Заготовки',j.produce_zagotovki)+'</div>'}
function doProduce(){if(!shops.length){msg('Първо натисни „Зареди", за да заредиш деня.','err');return}var sel=selShops();if(!sel.length){msg('Избери поне един магазин (тикчето отляво).','err');return}var pd=$('pdate').value;var lot='L.'+pd.split('-').reverse().join('.');if(!confirm('Ще СЪЗДАМ производство в Barsy за '+sel.length+' магазина:\\n• първо заготовки (майонези, сосове…), после ролки/поке, после сетове\\n• партида '+lot+' (срок +3 дни)\\nПродължавам?'))return;msg('Правя производството… (заготовки → ролки → сетове)');api({action:'produce_plan',shops:sel,prod_date:pd}).then(function(j){if(!j.ok){msg('Грешка при производство: '+((j.zagotovki&&j.zagotovki.error)||(j.rolls&&j.rolls.error)||(j.sets&&j.sets.error)||j.error||j.message||''),'err');return}var zp=(j.zagotovki&&j.zagotovki.produced&&j.zagotovki.produced.length)||0,zs=(j.zagotovki&&j.zagotovki.skipped&&j.zagotovki.skipped.length)||0,ri=j.rolls&&j.rolls.store_production_id,si=j.sets&&j.sets.store_production_id;msg('✓ Производството е създадено. Партида '+j.lot+' · заготовки: '+zp+' произв.'+(zs?(' ('+zs+' без рецепта, прескочени)'):'')+' · ролки/поке №'+(ri||'—')+' · сетове №'+(si||'—')+'. Провери в касата и „Приключи", ако е ок.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function doAccounts(){if(!shops.length){msg('Първо натисни „Зареди", за да заредиш деня.','err');return}var sel=selShops();if(!sel.length){msg('Избери поне един магазин (тикчето отляво).','err');return}var pd=$('pdate').value||$('date').value;var lot=pd?('L.'+pd.split('-').reverse().join('.')):'';if(!confirm('Ще СЪЗДАМ отворени сметки в Barsy за '+sel.length+' магазина'+(lot?(', ВЕЧЕ с партида '+lot):'')+'.\\nЦените ги слага Barsy по правилото на клиента.\\nПродължавам?'))return;msg('Създавам сметките…');api({action:'create_accounts',date:($('pdate').value||$('date').value),shops:sel}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}var cr=j.created||[];var ok=cr.filter(function(c){return c.ok}).length,bad=cr.filter(function(c){return c.ok===false}).length;sel.forEach(function(s,i){if(cr[i]&&cr[i].account_id)s.account_id=cr[i].account_id});LASTACC=cr.filter(function(c){return c.ok&&c.account_id}).map(function(c){return c.account_id});msg('✓ Създадени '+ok+' сметки'+(bad?(', '+bad+' с грешка'):'')+'. После натисни ③ Стокова.',bad?'err':'ok');renderCreated(cr)}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
// Тегли по датата от календара (полето „Зареди") = деня на разноса. Вади сметките,
// направени в навечерието (за този разнос) + затворените за деня.
function loadAccounts(){var d=$('date').value;msg('Изтеглям реалните сметки за разнос '+d+'…');api({action:'load_accounts',date:d}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}shops=j.shops||[];renderGrid();$('planbox').innerHTML='';if(!shops.length){msg('Няма сметки за разнос '+j.date+'. (Сметките се правят в навечерието — избери верния ден горе в „Зареди".)','err');return}var sc=shops.filter(function(s){return s.has_stokova}).length;msg('Изтеглени '+shops.length+' реални сметки за разнос '+j.date+'. '+(sc?(sc+' вече имат стокова (червено „С", разтикнати). '):'')+'Тикни които искаш и натисни ③ Стокова.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function doStokova(){var sel=selShops().filter(function(s){return s.account_id});if(!sel.length){msg('Няма сметки за стокова. Натисни „↻ Изтегли сметки" (или ② Сметки), после тикни обектите.','err');return}var pd=$('pdate').value||$('date').value;if(!confirm('Ще СЪЗДАМ стокови за '+sel.length+' обекта (една по една), с дата '+pd+'.\\nПродължавам?'))return;var i=0,okc=0,errs=[];
function nextStok(){if(i>=sel.length){msg('✓ Стокови: '+okc+'/'+sel.length+' готови'+(errs.length?(' · грешки: '+errs.join(' | ')):''),errs.length?'err':'ok');return}var s=sel[i];msg('Правя стокова '+(i+1)+'/'+sel.length+' ('+shortName(s.client,s.rep)+')…');api({action:'create_stokova',account_id:s.account_id,date:pd}).then(function(j){if(j.ok)okc++;else errs.push('#'+s.account_id+': '+(j.error||''));i++;nextStok()}).catch(function(e){errs.push('#'+s.account_id+': мрежа');i++;nextStok()})}
nextStok()}
function renderCreated(cr){var h='<h2>Създадени сметки</h2><table><tr><th class="shop">Магазин</th><th>сметка №</th><th>артикули</th><th>статус</th></tr>';cr.forEach(function(c){var full=(c.client||'')+(c.rep?(' · '+c.rep):'');h+='<tr><td class="shop" title="'+esc(full)+'">'+esc(shortName(c.client,c.rep))+'</td><td>'+(c.account_id||'—')+'</td><td>'+(c.items||0)+'</td><td>'+(c.ok?'✓':esc(c.skipped||'грешка'))+'</td></tr>'});$('planbox').innerHTML=h+'</table>'}
</script></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  const view = q.view;

  // 1) Страница за собственика (само UI shell; данните искат токен през POST).
  if (req.method === "GET" && view === "tool") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(toolPage());
    return;
  }

  // 2) Четящ екран за цеха (сървърно смята днешния план от днешните сметки).
  // ── ЦЕХ ДАШБОРД (Фаза 1): оборот/фактури по период и клиент ──
  if (req.method === "GET" && view === "dashboard") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send(dashboardPage({ error: "Липсва или грешен ключ в линка." }, "")); return; }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).send(dashboardPage({ error: "Не е конфигуриран достъп до цеха." }, q.k)); return; }
    if (q.debug === "lotchk") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const lv = q.lv || "L.03.09.2026";
      const byType = {}; const perType = {}; let recs = 0;
      for (let pg = 1; pg <= 6; pg++) {
        const r = await cexCall("Reports_lot_list_details",
          { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { ref_date: ["2026-08-01", "2026-09-30"], lot_value: lv } }, user, pass);
        const d = r.data || {}; const rows = Array.isArray(d.rows) ? d.rows : []; recs = Number(d.records) || recs;
        for (const x of rows) { const tp = x.operation_ref_type; byType[tp] = (byType[tp] || 0) + 1; if (!perType[tp]) perType[tp] = { art: x.article_name, amt: x.amount, ref_id: x.ref_id, doc: x.operation_doc_date, ref_type_title: x.operation_ref_type_title }; }
        if (rows.length < 50) break;
      }
      res.status(200).send(JSON.stringify({ lot: lv, records: recs, byType, perTypeSample: perType }, null, 2));
      return;
    }
    const today = sofiaToday();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : today.slice(0, 4) + "-01-01"; // по подразбиране от 1 януари
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : today;
    const expenses = Number(q.exp) || 0;
    let data;
    try { data = await dashData(from, to, expenses, user, pass); }
    catch (e) { data = { from, to, error: "Не мога да прочета данните сега. Опитай пак след минута. (" + String(e && e.message) + ")" }; }
    res.status(200).send(dashboardPage(data, q.k));
    return;
  }

  if (req.method === "GET" && view === "today") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send(todayPage(`<div class="wrap"><h2>Няма достъп</h2><p>Липсва или грешен ключ в линка.</p></div>`)); return; }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).send(todayPage(`<div class="wrap">Не е конфигуриран достъп до цеха.</div>`)); return; }
    // Работим ДЕН НАПРЕД: екранът е за УТРЕШНИЯ разнос по подразбиране; чете сметките,
    // направени днес (навечерието). ?date= задава изрично разнос ден.
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : isoPlusDays(sofiaToday(), 1);
    let seed;
    try { seed = await seedRazos(date, user, pass); }
    catch (e) { res.status(200).send(todayPage(`<div class="wrap"><h2>Грешка</h2><p>Не мога да прочета сметките сега. Опитай пак след минута.</p></div>`)); return; }
    const { agg, rolls, zag } = compute(seed.shops);
    const sets = {}; for (const [name, qty] of Object.entries(agg)) { const a = resolve(name); if (a && a.is_set) sets[name] = qty; }
    const tbl = (obj) => Object.keys(obj).sort().map(k => `<tr><td>${esc(k)}</td><td class="q">${round(obj[k])}</td></tr>`).join("");
    const card = (cls, title, obj) => { const n = Object.keys(obj).length; return n ? `<div class="card ${cls}"><h2>${title}<span class="cnt">${n} вида</span></h2><table>${tbl(obj)}</table></div>` : ""; };
    // „По маршрут": разбивка на поръчаните продукти по град (група). Girls пакетират по маршрут.
    const CITY = [["haskovo", "Хасково"], ["merkanto", "Сливен"], ["sibies", "Ст. Загора"], ["adhoc", "Друго"]];
    const byCity = {};
    for (const s of seed.shops) { const g = s.group || "adhoc"; const dst = byCity[g] || (byCity[g] = {}); for (const [k, v] of Object.entries(s.order || {})) dst[k] = (dst[k] || 0) + (Number(v) || 0); }
    const activeCities = CITY.filter(([g]) => byCity[g] && Object.values(byCity[g]).some(v => v > 0));
    // редове = поръчаните артикули; сетовете първо, после по име
    const artNames = Object.keys(agg).filter(n => agg[n] > 0).sort((a, b) => { const A = resolve(a), B = resolve(b); return (Number(!!(B && B.is_set)) - Number(!!(A && A.is_set))) || a.localeCompare(b, "bg"); });
    const routeHead = `<tr><th class="n">Артикул</th>${activeCities.map(([, lbl]) => `<th class="q">${esc(lbl)}</th>`).join("")}<th class="q tot">Общо</th></tr>`;
    const routeBody = artNames.map(n => `<tr><td class="n">${esc(n)}</td>${activeCities.map(([g]) => { const v = (byCity[g] || {})[n] || 0; return `<td class="q${v ? "" : " zero"}">${v ? round(v) : "·"}</td>`; }).join("")}<td class="q tot">${round(agg[n])}</td></tr>`).join("");
    const routeCard = activeCities.length ? `<div class="card route"><h2>По маршрут<span class="cnt">${activeCities.map(([, l]) => l).join(" · ")}</span></h2><div class="scroll"><table>${routeHead}${routeBody}</table></div></div>` : "";
    const empty = !Object.keys(rolls).length && !Object.keys(sets).length;
    res.status(200).send(todayPage(`
      <header><h1>🍣 Цех · за разнос ${esc(date)}</h1><div class="d">производство днес · ${seed.accounts} магазина · обновено ${esc(sofiaTime())}</div></header>
      <div class="wrap">${empty
        ? `<div class="empty"><h2>Още няма заявки за ${esc(date)}</h2><p>Когато направиш сметките за разноса, тук се показва какво да се произведе.<br>Страницата се обновява сама.</p></div>`
        : `${routeCard}${card("sets", "Сетове (общо)", sets)}${card("rolls", "Ролки / поке (общо)", rolls)}${card("zag", "Заготовки (общо)", zag)}
        <div class="note">Обновява се сам на всеки 3 минути · „По маршрут" = продуктите за всеки град · долните карти са общо за всички</div>`}</div>`));
    return;
  }

  // 2b) Репорт за наличности (суровини+заготовки), четящ екран за собственика.
  if (req.method === "GET" && view === "stock") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send(stockPage(`<div class="wrap"><h2>Няма достъп</h2><p>Липсва или грешен ключ.</p></div>`)); return; }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).send(stockPage(`<div class="wrap">Не е конфигуриран достъп до цеха.</div>`)); return; }
    let rows;
    try { rows = await readStock(user, pass); }
    catch (e) { res.status(200).send(stockPage(`<div class="wrap"><h2>Грешка</h2><p>Не мога да прочета наличностите сега. Опитай пак след минута.</p></div>`)); return; }
    const low = rows.filter(r => r.qty != null && r.qty <= 1);
    const rowHtml = (arr) => arr.map(r => `<tr class="${r.qty != null && r.qty <= 1 ? 'lo' : ''}"><td>${esc(r.name)}</td><td class="c">${esc(r.cat === "Заготовки" ? "заг." : "сур.")}</td><td class="q">${r.qty == null ? "?" : r.qty}</td></tr>`).join("");
    res.status(200).send(stockPage(`
      <header><h1>Цех · наличности</h1><div class="d">${esc(sofiaToday())} · обновено ${esc(sofiaTime())} · ${rows.length} артикула</div></header>
      <div class="wrap">
        ${low.length ? `<h2>⚠️ На изчерпване (≤1)</h2><table>${rowHtml(low)}</table>` : `<p class="ok">Няма критично ниски (всичко над 1).</p>`}
        <h2>Всички (най-малко първо)</h2><table><tr><th>Артикул</th><th>вид</th><th class="q">нал.</th></tr>${rowHtml(rows)}</table>
        <div class="note">Обновява се при отваряне. „?" = липсва отчет за склада.</div></div>`));
    return;
  }

  // 2c) Цех лист (наличност + производство + поръчки) — четящ екран.
  if (req.method === "GET" && view === "sheet") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send(sheetPage(`<div class="wrap"><h2>Няма достъп</h2></div>`)); return; }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).send(sheetPage(`<div class="wrap">Не е конфигуриран достъп.</div>`)); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : sofiaToday();
    let need = {}, accounts = 0;
    try { const s = await seedShops(date, user, pass); accounts = s.accounts; const agg = {}; for (const sh of s.shops) for (const [k, v] of Object.entries(sh.order || {})) agg[k] = (agg[k] || 0) + (Number(v) || 0); need = fullBOM(agg); }
    catch (e) { res.status(200).send(sheetPage(`<div class="wrap"><h2>Грешка</h2><p>Не мога да прочета заявката сега.</p></div>`)); return; }
    const nm = id => { const a = ARTS[String(id)]; return a ? a.name : ("#" + id); };
    // произв. = дневната консумация по стоковите (заявката); наличност = празно (ръчно).
    const prodRows = (arr) => arr.map(r => {
      const prod = r.id != null ? round(need[String(r.id)] || 0) : null;
      const name = r.id != null ? nm(r.id) : (r.name || "");
      return `<tr><td class="n">${esc(name)}</td><td>${r.срок || ""}</td><td class="prod ${prod ? "" : "zero"}">${prod == null ? "?" : prod}</td><td class="blank"></td><td>${r.preporuka} ${esc(r.ед || "")}</td></tr>`;
    }).join("");
    const orderRows = CEX_SHEET.order.map(r => {
      const name = r.id != null ? nm(r.id) : (r.name || "");
      return `<tr><td class="n">${esc(name)}</td><td class="n">${esc(r.доставчик)}</td><td>${esc(r.дни)}</td><td class="blank"></td><td>${r.preporuka} ${esc(r.ед || "")}</td></tr>`;
    }).join("");
    const head3 = `<tr><th class="n">Артикул</th><th>срок</th><th>произв.</th><th>налич.</th><th>препор.</th></tr>`;
    res.status(200).send(sheetPage(`
      <header><h1>🍣 Цех лист</h1><div class="d">${esc(date)} · ${accounts} сметки · обновено ${esc(sofiaTime())}</div></header>
      <div class="wrap">
        <div class="draft">ЧЕРНОВА · „произв." = колко да произведете за деня (по стоковите разписки) · „налич." е празно — попълва се на ръка · „препор." = сутрешен целеви запас (числата/доставчиците за корекция).</div>
        <div class="card sushi"><h2>Суши — заготовки/суровини</h2><table>${head3}${prodRows(CEX_SHEET.sushi)}</table></div>
        <div class="card poke"><h2>Поке — заготовки/суровини</h2><table>${head3}${prodRows(CEX_SHEET.poke)}</table></div>
        <div class="card order"><h2>Поръчки към доставчик</h2><table><tr><th class="n">Продукт</th><th class="n">доставчик</th><th>дни</th><th>заявка</th><th>препор.</th></tr>${orderRows}</table></div>
        <div class="note">„произв." е сметнато от заявката за деня · попълни „налич." и виж колко да догониш до „препор."</div>
      </div>`));
    return;
  }

  // 3) JSON изчисление (POST от страницата, или GET със seed_date). Токен-гейт.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};
  const token = body.token != null ? body.token : q.token;
  // Пишещите действия искат силен токен; „stock" е само четене → и CEX_VIEW_TOKEN.
  const strong = [process.env.RECONCILE_TOKEN, process.env.PAY_HMAC_SECRET, process.env.PREVIEW_TOKEN];
  // Само ПИШЕЩИТЕ действия искат силен токен; четенето/смятането приемат и четящия.
  const writeActions = ["create_accounts", "produce_plan", "create_production", "create_stokova"];
  // create_stokova с dry:true само СГЛОБЯВА (не записва) → приема и четящия токен.
  const isWrite = writeActions.includes(body.action) && !(body.action === "create_stokova" && body.dry === true);
  const allowed = isWrite ? strong : strong.concat([process.env.CEX_VIEW_TOKEN]);
  const okJson = allowed.some(t => t && token === t);
  if (!okJson) { res.status(403).json({ ok: false, error: "forbidden" }); return; }

  // ── ДИАГНОСТИК (само четене): затворени сметки на дата (реалният разнос) ──
  if (body.action === "closed_on") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    const r = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 2000 }, user, pass);
    let all = r.data || []; if (!Array.isArray(all)) all = Object.values(all);
    const closed = all
      .filter(a => String(a.close_date || "").slice(0, 10) === date)
      .map(a => ({ account_id: a.account_id, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null, rep: a.person_name || null, close_date: a.close_date, create_date: a.create_date }))
      .sort((x, y) => (x.client_id || 0) - (y.client_id || 0) || (x.person_id || 0) - (y.person_id || 0));
    res.status(200).json({ ok: true, date, count: closed.length, closed });
    return;
  }

  // ── ③ СТОКОВА РАЗПИСКА: сглобява Invoices_create от формата на сметката ──
  // body: {account_id, date, dry?}. dry=true → връща сглобеното БЕЗ да записва.
  if (body.action === "create_stokova") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const acc = Number(body.account_id); if (!acc) { res.status(400).json({ ok: false, error: "no_account_id" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    const DT = 11; // стокова разписка
    // 1) зареди формата (хедър полета + грид с редовете, вече с партида)
    const load = await cexCallRoot({ invoices_edit: { params: { bid: 1, doc_type: DT, gen_mode: 1, account_id: acc } } }, user, pass);
    const inner = load.data && load.data.invoices_edit;
    if (!inner) { res.status(502).json({ ok: false, error: "load_failed", raw: String(load.raw || "").slice(0, 300) }); return; }
    const content = Array.isArray(inner.content) ? inner.content : [];
    const gridBlock = content.find(c => c && c.type === "eStructListForm");
    // 2) хедър стойности: обходи ЦЯЛАТА форма, събери полетата (name→value); обект-стойност
    // (client_id={client_id,client_name}, seller_company_id={company_id,name}) го разгъвам.
    const values = {};
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      if (typeof n.name === "string" && Object.prototype.hasOwnProperty.call(n, "value")) {
        const v = n.value;
        if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(values, v);
        else if (!(n.name in values) || values[n.name] == null) values[n.name] = v;
      }
      // прескачаме тежките/референтни таблици (dropdown опции), не са полета-стойности
      for (const k in n) if (k !== "data_source" && k !== "tax_groups_by_country" && k !== "all_tax_groups" && k !== "countries" && k !== "elements") walk(n[k]);
    })(inner);
    values.type_id = String(DT);
    values.create_date = date;
    // term_date = create_date + 30 дни (както UI-ят: 08.09 → 08.10); payment_date = create_date.
    values.term_date = isoPlusDays(date, 30); values.payment_date = date;
    values.accounts = [acc];
    if (values.seller_company_id == null) values.seller_company_id = values.company_id != null ? values.company_id : 1;
    // Начин на плащане: по подразбиране БЕЗ (null) — потр. Claude още няма достъп до
    // „По банка" (Barsy: „не може да бъде намерен … нужните права"). Като се даде правото,
    // подаваме body.paymethod_id (напр. 5).
    if (body.paymethod_id !== undefined) values.paymethod_id = body.paymethod_id === null ? null : String(body.paymethod_id);
    // ★ Barsy Invoices_create гърми с обща „непредвидена грешка", ако ЛИПСВА ключ, който
    // очаква. UI-ят винаги праща пълния набор. Затова гарантираме, че всички ключове
    // съществуват (null/"" по подразбиране), без да презаписваме взетите от формата.
    const defaults = {
      client_id: null, client_name: "", company_id: 1, name: "", seller_company_id: 1,
      receiver_company_name: "", seller_company_name: "", receiver_address: "", inv_id: null,
      inv_num: "", parent_inv_id: null, seller_address: "", receiver_town: "", seller_town: "",
      receiver_identity_num: null, seller_identity_num: null, receiver_vat_num: null, seller_vat_num: null,
      receiver_mol: null, discount: "0", seller_mol: null, receiver_country_id: "BG", deal_id: null,
      deal_title: "", seller_country_id: "BG", person_id: null, person_name: "", with_tax: 0,
      currency_id: "1", bank_name: null, bic: null, iban: null, is_anulate: "0",
      client_paid_period: null, currency_rate: "1", bank_account_id: null,
      receiver_name: null, seller_name: "", additional_text: "", free_text: ""
    };
    for (const k in defaults) if (!(k in values) || values[k] === undefined) values[k] = defaults[k];
    // Начин на плащане „По банка" (ид 5) по подразбиране — потр. Claude вече има правото
    // (ролята е разрешена за метода). body.paymethod_id=null → без начин (пропускаме ключа).
    if (body.paymethod_id === null) delete values.paymethod_id;
    else values.paymethod_id = String(body.paymethod_id !== undefined ? body.paymethod_id : 5);
    // 3) редове: препрати грид data_source.target → вземи редовете
    let rows = [];
    let rowsRaw = null;
    try {
      let tgt = gridBlock && gridBlock.data && gridBlock.data.data_source && gridBlock.data.data_source.target;
      if (tgt) {
        const rr = await cexCallRoot(tgt, user, pass);
        rowsRaw = rr.data;
        // намери списъка с редове в отговора
        const findRows = (node) => {
          let best = null;
          (function w(x) {
            if (!x || typeof x !== "object") return;
            if (Array.isArray(x)) { if (x.length && x[0] && typeof x[0] === "object" && (x[0].article_id != null || x[0].item_id != null)) { if (!best || x.length > best.length) best = x; } return x.forEach(w); }
            for (const k in x) w(x[k]);
          })(node);
          return best || [];
        };
        rows = findRows(rr.data).map(r => ({
          item_id: r.item_id != null ? String(r.item_id) : "", inv_ref_num: r.inv_ref_num != null ? String(r.inv_ref_num) : String(r.article_id || ""),
          item_name: r.item_name || r.article_name || "", quantity: String(r.quantity != null ? r.quantity : r.amount),
          measure: r.measure || "бр", original_single_price: String(r.original_single_price != null ? r.original_single_price : (r.single_price != null ? r.single_price : "")),
          original_single_price_with_tax: String(r.original_single_price_with_tax != null ? r.original_single_price_with_tax : (r.single_price_with_tax != null ? r.single_price_with_tax : "")),
          discount: String(r.discount != null ? r.discount : 0), tax: String(r.tax != null ? r.tax : 20), tax_id: String(r.tax_id != null ? r.tax_id : 2), tax_reason: r.tax_reason || "",
          lot_value: r.lot_value || "", total_for_tax_2: String(r.total_for_tax_2 != null ? r.total_for_tax_2 : (r.total_price != null ? r.total_price : "0.00")),
          total_for_tax_1: "0.00", total_for_tax_3: "0.00", total_for_tax_4: "0.00", total_for_tax_12: "0.00", total_for_tax_100: "0.00",
          total_price: String(r.total_price != null ? r.total_price : ""), chooser: 0, article_id: String(r.article_id || "")
        }));
      }
    } catch (e) { rowsRaw = { error: String(e && e.message) }; }
    let paymethodOpts = null;
    (function w(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(w); if (n.name === "paymethod_id" && n.data_source) paymethodOpts = n.data_source; for (const k in n) w(n[k]); })(inner);
    const payload = { Invoices_create: { id: null, action_type: "save", values, rows } };
    if (body.dry === true) { res.status(200).json({ ok: true, dry: true, account_id: acc, rows_count: rows.length, paymethod_options: paymethodOpts, payload, rows_raw_sample: JSON.stringify(rowsRaw).slice(0, 300) }); return; }
    const cr = await cexCallRoot(payload, user, pass);
    const invId = cr.data && (cr.data.Invoices_create || (cr.data.data && cr.data.data.inv_id)) || null;
    res.status(200).json({ ok: !!cr.ok, account_id: acc, rows_count: rows.length, inv_result: cr.data, error: cr.ok ? undefined : String(cr.raw || "").slice(0, 400) });
    return;
  }

  // ── ЗАРЕЖДАНЕ ПО ГРАФИК (чете; връща обектите за деня + последните им количества) ──
  if (body.action === "schedule_seed") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let s;
    try { s = await scheduleSeed(date, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    const scheduled = s.shops.filter(x => x.scheduled).length;
    res.status(200).json({ ok: true, date, dow: s.dow, seeded_accounts: s.shops.length, scheduled_count: scheduled,
      shops: s.shops.map(x => ({ account_id: x.account_id, last_date: x.last_date, client: x.client, rep: x.rep, client_id: x.client_id, person_id: x.person_id, group: x.group, scheduled: x.scheduled, order: sortObj(x.order || {}, 2) })) });
    return;
  }

  // ── ИЗТЕГЛИ СМЕТКИ за разнос ден (реалните, вече коригирани сметки — за ③ Стокова) ──
  // Чете съществуващите сметки за разноса (направени в навечерието + затворените за деня),
  // с техните account_id и ТЕКУЩИ количества (след ръчните допълвания). Всички тикнати.
  // Освен това маркира кои вече имат ИЗДАДЕНА стокова (по клиент+дата+сума → червено „С").
  if (body.action === "load_accounts") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let s;
    // Без same-day: сметка, направена в деня D, е за разноса D+1 → не влиза в разнос D.
    try { s = await seedRazos(date, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    // издадени стокови (doc_type 11, неанулирани) около тази дата → суми по клиент.
    // Прозорец ±2 дни, защото датата на стоковата може да се разминава с деня на
    // затваряне на сметката (напр. сметка затворена 07.09, стокова издадена 08.09).
    const okDates = {}; for (let k = -2; k <= 2; k++) okDates[isoPlusDays(date, k)] = 1;
    let stok = {}; // client_id → [total_all,…]
    try {
      const r = await cexCall("Invoices_getlist", { order_by: "inv_id desc", length: 400 }, user, pass);
      let inv = r.data; inv = Array.isArray(inv) ? inv : Object.values(inv || {});
      for (const x of inv) {
        if (String(x.type_id) !== "11" || String(x.is_anulate) === "1") continue;
        if (!okDates[String(x.create_date || "").slice(0, 10)]) continue;
        (stok[x.client_id] = stok[x.client_id] || []).push(Number(x.total_all) || 0);
      }
    } catch (e) { stok = {}; }
    // маркер: има стокова със същата сума за клиента (в рамките на ±0.05); „изразходваме" я,
    // за да не маркира два обекта от една сметка (при различни суми).
    const hasStok = (sh) => {
      const arr = stok[sh.client_id]; if (!arr || !arr.length) return false;
      const i = arr.findIndex(t => Math.abs(t - (sh.total || 0)) < 0.05);
      if (i < 0) return false; arr.splice(i, 1); return true;
    };
    res.status(200).json({ ok: true, date, seeded_accounts: s.shops.length,
      shops: s.shops.map(x => { const hs = hasStok(x); return { account_id: x.account_id, client: x.client, rep: x.rep, client_id: x.client_id, person_id: x.person_id, group: x.group, total: x.total, has_stokova: hs, scheduled: !hs, order: sortObj(x.order || {}, 2) }; }) });
    return;
  }

  // ── СЪЗДАВАНЕ на отворени сметки-чернови в Barsy (ПИШЕ; зад силен токен) ──
  if (body.action === "create_accounts") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const shopsIn = Array.isArray(body.shops) ? body.shops : [];
    if (!shopsIn.length) { res.status(400).json({ ok: false, error: "no_shops" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    // lot: изрична партида от клиента, или „" за без партида, иначе L.<дата>.
    const lotOverride = (typeof body.lot === "string") ? body.lot : undefined;
    const created = await createAccounts(shopsIn, date, user, pass, lotOverride);
    res.status(200).json({ ok: true, created });
    return;
  }

  // ── СЪЗДАВАНЕ на ПРОИЗВОДСТВО в Barsy (ПИШЕ; произведеното влиза в наличност) ──
  // rows: [{article_id, amount}]  или  produce: {"NACHI ORO":12, ...} (по име/ид).
  if (body.action === "create_production") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    let rows = [];
    if (Array.isArray(body.rows)) {
      rows = body.rows.map(r => ({ article_id: r.article_id, amount: r.amount, amount_prod: r.amount_prod, article_name: r.article_name, lot: r.lot, lot_exp: r.lot_exp }))
        .filter(r => r.article_id && Number(r.amount) > 0);
    } else if (body.produce && typeof body.produce === "object") {
      for (const [k, v] of Object.entries(body.produce)) {
        const art = resolve(k); if (art && Number(v) > 0) rows.push({ article_id: art.id, article_name: art.name, amount: Number(v) });
      }
    }
    if (!rows.length) { res.status(400).json({ ok: false, error: "no_rows", hint: "подай rows:[{article_id,amount}] или produce:{име:кол}" }); return; }
    const opts = { doc_date: body.doc_date || null, lot: body.lot != null ? body.lot : "", lot_exp: body.lot_exp || null, description: body.description || "", notes: body.notes || "" };
    let r;
    try { r = await createProduction(rows, opts, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    res.status(200).json({ ok: r.ok, store_production_id: r.store_production_id, rows: rows.length, error: r.error });
    return;
  }

  // ── ЦЯЛ ПЛАН: произвежда ЗАГОТОВКИ, после РОЛИ/ПОКЕ (2 нива), с вярна партида ──
  if (body.action === "produce_plan") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const shopsIn = Array.isArray(body.shops) ? body.shops.map(s => ({ order: s.order || {} })) : [];
    if (!shopsIn.length) { res.status(400).json({ ok: false, error: "no_shops" }); return; }
    const { agg, rolls, zag } = compute(shopsIn);
    const prodDate = /^\d{4}-\d{2}-\d{2}$/.test(body.prod_date || "") ? body.prod_date : sofiaToday();
    const auto = body.auto_lot === true; // авто-партида (същия ден) → празна партида
    const { lot, lot_exp } = auto ? { lot: "", lot_exp: null } : lotFor(prodDate);
    const toRows = (map) => Object.entries(map)
      .map(([name, qty]) => { const a = resolve(name); return a ? { article_id: a.id, article_name: a.name, amount: round(Number(qty)) } : null; })
      .filter(r => r && r.amount > 0);
    // Наличността се чете, за да произведем НУЖНОТО + колкото ЛИПСВА (покрива минуси),
    // та сметките после да минат (API потребителят не продава под нула).
    let sm = {};
    try { sm = await stockMap(user, pass); } catch (e) { sm = {}; }
    const deficit = id => { const q = sm[String(id)]; const n = (q == null || isNaN(q)) ? 0 : q; return n < 0 ? -n : 0; };
    // Сетове (CET*): поръчано + дефицит. Продават се като артикул → трябва да са в наличност.
    const setProduce = {};
    for (const [name, qty] of Object.entries(agg)) { const a = resolve(name); if (a && a.is_set && Number(qty) > 0) setProduce[name] = round(Number(qty) + deficit(a.id)); }
    // Ролки/поке: директните поръчки + ролките за ПРОИЗВЕЖДАНИТЕ сетове, после + дефицит.
    const rollNeed = {};
    for (const [name, qty] of Object.entries(agg)) { const a = resolve(name); if (a && a.is_menu && !a.is_set && Number(qty) > 0) rollNeed[name] = (rollNeed[name] || 0) + Number(qty); }
    for (const [name, qty] of Object.entries(explodeToRolls(setProduce))) { const a = resolve(name); if (a && a.is_menu && !a.is_set) rollNeed[name] = (rollNeed[name] || 0) + qty; }
    const rollProduce = {};
    for (const [name, qty] of Object.entries(rollNeed)) { const a = resolve(name); if (a) rollProduce[name] = round(Number(qty) + deficit(a.id)); }
    // ЗАГОТОВКИ: нужните за деня (заг. от рецептите) + дефицит (покрива минуса), за да са
    // налични, преди да произведем ролките/сетовете, които ги консумират. По подразбиране
    // ги произвеждаме (include_zag !== false), защото иначе липсват (майонези, сосове…).
    const zagProduce = {};
    for (const [name, qty] of Object.entries(zag)) { const a = resolve(name); if (a && Number(qty) > 0) zagProduce[name] = round(Number(qty) + deficit(a.id)); }
    const doZag = body.include_zag !== false;
    // Произвеждаме заготовките ПЪРВО, после ролките, после сетовете (всяко следващо тегли предното).
    const zagRows = toRows(zagProduce), rollRows = toRows(rollProduce), setRows = toRows(setProduce);
    const out = { lot: lot || "(авто)", lot_exp, prod_date: prodDate, produced_zagotovki: sortObj(zagProduce, 2), produced_rolls: sortObj(rollProduce, 2), produced_sets: sortObj(setProduce, 2) };
    // Ред: заготовки → ролки → сетове.
    try {
      // Заготовките — ЕДНА ПО ЕДНА (best-effort): някои нямат производствена рецепта в
      // Barsy (напр. „заг. Марината за ориз") и се прескачат, без да чупят процеса.
      if (doZag && zagRows.length) {
        const z = { ok: true, produced: [], skipped: [] };
        for (const r of zagRows) {
          let rr; try { rr = await createProduction([r], { lot, lot_exp }, user, pass); } catch (e) { rr = { ok: false }; }
          if (rr && rr.ok) z.produced.push(r.article_name); else z.skipped.push(r.article_name);
        }
        out.zagotovki = z;
      }
      if (rollRows.length) out.rolls = await createProduction(rollRows, { lot, lot_exp }, user, pass);
      if (setRows.length) out.sets = await createProduction(setRows, { lot, lot_exp }, user, pass);
    } catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    // Успехът зависи от ролките/сетовете (менюто); заготовките са best-effort.
    out.ok = (!rollRows.length || (out.rolls && out.rolls.ok))
      && (!setRows.length || (out.sets && out.sets.ok));
    res.status(200).json(out);
    return;
  }

  // ── Наличности суровини+заготовки (JSON) ──
  if (body.action === "stock") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    let rows;
    try { rows = await readStock(user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    res.status(200).json({ ok: true, rows });
    return;
  }

  let shops = null, seededAccounts = null;
  const seedDate = body.seed_date || q.seed_date;
  const hasInput = (Array.isArray(body.shops) && body.shops.length) || (body.orders && typeof body.orders === "object") || seedDate;
  if (!hasInput) { res.status(400).json({ ok: false, error: "no_input", hint: "подай shops:[] / orders:{} / seed_date:YYYY-MM-DD" }); return; }
  if (Array.isArray(body.shops) && body.shops.length) {
    shops = body.shops.map(s => ({ client: s.client || null, rep: s.rep || null, client_id: s.client_id || null, person_id: s.person_id || null, account_id: s.account_id || null, order: s.order || {} }));
  } else if (body.orders && typeof body.orders === "object") {
    shops = [{ client: null, rep: null, order: body.orders }];
  } else {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    try { const s = await seedShops(String(seedDate), user, pass); shops = s.shops; seededAccounts = s.accounts; }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    // Празна дата (бъдеща/неработна) — връщаме ok с празно, не грешка.
    if (!shops.length) {
      res.status(200).json({ ok: true, seed_date: seedDate, seeded_accounts: 0, empty: true,
        note: "Няма сметки за тази дата (бъдеща или неработна). Избери минала работна дата.",
        shops: [], order_total: {}, produce_rolls: {}, produce_zagotovki: {} });
      return;
    }
  }

  const { agg, rolls, zag } = compute(shops);
  // Сетовете = сборът по сметки на артикулите-сетове (както се поръчват/продават).
  const sets = {};
  for (const [name, qty] of Object.entries(agg)) { const a = resolve(name); if (a && a.is_set) sets[name] = qty; }
  res.status(200).json({
    ok: true, seed_date: seedDate || null, seeded_accounts: seededAccounts,
    shops: shops.map(s => ({ client: s.client, rep: s.rep, client_id: s.client_id, person_id: s.person_id, account_id: s.account_id, order: sortObj(s.order || {}, 2) })),
    order_total: sortObj(agg, 2), produce_sets: sortObj(sets, 2), produce_rolls: sortObj(rolls, 2), produce_zagotovki: sortObj(zag, 3)
  });
};
