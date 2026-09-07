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
    for (const o of (rows.data || [])) {
      const art = byId(o.article_id) || resolve(o.article_name);
      if (art && art.is_menu) order[art.name] = (order[art.name] || 0) + (Number(o.amount) || 0);
    }
    const group = (cexObj(a) || {}).group || "adhoc";
    return { account_id: a.account_id, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null, rep: a.person_name || null, group, order };
  }));
  return { shops, accounts: accts.length };
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
shops.forEach(function(s,i){var full=(s.client||'')+(s.rep?(' · '+s.rep):'');var label=shortName(s.client,s.rep);h+='<tr><td class="shop" title="'+esc(full)+'"><input type="checkbox" class="selbox" data-i="'+i+'" '+(s.scheduled===false?'':'checked')+'> '+esc(label)+'</td>';
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
function loadAccounts(){var d=$('date').value;msg('Изтеглям реалните сметки за разнос '+d+'…');api({action:'load_accounts',date:d}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}shops=j.shops||[];renderGrid();$('planbox').innerHTML='';if(!shops.length){msg('Няма сметки за разнос '+j.date+'. (Сметките се правят в навечерието — избери верния ден горе в „Зареди".)','err');return}msg('Изтеглени '+shops.length+' реални сметки за разнос '+j.date+' — с номера + текущи количества. Тикни които искаш и натисни ③ Стокова.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
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
    values.create_date = date; values.term_date = date; values.payment_date = date;
    values.accounts = [acc];
    if (values.seller_company_id == null) values.seller_company_id = values.company_id != null ? values.company_id : 1;
    if (body.paymethod_id !== undefined) values.paymethod_id = body.paymethod_id === null ? null : String(body.paymethod_id);
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

  // ── ВРЕМЕНЕН: документите на сметка (има ли стокова?) ──
  if (body.action === "inv_probe") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    let out = {};
    // 1) полетата на сметка от Accounts_getlist (дали има флаг за фактура/стокова)
    try { const r = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 3 }, user, pass); let a = r.data; a = Array.isArray(a) ? a : Object.values(a || {}); out.acct_keys = a[0] ? Object.keys(a[0]) : []; out.acct_sample = a[0] || null; }
    catch (e) { out.acct_err = String(e && e.message); }
    // 2) документите на конкретни сметки (2888 имаше стокова, 2937 вероятно няма)
    for (const id of [Number(body.a1) || 2888, Number(body.a2) || 2937]) {
      try { const r = await cexCall("Accounts_account_documents", { id }, user, pass); out["docs_" + id] = JSON.stringify(r.data).slice(0, 900); }
      catch (e) { out["docs_" + id] = "ERR " + String(e && e.message); }
    }
    res.status(200).json({ ok: true, out });
    return;
  }

  // ── ИЗТЕГЛИ СМЕТКИ за разнос ден (реалните, вече коригирани сметки — за ③ Стокова) ──
  // Чете съществуващите сметки за разноса (направени в навечерието + затворените за деня),
  // с техните account_id и ТЕКУЩИ количества (след ръчните допълвания). Всички тикнати.
  if (body.action === "load_accounts") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let s;
    // Без same-day: сметка, направена в деня D, е за разноса D+1 → не влиза в разнос D.
    try { s = await seedRazos(date, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    res.status(200).json({ ok: true, date, seeded_accounts: s.shops.length,
      shops: s.shops.map(x => ({ account_id: x.account_id, client: x.client, rep: x.rep, client_id: x.client_id, person_id: x.person_id, group: x.group, scheduled: true, order: sortObj(x.order || {}, 2) })) });
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
