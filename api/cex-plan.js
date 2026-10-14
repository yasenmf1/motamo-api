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
const DATA = require("../lib/_cexdata.js");
const PAYROLL = require("../lib/payroll.js");
const TG = require("../lib/telegram.js");
const RT = require("../lib/route.js");
const ARTS = DATA.articles, NAME2ID = DATA.name2id;
const MENU = Object.values(ARTS).filter(a => a.is_menu)
  .sort((a, b) => (a.is_set - b.is_set) || (a.id - b.id))
  .map(a => ({ id: a.id, name: a.name, is_set: !!a.is_set }));

const CEX_API = "https://motamo.barsy.online", CEX_BID = 1, CEX_DEPOT = 1, TIMEOUT_MS = 9000;

// ── Кухненски snapshot (Supabase) ────────────────────────────────────────────
// Пази последно ИЗЧИСЛЕНОТО (магазини + въведени количества + производство), за да
// го виждат момичетата на view=today до следващото „Изчисли", и за да е записано
// какво е попълнил собственикът. Отделна изолирана таблица с RLS; anon ключът е
// публичен по дизайн, а достъпът тук е само сървър-към-сървър.
const SB_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0emd4cmVvamZ2ZGx0YmF2bG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjIxNzksImV4cCI6MjEwMTgzODE3OX0.o4i60i2Q9eCEhEOjw8OLmNqAkXVXpnqYYvx9_9BrkPs";
const SB_TABLE = "cex_kitchen_plan";
const sbHeaders = () => ({ apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" });
async function sbSavePlan(forDate, shops, produce, note) {
  return withTimeout(async (signal) => {
    const row = [{ for_date: forDate, shops: shops || [], produce: produce || {}, note: note || null, updated_at: new Date().toISOString() }];
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?on_conflict=for_date`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row), signal });
    return { ok: r.ok, status: r.status, raw: r.ok ? "" : String(await r.text()).slice(0, 200) };
  });
}
async function sbGetPlan(forDate) {
  return withTimeout(async (signal) => {
    const get = async (u) => { const r = await fetch(u, { headers: sbHeaders(), signal }); return r.ok ? await r.json() : []; };
    let d = forDate ? await get(`${SB_URL}/rest/v1/${SB_TABLE}?for_date=eq.${forDate}&limit=1`) : [];
    if (!d || !d.length) d = await get(`${SB_URL}/rest/v1/${SB_TABLE}?order=updated_at.desc&limit=1`);
    return (d && d[0]) || null;
  });
}

// ── ПРЕДЛОЖЕНИЕ ЗА ПОРЪЧКА (S25) ─────────────────────────────────────────────
// Кеш на документите (стокови type 11 + кредитни type 2) в Supabase: `cex_docs`
// (заглавие; person_id от сметката на стоковата) + `cex_doc_rows` (редове:
// article_id, qty, lot_date). Barsy списъкът НЯМА редове → всеки нов документ се
// чете веднъж с Invoices_get. Сметката: средно изпратено в СЪЩИЯ ден от седмицата
// (последните 4 доставки на обекта) × (1 − % връщане за 4 седм.). Връщанията се
// броят по датата на ПАРТИДАТА (lot_date = деня на доставката), не на документа.
// Стоковите носят обекта; кредитните (Мерканто) — само клиента → ставката се
// прилага към всички обекти на клиента. Връщане при СиБиЕс/Антоний = ред за 0 €
// със стара партида в стоковата (подмяна; потвърдено от собственика 29.09 на №3114).
// НЕ пише в Barsy.
const SUG_DOC_TYPES = [11, 2], SUG_WEEKS = 4, SUG_KEEP_DAYS = 49, SUG_RATE_CAP = 0.8;
async function sbReq(path, opts, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 20000);
  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...(opts || {}), headers: { ...sbHeaders(), ...((opts && opts.headers) || {}) }, signal: c.signal });
    if (!r.ok) throw new Error(`sb ${r.status} ${String(await r.text()).slice(0, 200)}`);
    const tx = await r.text(); return tx ? JSON.parse(tx) : null;
  } finally { clearTimeout(t); }
}
async function sbAll(path) {                       // PostgREST връща ≤1000 реда → страницираме
  const out = [];
  for (let off = 0; off < 100000; off += 1000) {
    const d = await sbReq(`${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${off}`);
    out.push(...(d || [])); if (!d || d.length < 1000) break;
  }
  return out;
}
const lotDateOf = v => { const m = /L\.(\d{2})\.(\d{2})\.(\d{4})/.exec(String(v || "")); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// Досинхронизира кеша: нови документи (от последните SUG_KEEP_DAYS дни) + сменен
// is_anulate. Спира при изтичане на бюджета → `pending` > 0 = извикай пак.
async function syncDocCache(user, pass, budgetMs) {
  const t0 = Date.now(), since = isoPlusDays(sofiaToday(), -SUG_KEEP_DAYS);
  const r = await cexCall("Invoices_getlist", { order_by: "inv_id desc", length: 1500 }, user, pass);
  let L = r.data || []; if (!Array.isArray(L)) L = Object.values(L);
  L = L.filter(x => SUG_DOC_TYPES.includes(Number(x.type_id)) && String(x.create_date || "") >= since);
  const cached = await sbAll(`cex_docs?select=inv_id,is_anulate&doc_date=gte.${since}`);
  const have = {}; for (const c of cached) have[c.inv_id] = Number(c.is_anulate) || 0;
  // анулирани след кеширане → само флагът
  for (const x of L) {
    const an = Number(x.is_anulate) ? 1 : 0;
    if (have[x.inv_id] != null && have[x.inv_id] !== an)
      await sbReq(`cex_docs?inv_id=eq.${x.inv_id}`, { method: "PATCH", body: JSON.stringify({ is_anulate: an }) });
  }
  const todo = L.filter(x => have[x.inv_id] == null);
  // Редове от преди колоната line_total (29.09) → прочитат се пак и се допълват (upsert).
  const stale = await sbReq(`cex_doc_rows?select=inv_id&line_total=is.null&limit=1000`).catch(() => []);
  const staleIds = new Set((stale || []).map(r => Number(r.inv_id)));
  for (const x of L) if (staleIds.has(Number(x.inv_id)) && have[x.inv_id] != null) todo.push(x);
  let accMap = null, done = 0, failed = 0;
  const getAccMap = async () => {
    if (accMap) return accMap;
    const a = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 3000 }, user, pass);
    let all = a.data || []; if (!Array.isArray(all)) all = Object.values(all);
    accMap = {}; for (const x of all) accMap[x.account_id] = x; return accMap;
  };
  const one = async x => {
    const g = await cexCall("Invoices_get", { inv_id: Number(x.inv_id), id: Number(x.inv_id) }, user, pass);
    const d = g.data || {};
    if (!Array.isArray(d.items)) throw new Error("no_items");
    let person = null;
    const accs = Array.isArray(d.accounts) ? d.accounts : [];
    if (accs.length) { const m = await getAccMap(); const a = m[accs[0]]; if (a && a.person_id != null) person = Number(a.person_id); }
    const doc = { inv_id: Number(x.inv_id), type_id: Number(x.type_id), doc_date: String(x.create_date).slice(0, 10),
      client_id: x.client_id != null ? Number(x.client_id) : null, person_id: person, is_anulate: Number(x.is_anulate) ? 1 : 0 };
    const rows = d.items.filter(it => it.article_id != null && it.article_id !== "" && Number(it.quantity))
      .map(it => ({ inv_id: doc.inv_id, item_id: Number(it.item_id), article_id: Number(it.article_id), qty: Number(it.quantity), line_total: Number(it.line_total) || 0, lot_date: lotDateOf(it.lot_value) }));
    await sbReq(`cex_docs?on_conflict=inv_id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([doc]) });
    if (rows.length) await sbReq(`cex_doc_rows?on_conflict=inv_id,item_id`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows) });
  };
  for (let i = 0; i < todo.length; i += 4) {
    if (Date.now() - t0 > budgetMs) break;
    const res = await Promise.allSettled(todo.slice(i, i + 4).map(one));
    for (const s of res) { if (s.status === "fulfilled") done++; else failed++; }
  }
  return { listed: L.length, cached_before: cached.length, added: done, failed, pending: todo.length - done - failed };
}

// Предложение за деня `target` (ISO) по обект „client:person" → { име на артикул: {n, avg, rate, weeks} }.
async function computeSuggestion(target) {
  const from = isoPlusDays(target, -SUG_KEEP_DAYS);
  const docs = await sbAll(`cex_docs?select=inv_id,type_id,doc_date,client_id,person_id&is_anulate=eq.0&doc_date=gte.${from}&doc_date=lt.${target}`);
  const byDoc = {}; for (const d of docs) byDoc[d.inv_id] = d;
  const rows = docs.length ? await sbAll(`cex_doc_rows?select=inv_id,article_id,qty,line_total,lot_date&inv_id=gte.${Math.min(...docs.map(d => d.inv_id))}`) : [];
  const dow = new Date(target + "T12:00:00Z").getUTCDay(), win = isoPlusDays(target, -7 * SUG_WEEKS);
  const dowOf = iso => new Date(iso + "T12:00:00Z").getUTCDay();
  const sent = {};      // key → date → artId → qty (положителни редове на стоковите)
  const ret = {};       // key → artId → върнато (стокови, в прозореца по партида)
  const cRet = {};      // client → artId → върнато (кредитни)
  const sentWin = {}, cSentWin = {};   // изпратено в прозореца (база за %)
  for (const r of rows) {
    const d = byDoc[r.inv_id]; if (!d) continue;
    const q = Number(r.qty) || 0, art = r.article_id;
    const key = (d.client_id != null ? d.client_id : "") + ":" + (d.person_id != null ? d.person_id : "");
    const rd = r.lot_date || d.doc_date;
    // СиБиЕс/Антоний връщат като ред за 0 € със СТАРА партида (подмяна на върнатото) →
    // това е връщане, не търсене. Отрицателен ред (кредитно) също е връщане.
    const zero = q > 0 && r.line_total != null && Number(r.line_total) === 0;
    if (zero) { if (rd >= win) (ret[key] = ret[key] || {})[art] = (ret[key][art] || 0) + q; continue; }
    if (d.type_id === 11 && q > 0) {
      ((sent[key] = sent[key] || {})[d.doc_date] = sent[key][d.doc_date] || {})[art] = (sent[key][d.doc_date][art] || 0) + q;
      if (d.doc_date >= win) {
        (sentWin[key] = sentWin[key] || {})[art] = (sentWin[key][art] || 0) + q;
        (cSentWin[d.client_id] = cSentWin[d.client_id] || {})[art] = (cSentWin[d.client_id][art] || 0) + q;
      }
    } else if (q < 0 && rd >= win) {
      if (d.type_id === 11) (ret[key] = ret[key] || {})[art] = (ret[key][art] || 0) - q;
      else (cRet[d.client_id] = cRet[d.client_id] || {})[art] = (cRet[d.client_id][art] || 0) - q;
    }
  }
  const out = {};
  for (const key of Object.keys(sent)) {
    const client = key.split(":")[0];
    // липсваща седмица ≠ нула: броим само дните, в които обектът е получил стокова
    let dates = Object.keys(sent[key]).filter(x => dowOf(x) === dow).sort().slice(-SUG_WEEKS), same = true;
    if (dates.length < 2) { dates = Object.keys(sent[key]).filter(x => x >= win).sort().slice(-SUG_WEEKS); same = false; }
    if (dates.length < 2) continue;
    const arts = new Set(); dates.forEach(x => Object.keys(sent[key][x]).forEach(a => arts.add(a)));
    const o = {};
    for (const a of arts) {
      const art = byId(a); if (!art || !art.is_menu) continue;
      const avg = dates.reduce((s, x) => s + (sent[key][x][a] || 0), 0) / dates.length;
      const sw = (sentWin[key] || {})[a] || 0, csw = (cSentWin[client] || {})[a] || 0;
      let rate = (sw ? (((ret[key] || {})[a] || 0) / sw) : 0) + (csw ? (((cRet[client] || {})[a] || 0) / csw) : 0);
      rate = Math.min(SUG_RATE_CAP, Math.max(0, rate));
      o[art.name] = { n: Math.round(avg * (1 - rate)), avg: Math.round(avg * 10) / 10, rate: Math.round(rate * 100), weeks: dates.length, same };
    }
    out[key] = o;
  }
  return { target, docs: docs.length, rows: rows.length, by: out };
}

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
function cexCall(action, params, user, pass, base) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${base || CEX_API}/endpoints/json/${action}?bid=${CEX_BID}`, {
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
function cexCallRoot(bodyObj, user, pass, base) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${base || CEX_API}/endpoints/json?bid=${CEX_BID}`, {
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
// НЕТО произведено под дадена партида, {article_id: кол} — по всички производства
// (анулиращите документи са с минус и гасят оригинала). Пази ① от повторно производство
// на вече произведеното за деня (натиснато два пъти = двойни количества, 10.09).
function markRel(o, ok) { Object.defineProperty(o, "_ok", { value: !!ok, enumerable: false }); return o; }
async function producedUnderLot(lot, user, pass) {
  const out = {};
  if (!lot) return markRel(out, false);
  let rel = true;
  // Storeproductions_getlist НЕ връща партидата по ред → четем справката за партиди:
  // редовете тип „AP" (производство, ref_id = № на производството) носят article_id + amount
  // (анулиращият документ е с минус). Страници по 50.
  for (let pg = 1; pg <= 12; pg++) {
    let d = null;
    for (let t = 0; t < 3 && d === null; t++) {
      try {
        const r = await cexCall("Reports_lot_list_details", { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { lot_value: String(lot) } }, user, pass);
        if (r && r.ok && r.data) d = r.data;
      } catch (e) {}
      if (d === null) await new Promise(res => setTimeout(res, 200 * (t + 1)));
    }
    if (!d) { rel = false; break; }   // ★ S23: неуспяла страница = справката НЕ е надеждна
    const rows = Array.isArray(d.rows) ? d.rows : [];
    // ★ S27 — броим и „RC" (ревизия): тя изписва/добавя под същата партида. Само с „AP" след
    // ревизия излизаше 338 CET KAWA „произведени", а реално под партидата са 28 → планът смяташе,
    // че има предостатъчно, ② не произвеждаше и сметките падаха.
    for (const x of rows) { if ((x.operation_ref_type === "AP" || x.operation_ref_type === "RC") && x.article_id != null) out[String(x.article_id)] = (out[String(x.article_id)] || 0) + (Number(x.amount) || 0); }
    if (rows.length < 50) break;
  }
  return markRel(out, rel);
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
  const r = await cexCall("Articles_getlistobject", { filters: { depot_id: CEX_DEPOT }, extra_properties: ["store_amount"] }, user, pass);
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
async function stockMap(user, pass, depot) {
  const r = await cexCall("Articles_getlistobject", { filters: { depot_id: depot || CEX_DEPOT }, extra_properties: ["store_amount"] }, user, pass);
  const L = r.data && (r.data.list || r.data) || {};
  const list = Array.isArray(L) ? L : Object.values(L);
  const m = {};
  for (const a of list) { const id = a && (a.article_id || a.id); if (id != null) { const q = Number(a.store_amount); m[String(id)] = isNaN(q) ? null : Math.round(q * 1000) / 1000; } }
  return m;
}
// ★ S20 ден3 — ЗАПАЗЕНОТО от ОТВОРЕНИТЕ сметки. Barsy НЕ приспада наличност при отворена
// сметка (само „запазва"), а справката/складът показват БРУТНО → производството подценяваше.
// Тук сумираме поръчките на всички НЕзатворени сметки → реалното свободно = склад − запазено.
async function reservedOpen(user, pass) {
  const r = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 900 }, user, pass);
  let all = r.data || []; if (!Array.isArray(all)) all = Object.values(all);
  const open = all.filter(a => !String(a.close_date || "").trim()
    && String(a.is_anulate != null ? a.is_anulate : (a.anulate_flag != null ? a.anulate_flag : "0")) !== "1");
  const reserved = {};
  await mapLimit(open, 6, async (a) => {
    try {
      const rows = await cexCall("Orders_getlist", { filters: { account_id: a.account_id } }, user, pass);
      for (const o of (rows.data || [])) { const id = String(o.article_id); if (id) reserved[id] = (reserved[id] || 0) + (Number(o.amount) || 0); }
    } catch (e) {}
  });
  return { reserved, count: open.length };
}

// ★ S27 — ЕДИН ИЗТОЧНИК ЗА ПАРТИДИТЕ. Barsy сам казва по (артикул, партида, склад) колко е
// „реално" (amount_real) и колко е „запазено" от отворени сметки (amount_reserved, с минус).
// Сметка минава само ако реално + запазено ≥ бройката. Преди смятахме това по три заобиколни
// пътя (справка за партиди + всички отворени сметки + сметки по дата) и всяка сутрин единият
// се разминаваше с Barsy. Една заявка, ~1 сек. filters: {} = всички партиди; {lot_value} = една.
async function lotRows(filters, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const rr = await fetch(`${CEX_API}/endpoints/json?bid=1`, { method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ Lots_GetListAvailability: { params: { bid: 1, article_id: 1, id: 1 }, filters: Object.assign({ has_amount_real_or_reserved: 1 }, filters || {}) } }), signal });
    const d = await rr.json();
    const rows = d && d.Lots_GetListAvailability;
    if (!Array.isArray(rows)) throw new Error("партидите не се прочетоха от Barsy");
    return rows.filter(x => Number(x.depot_id) === CEX_DEPOT);
  });
}
// „L.dd.mm.yyyy" → „yyyy-mm-dd" (за сравнение по дата); друго → null.
const lotIso = v => { const m = /^L\.(\d{2})\.(\d{2})\.(\d{4})/.exec(String(v || "")); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
// ★ S27 — СЪСТОЯНИЕ НА ДЕНЯ (Supabase `cex_day_state`, ключ = датата на разноса/партидата):
// grid = решетката на собственика (магазини, заявки, тикове); accounts = кои магазини вече имат
// сметка за тази дата (пише го ③ на сървъра — не зависи от браузъра). Четенето ХВЪРЛЯ при
// неуспех: без него не знаем кой магазин има сметка и бихме произвели двойно → по-добре стоп.
const dayKey = s => String(s.client_id != null ? s.client_id : "") + "|" + String(s.person_id != null ? s.person_id : "") + "|" + String(s.client_id != null ? "" : (s.client || "") + "/" + (s.rep || ""));
async function dayGet(forDate) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/cex_day_state?for_date=eq.${forDate}&limit=1`, { headers: sbHeaders(), signal });
    if (!r.ok) throw new Error("записът на деня не се прочете (" + r.status + ")");
    const d = await r.json();
    return (d && d[0]) || { for_date: forDate, state: {}, updated_at: null };
  });
}
async function daySave(forDate, state) {
  return withTimeout(async (signal) => {
    const now = new Date().toISOString();
    const r = await fetch(`${SB_URL}/rest/v1/cex_day_state?on_conflict=for_date`, { method: "POST",
      headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ for_date: forDate, state, updated_at: now }]), signal });
    return { ok: r.ok, status: r.status, updated_at: now };
  });
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
// Оформя един „магазин" от сметка: чете поръчките ѝ, сумата (с ДДС) и меню-количествата.
async function shopFromAccount(a, user, pass) {
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
  return { account_id: a.account_id, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null, rep: a.person_name || null, group, order, total: Math.round(total * 100) / 100, close_date: String(a.close_date || "").slice(0, 10) || null, create_date: String(a.create_date || "").slice(0, 10) || null };
}

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
  const shops = await Promise.all(accts.map(a => shopFromAccount(a, user, pass)));
  return { shops, accounts: accts.length };
}

// Зарежда сметките, ползвали ПАРТИДА L.<дата> (за ③ Стокова). Партида→сметка става през
// справката Reports_lot_list_details: движенията тип „AC" (продажба от сметка) носят
// ref_id = номер на сметката. Прозорец ±2 дни, защото продажбите от партидата се разтеглят
// няколко дни след производството. Връща същата форма като seedRazos.
async function seedByLot(dateIso, user, pass) {
  const lot = lotFor(dateIso).lot;                       // L.dd.mm.yyyy
  const fromD = isoPlusDays(dateIso, -2), toD = isoPlusDays(dateIso, 2);
  const ids = new Set();
  for (let pg = 1; pg <= 12; pg++) {
    let d = null;
    for (let t = 0; t < 3 && d === null; t++) {
      try {
        const r = await cexCall("Reports_lot_list_details",
          { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { ref_date: [fromD, toD], lot_value: lot } }, user, pass);
        if (r && r.ok && r.data) d = r.data;
      } catch (e) {}
      if (d === null) await new Promise(res => setTimeout(res, 200 * (t + 1)));
    }
    if (!d) break;
    const rows = Array.isArray(d.rows) ? d.rows : [];
    for (const x of rows) { if (x.operation_ref_type === "AC" && x.ref_id != null) ids.add(Number(x.ref_id)); }
    if (rows.length < 50) break;
  }
  const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 2000 }, user, pass);
  let all = list.data || []; if (!Array.isArray(all)) all = Object.values(all);
  const byAcc = {}; for (const a of all) byAcc[a.account_id] = a;
  const targets = [...ids].map(id => byAcc[id]).filter(Boolean);
  const shops = await Promise.all(targets.map(a => shopFromAccount(a, user, pass)));
  return { shops, accounts: targets.length, lot, missing: ids.size - targets.length };
}

// Barsy справка „Продажби по артикули" (Reports_sales_by_articles) — ЕДНА заявка връща
// на артикул: cnt (бройки), total_no_dds (оборот без ДДС) и delivery_total (себестойност
// без ДДС, от AVG_DELIVERY_PRICE). Заменя крехкото Orders-страниране за COGS/маржин.
// Данните идват през „values" извикване (action_type:values + active_struct_id).
async function reportSalesByArticles(from, to, user, pass, clientId) {
  const by = {};   // article_id → { name, units, revenue, cost }
  let ok = false, incomplete = false;
  const PAGE = 50, MAXPG = 30;
  for (let pg = 1; pg <= MAXPG; pg++) {
    let rows = null;
    for (let t = 0; t < 3 && rows === null; t++) {
      try {
        const r = await cexCall("Reports_sales_by_articles",
          { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: clientId != null ? { ref_date: [from, to], client: clientId } : { ref_date: [from, to] } }, user, pass);
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
// Пробни клиенти, които не тръгнаха (собственикът, 29.09) — вън от ВСИЧКИ справки.
const TRIAL_CLIENTS = /^\s*(анонимен|саси трейд|симеонови 2026|падел клуб)/i;
const isTrialClient = a => TRIAL_CLIENTS.test(String((a && a.client_name) || ""));


// ── ФИКСИРАНИ МЕСЕЧНИ РАЗХОДИ (бруто заплати в EUR + наем/ток) — от 01.2026 (S30, 13.10).
// Източник: ведомост „ЧОВЕК И БЪДЕЩЕ ЕООД" Септ.2026 (бруто) + наем/ток от собственика.
// Цех = всички заплати без Роксана + управител; точката (в api/shop-dash.js) = Роксана + Радостина + наем + ток.
const FIXED_START = "2026-01-01";
// Осигуровки ЗА СМЕТКА НА РАБОТОДАТЕЛЯ (категория 3): ~18.92% върху осиг. доход,
// с таван 2300 €/мес (видян във ведомостта за управителя). Ведомостта не ги показва изрично.
const EMPLOYER_OSIG_RATE = 0.1892, OSIG_CAP = 2300;
const CEX_FIXED_SALARIES = [
  { label: "Ясен Начев (управител)", amount: 5129.49 },
  { label: "Румена Тенева", amount: 1420.37 },
  { label: "Йорданка Янкова", amount: 1588.48 },
  { label: "Лидия (на мястото на Диана)", amount: 1250.01 },
  { label: "Мария Пейчева", amount: 1250.01 },
  { label: "Митьо Димитров (шофьор)", amount: 824.35 },
  { label: "Станислав Покотилюк", amount: 1250.01 },
];
const CEX_FIXED_OTHER = []; // цехът няма наем/ток в тази сметка
function employerOsig(salaries) { return Math.round(salaries.reduce((s, l) => s + Math.min(l.amount, OSIG_CAP) * EMPLOYER_OSIG_RATE, 0) * 100) / 100; }
function buildFixed(salaries, other) {
  const salSum = Math.round(salaries.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const othSum = Math.round(other.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  const osig = employerOsig(salaries);
  const monthly = Math.round((salSum + othSum + osig) * 100) / 100;
  return { salaries, other, salSum, othSum, osig, monthly };
}
const CEX_FIXED = buildFixed(CEX_FIXED_SALARIES, CEX_FIXED_OTHER);
const CEX_FIXED_MONTHLY = CEX_FIXED.monthly; // бруто заплати + осигуровки работодател
// Пропорционално по дни: месеци в [from,to] ∩ [start,∞); частичен месец се брои пропорционално.
function monthsInRange(from, to, start) {
  const s = (from && from > start) ? from : start;
  if (!to || s > to) return 0;
  const d0 = Date.parse(s + "T00:00:00Z"), d1 = Date.parse(to + "T00:00:00Z");
  if (!(d1 >= d0)) return 0;
  const days = (d1 - d0) / 86400000 + 1; // включително крайния ден
  return days / 30.4375;
}
function fixedForRange(from, to, monthly, start) {
  const m = monthsInRange(from, to, start);
  return { total: Math.round(monthly * m * 100) / 100, months: Math.round(m * 100) / 100, monthly };
}

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
    cexCall("Articles_getlistobject", { filters: { depot_id: CEX_DEPOT }, extra_properties: ["avg_delivery_price", "store_amount"] }, user, pass).catch(() => ({ data: [] })),
    cexCall("Storeloads_getlist", { order_by: "store_load_id desc", length: 2000, extra_properties: ["all"] }, user, pass).catch(() => ({ data: [] })),
    reportSalesByArticles(from, to, user, pass).catch(() => ({ ok: false, incomplete: true, articles: [] })),
  ]);
  let all = arrOf(accR);
  const byDay = {};        // "YYYY-MM-DD" → нето оборот
  const byClient = {};     // client_id → { name, neto, n }
  let totalNeto = 0, accountsN = 0;
  for (const a of all) {
    if (String(a.account_alias || "").includes("CLTEST") || isTrialClient(a)) continue;
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
    if (isTrialClient(x)) continue;
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

  // ── КЛИЕНТ × АРТИКУЛ: кой клиент колко бройки от всеки артикул (справка „Продажби по
  // артикули" с filters.client — проверено 29.09: СиБиЕс ≠ общото). По 4 паралелно.
  await mapLimit(clients, 4, async (c) => {
    try {
      const r = await reportSalesByArticles(from, to, user, pass, c.client_id);
      c.arts = (r.articles || []).filter(a => a.units > 0).map(a => ({ id: a.article_id, name: a.name,
        units: Math.round(a.units * 100) / 100, revenue: Math.round(a.revenue * 100) / 100 }));
      c.arts_incomplete = !!r.incomplete;
    } catch (e) { c.arts = null; }
  });

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
  // label = номерът на магазина, както го знаят управителките (таблицата на собственика, 14.10);
  // person_id в Barsy НЕ е този номер. Формата го показва най-отгоре.
  "2:1": { group: "sibies", label: "СИБИЕС 4" },  "2:2": { group: "sibies", label: "СИБИЕС 13" },  "2:3": { group: "sibies", label: "СИБИЕС 7" },
  "2:4": { group: "sibies", form: true, label: "СИБИЕС 11" },  "2:5": { group: "sibies", form: true, label: "СИБИЕС 12" },  "2:6": { group: "sibies" },
  "2:7": { group: "sibies", label: "СИБИЕС 16" },  "2:8": { group: "sibies", label: "СИБИЕС 17" },  "2:9": { group: "sibies", label: "СИБИЕС 10" },
  "2:10": { group: "sibies" }, "2:11": { group: "sibies", form: true, label: "СИБИЕС 3" }, "2:12": { group: "sibies" },
  "2:13": { group: "sibies" }, "2:14": { group: "sibies" }, "2:15": { group: "sibies" },
  // Сливен — Мерканто / АНТОНИЙ ЕООД (клиент 11)
  "11:23": { group: "merkanto" }, "11:25": { group: "merkanto" }, "11:26": { group: "merkanto" },
  "11:27": { group: "merkanto" }, "11:28": { group: "merkanto" }, "11:29": { group: "merkanto" },
  "11:30": { group: "merkanto" }, "11:31": { group: "merkanto" }, "11:32": { group: "merkanto" },
  // Ад-хок / по заявка (показват се, но не се тикат)
  "4:": { group: "adhoc", form: true, label: "A шоп" }, "8:": { group: "adhoc" }, "8:21": { group: "adhoc" }, "8:22": { group: "adhoc", form: true, label: "Athletic Fitness" },
  "5:": { group: "adhoc" }, "5:16": { group: "adhoc" }, "5:17": { group: "adhoc" }, "5:18": { group: "adhoc" },
  // нови представители (05.10) — без сметка досега; client/rep са нужни, за да се покажат в „+ Магазин"
  "5:19": { group: "adhoc", client: "Пламен Петров", rep: "кафе Винил" }, "5:20": { group: "adhoc", client: "Пламен Петров", rep: "лог. център Била" },
  "12:": { group: "adhoc" }, "7:": { group: "adhoc", form: true, label: "Сити" }, "10:": { group: "adhoc", form: true, label: "Тара Шуус" }, "13:": { group: "adhoc" }, "3:": { group: "adhoc" }
};
function cexKey(a) { return (a.client_id != null ? a.client_id : "") + ":" + (a.person_id != null ? a.person_id : ""); }
function cexObj(a) { return CEX_OBJECTS[cexKey(a)] || null; }
// ── ★ S32 — ФОРМА ЗА ЗАЯВКА НА МАГАЗИН (линк без парола) ──────────────────────
// Управителката отваря `?view=zayavka&o=<client:person>&k=<ключ>` на телефона. Ключът е
// HMAC на обекта със секрет от Vercel (SHOP_FORM_SECRET, иначе PAY_HMAC_SECRET) — нищо не
// се пази в база; смяна на `fv` в CEX_OBJECTS обезсилва стария линк. Формата показва само
// артикулите, които обектът е ПОЛУЧАВАЛ (стоковите в кеша cex_docs/cex_doc_rows), с
// „миналия същи ден" и „последна доставка", предложена бройка (computeSuggestion) и
// незадължително „останало" (продадено = доставено − останало; ние не виждаме касата на
// магазина). Заявката се записва в Supabase `cex_shop_requests` (upsert по дата+обект, НЕ се
// заключва по час — носи час). Нищо не пише в Barsy: собственикът я прилага в решетката.
const FORM_VERSION = 1, FORM_SWITCH_HOUR = 9, FORM_SWITCH_MIN = 30;   // до 09:30 → за днес (разносът 09:00, късните до 09:30), после → за утре; за магазина това е „днес"
const ROUTE_NAMES = (() => { const m = {}; try { for (const st of require("../lib/route.js").ROUTE) for (const k of (st.keys || [])) if (!m[k]) m[k] = st.name; } catch (e) {} return m; })();
function formSecret() { return process.env.SHOP_FORM_SECRET || process.env.PAY_HMAC_SECRET || ""; }
function formToken(key) {
  const v = (CEX_OBJECTS[key] || {}).fv || FORM_VERSION;
  return crypto.createHmac("sha256", formSecret()).update(`zayavka:${key}:v${v}`).digest("hex").slice(0, 24);
}
function formAuth(key, tok) {
  const o = CEX_OBJECTS[String(key || "")];
  if (!formSecret() || !o || !o.form) return false;
  const a = Buffer.from(formToken(key)), b = Buffer.from(String(tok || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function formObjName(key) {   // пълното име за собственика: „СИБИЕС 11 · СиБиЕс Граф Игнатиев 59 (Бедечка)"
  const o = CEX_OBJECTS[key] || {};
  const place = ROUTE_NAMES[key] || [o.client, o.rep].filter(Boolean).join(" · ") || key;
  return o.label ? o.label + " · " + place : place;
}
function formObjLabel(key) {  // как го знае управителката: „СИБИЕС 11"; без label — мястото
  const o = CEX_OBJECTS[key] || {};
  return o.label || ROUTE_NAMES[key] || [o.client, o.rep].filter(Boolean).join(" · ") || key;
}
function formObjPlace(key) { return ROUTE_NAMES[key] || ""; }
function formShops() { return Object.keys(CEX_OBJECTS).filter(k => CEX_OBJECTS[k].form); }
// Кратък адрес: zayavka.motamo.bg/sibies-11-k7f3q2 (vercel.json пренаписва към ?view=zayavka&s=<slug>).
// slug = латиница от label/името + първите 6 знака на ключа; проверява се пак с constant-time сравнение.
const FORM_HOST = process.env.ZAYAVKA_HOST || "zayavka.motamo.bg", FORM_SLUG_KEY = 6;
const TRANSLIT = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "", ю: "yu", я: "ya" };
function slugBase(key) { return formObjLabel(key).toLowerCase().split("").map(ch => TRANSLIT[ch] != null ? TRANSLIT[ch] : ch).join("").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function formSlug(key) { return slugBase(key) + "-" + formToken(key).slice(0, FORM_SLUG_KEY); }
function formKeyFromSlug(slug) {   // „sibies-11-k7f3q2" → "2:4" (ако 6-те знака съвпадат с ключа на обекта)
  const m = /^([a-z0-9-]+)-([0-9a-f]{6})$/.exec(String(slug || "")); if (!m) return null;
  for (const key of formShops()) {
    if (slugBase(key) !== m[1]) continue;
    const a = Buffer.from(formToken(key).slice(0, FORM_SLUG_KEY)), b = Buffer.from(m[2]);
    return (a.length === b.length && crypto.timingSafeEqual(a, b)) ? key : null;
  }
  return null;
}
function formLink(key, host) { return `https://${FORM_HOST}/${formSlug(key)}`; }
function sofiaHM() { const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()); const g = t => Number((p.find(x => x.type === t) || {}).value); return [g("hour"), g("minute")]; }
function formDefaultDate() { const [h, m] = sofiaHM(); const today = sofiaToday(); return (h < FORM_SWITCH_HOUR || (h === FORM_SWITCH_HOUR && m <= FORM_SWITCH_MIN)) ? today : isoPlusDays(today, 1); }
const DOW_BG = ["неделя", "понеделник", "вторник", "сряда", "четвъртък", "петък", "събота"];
function dowBg(iso) { return DOW_BG[new Date(iso + "T12:00:00Z").getUTCDay()]; }
// История на обекта (само стокови type 11, не анулирани, положителни редове с цена) — последните 35 дни.
async function shopHistory(key, target) {
  const [c, p] = key.split(":");
  const from = isoPlusDays(target, -35);
  const docs = await sbAll(`cex_docs?select=inv_id,doc_date&type_id=eq.11&is_anulate=eq.0&client_id=eq.${c}&person_id=${p ? "eq." + p : "is.null"}&doc_date=gte.${from}&doc_date=lte.${target}&order=doc_date.asc`);
  if (!docs.length) return { dates: [], byArt: {} };
  const byDoc = {}; for (const d of docs) byDoc[d.inv_id] = d.doc_date;
  const rows = await sbAll(`cex_doc_rows?select=inv_id,article_id,qty,line_total&inv_id=in.(${docs.map(d => d.inv_id).join(",")})`);
  const byArt = {}; const dates = new Set();
  for (const r of rows) {
    const q = Number(r.qty) || 0; if (q <= 0 || (r.line_total != null && Number(r.line_total) === 0)) continue;
    const d = byDoc[r.inv_id]; if (!d) continue; dates.add(d);
    const a = byArt[r.article_id] = byArt[r.article_id] || {}; a[d] = (a[d] || 0) + q;
  }
  return { dates: [...dates].sort(), byArt };
}
async function shopFormData(key, dateIso) {
  const today = sofiaToday();
  const def = formDefaultDate();
  const target = /^\d{4}-\d{2}-\d{2}$/.test(dateIso || "") && dateIso >= today && dateIso <= isoPlusDays(today, 3) ? dateIso : def;
  const [hist, sug] = await Promise.all([shopHistory(key, today), computeSuggestion(target).catch(() => ({ by: {} }))]);
  const sgObj = (sug.by || {})[key] || {};
  const dow = new Date(target + "T12:00:00Z").getUTCDay();
  const items = [];
  for (const m of MENU) {
    const h = hist.byArt[String(m.id)] || hist.byArt[m.id]; if (!h) continue;
    const ds = Object.keys(h).sort();
    const last = ds[ds.length - 1];
    const same = ds.filter(d => d !== target && new Date(d + "T12:00:00Z").getUTCDay() === dow).pop();
    const sg = sgObj[m.name];
    items.push({ id: m.id, name: m.name, is_set: !!m.is_set, last: last ? { date: last, qty: h[last] } : null,
      last_same: same ? { date: same, qty: h[same] } : null, today: h[today] || 0,
      suggest: sg ? sg.n : (same ? h[same] : (last ? h[last] : 0)), avg: sg ? sg.avg : null, weeks: sg ? sg.weeks : 0 });
  }
  let existing = null;
  try { const ex = await sbAll(`cex_shop_requests?select=id,for_date,rows,left_qty,note,sent_at,updated_at&for_date=eq.${target}&obj_key=eq.${encodeURIComponent(key)}`); existing = ex[0] || null; } catch (e) {}
  return { obj: { key, name: formObjName(key) }, for_date: target, default_date: def, today, dow: dowBg(target), items, existing,
    other: MENU.filter(m => !items.some(i => i.id === m.id)).map(m => ({ id: m.id, name: m.name })) };
}
async function shopFormSend(key, body) {
  const today = sofiaToday();
  const forDate = String(body.for_date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(forDate) || forDate < today || forDate > isoPlusDays(today, 3)) return { ok: false, error: "bad_date", message: "Датата трябва да е днес или до 3 дни напред." };
  const rows = [];
  for (const r of (Array.isArray(body.rows) ? body.rows : [])) {
    const id = Number(r && r.id), qty = Math.round(Number(r && r.qty));
    if (!MENU.some(m => m.id === id) || !(qty >= 0 && qty <= 300)) continue;
    if (qty > 0) rows.push({ id, name: byId(id).name, qty });
  }
  const left = {};
  for (const [id, v] of Object.entries(body.left && typeof body.left === "object" ? body.left : {})) { const q = Math.round(Number(v)); if (MENU.some(m => String(m.id) === String(id)) && q >= 0 && q <= 300) left[id] = q; }
  const now = new Date().toISOString();
  const row = { for_date: forDate, obj_key: key, rows, left_qty: left, note: String(body.note || "").slice(0, 300) || null, source: "form", sent_at: now, updated_at: now };
  try { await sbReq(`cex_shop_requests?on_conflict=for_date,obj_key`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([row]) }); }
  catch (e) { return { ok: false, error: "save_failed", message: "Заявката не се записа. Опитай пак след минута." }; }
  return { ok: true, for_date: forDate, rows, left, sent_at: now };
}
async function shopRequestsFor(dateIso, host) {
  const list = await sbAll(`cex_shop_requests?select=id,for_date,obj_key,rows,left_qty,note,source,sent_at,updated_at,applied_at,applied_rows&for_date=eq.${dateIso}&order=sent_at.asc`);
  const requests = list.map(x => { const o = CEX_OBJECTS[x.obj_key] || {}; const [c, p] = x.obj_key.split(":"); return {
    id: x.id, obj_key: x.obj_key, name: formObjName(x.obj_key), client_id: Number(c), person_id: p ? Number(p) : null, group: o.group || "adhoc",
    rows: x.rows || [], left: x.left_qty || {}, note: x.note, source: x.source, sent_at: x.sent_at, applied_at: x.applied_at,
    applied: !!x.applied_at && JSON.stringify(x.applied_rows || []) === JSON.stringify(x.rows || []) }; });
  const got = new Set(requests.map(r => r.obj_key));
  const silent = formShops().filter(k => !got.has(k)).map(k => ({ obj_key: k, name: formObjName(k) }));
  const links = {}; for (const k of formShops()) links[k] = formLink(k, host);
  return { date: dateIso, requests, silent, links };
}
function zayavkaPage(key, tok) {
  const name = formObjLabel(key), place = (CEX_OBJECTS[key] || {}).label ? formObjPlace(key) : "";
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Заявка · ${esc(name)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}
body{font:17px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#eef0f3;color:#14171a}
header{background:linear-gradient(135deg,#b3121b,#7a0c12);color:#fff;padding:14px 16px;position:sticky;top:0;z-index:5}
header h1{margin:0;font-size:20px;font-weight:800}header .d{font-size:13px;opacity:.9;margin-top:3px}
.wrap{padding:12px;max-width:560px;margin:0 auto}
.card{background:#fff;border-radius:14px;box-shadow:0 2px 8px rgba(20,23,26,.08);padding:12px;margin-bottom:12px}
.days{display:flex;gap:8px}.days button{flex:1;padding:12px 8px;border:2px solid #d7dade;background:#fff;border-radius:12px;font-size:15px;font-weight:700;color:#444}
.days button.on{border-color:#b3121b;background:#fdecec;color:#b3121b}
.warn{background:#fff7e0;color:#7a4b00;border-radius:10px;padding:8px 10px;font-size:13px;margin-top:8px;display:none}
table{width:100%;border-collapse:collapse;table-layout:fixed}th{font-size:10px;color:#777;font-weight:600;text-align:center;padding:4px 1px;white-space:nowrap;overflow:hidden}th.c1{width:58%}th.c5{width:42%}
td{padding:6px 1px;border-top:1px solid #f0f1f3;vertical-align:middle}td.n{font-weight:800;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:6px}td.n small{display:block;font-weight:500;color:#888;font-size:12px}
td.h{text-align:center;color:#666;font-size:13px;white-space:nowrap;line-height:1.15}td.h small{font-size:10px;color:#999}
.q{display:flex;align-items:center;justify-content:center;gap:2px}.q button{width:44px;min-width:44px;height:44px;padding:0;border:1px solid #cfd3d8;background:#fafbfc;border-radius:8px;font-size:20px;line-height:1;color:#333}
.q input{width:52px;min-width:0;height:44px;padding:0;text-align:center;font-size:20px;font-weight:800;border:1px solid #cfd3d8;border-radius:8px;-moz-appearance:textfield}.q input::-webkit-outer-spin-button,.q input::-webkit-inner-spin-button,td.l input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.q input.sug{color:#1565c0}
td.l{text-align:center}td.l input{width:38px;min-width:0;height:34px;padding:0;text-align:center;font-size:15px;border:1px dashed #cfd3d8;border-radius:8px;color:#555;-moz-appearance:textfield}
.note{font-size:12px;color:#777;margin-top:8px}
.btns{display:flex;gap:8px;margin-top:10px}.btns button{flex:1;padding:11px;border:1px solid #cfd3d8;background:#fff;border-radius:10px;font-size:14px}
.send{width:100%;margin-top:10px;padding:15px;border:0;border-radius:12px;background:#0a7d33;color:#fff;font-size:18px;font-weight:800}
.send:disabled{opacity:.5}
.msg{padding:10px 12px;border-radius:10px;margin-top:10px;display:none;font-size:14px}.msg.ok{display:block;background:#e8f5e9;color:#1b5e20}.msg.err{display:block;background:#fde8e8;color:#9b1c1c}.msg.info{display:block;background:#e9f0fb;color:#1a3d7a}
select{width:100%;padding:10px;font-size:15px;border:1px solid #cfd3d8;border-radius:10px;background:#fff}
</style></head><body>
<header><h1>${esc(name)}</h1>${place ? `<div class="d">${esc(place)}</div>` : ""}<div class="d" id="hd">Заявка към MOTAMO</div></header>
<div class="wrap" style="padding-bottom:0"><div class="card" style="text-align:center;padding:14px 12px;border:3px solid #b3121b"><div style="font-size:13px;color:#777">Заявката е за</div><div id="dd" style="font-size:26px;font-weight:900;color:#b3121b;line-height:1.15;margin:4px 0"></div><div id="td" style="font-size:13px;color:#777"></div><a href="#" id="sw" onclick="swap();return false" style="display:inline-block;margin-top:6px;color:#1565c0;font-size:13px">Не е за този ден? Смени</a></div></div>
<div class="wrap">
<div class="card"><table id="t"><thead><tr><th class="c1" style="text-align:left">артикул</th><th class="c5">заявка</th></tr></thead><tbody id="tb"><tr><td colspan="2" style="text-align:center;color:#888">Зареждам…</td></tr></tbody></table>
<div class="note">Синьото число е предложение по това, което обикновено получавате за този ден. Промени го с − и +.</div>
<div class="btns"><button onclick="other()">+ Друг артикул</button></div>
<div id="otherwrap" style="display:none;margin-top:8px"><select id="othersel"></select></div>
<button class="send" id="send" onclick="send()">Прати заявката</button>
<div class="msg" id="msg"></div></div>
<div class="note" style="text-align:center">Заявката се записва с час. Може да я промениш и пратиш пак — важи последната.</div>
</div>
<script>
var O=${JSON.stringify(key)},K=${JSON.stringify(tok)},D=null,SEL=null,ITEMS=[];
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function msg(t,c){var m=$('msg');m.className='msg '+(c||'info');m.textContent=t}
function api(b){return fetch('/api/cex-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({o:O,k:K},b))}).then(function(r){return r.json()})}
function dm(iso){var p=iso.split('-');return p[2]+'.'+p[1]}
function load(date){msg('Зареждам…','info');api({action:'shop_form_data',date:date}).then(function(j){if(!j.ok){msg('Грешка: '+(j.message||j.error||''),'err');return}D=j;SEL=j.for_date;ITEMS=j.items;render();$('msg').className='msg'}).catch(function(e){msg('Няма връзка. Опитай пак.','err')})}
function render(){var ex=D.existing&&D.existing.for_date===SEL?D.existing:null,exq={};if(ex){(ex.rows||[]).forEach(function(r){exq[r.id]=r.qty})}
$('dd').textContent=dowOf(SEL).toUpperCase()+' '+dm(SEL);$('td').textContent='днес е '+dowOf(D.today)+' '+dm(D.today)+(SEL===D.today?' — доставка днес сутринта':' — доставка утре сутринта');$('hd').textContent='Заявка към MOTAMO';
var b='';ITEMS.forEach(function(it){var v=ex?(exq[it.id]||0):it.suggest;var cls=ex?'':'sug';var nm=it.name.replace('НACHI','NACHI');var sub=/NACHI/.test(nm)?'8 хапки':(/^CET/.test(nm)?'16 хапки':'');
b+='<tr data-id="'+it.id+'"><td class="n">'+esc(nm)+(sub?'<small>'+sub+'</small>':'')+'</td>'
+'<td><div class="q"><button onclick="step(this,-1)">−</button><input type="number" inputmode="numeric" min="0" class="qty '+cls+'" value="'+v+'" oninput="this.className=\\'qty\\'"><button onclick="step(this,1)">+</button></div></td></tr>'});
$('tb').innerHTML=b||'<tr><td colspan="2" style="text-align:center;color:#888">Няма история за този магазин. Добави артикул от „+ Друг артикул".</td></tr>';
if(ex){msg('Вече има пратена заявка за '+dm(SEL)+' ('+hhmm(ex.sent_at)+'). Промени я и натисни „Прати" пак, ако трябва.','ok')}
var os='<option value="">— избери артикул —</option>';(D.other||[]).forEach(function(m){os+='<option value="'+m.id+'">'+esc(m.name.replace('НACHI','NACHI'))+'</option>'});$('othersel').innerHTML=os}
function swap(){var t=D.today,tm=addDays(t,1);var o=SEL===t?tm:t;if(confirm('Да сменя деня на '+dowOf(o)+' '+dm(o)+'?'))load(o)}
function addDays(iso,n){var d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function dowOf(iso){return ['неделя','понеделник','вторник','сряда','четвъртък','петък','събота'][new Date(iso+'T12:00:00Z').getUTCDay()]}
function hhmm(s){var d=new Date(s);return isNaN(d)?'':('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}
function pick(d){load(d)}
function step(btn,n){var i=btn.parentNode.querySelector('.qty');i.value=Math.max(0,(parseInt(i.value)||0)+n);i.className='qty'}
function other(){var w=$('otherwrap');w.style.display=w.style.display==='none'?'block':'none';$('othersel').onchange=function(){var id=+this.value;if(!id)return;var m=(D.other||[]).filter(function(x){return x.id===id})[0];if(!m)return;ITEMS.push({id:m.id,name:m.name,last:null,last_same:null,suggest:0,avg:null,weeks:0});D.other=D.other.filter(function(x){return x.id!==id});var keep={};document.querySelectorAll('#tb tr[data-id]').forEach(function(tr){keep[tr.getAttribute('data-id')]=tr.querySelector('.qty').value});render();Object.keys(keep).forEach(function(k){var tr=document.querySelector('tr[data-id="'+k+'"]');if(tr){tr.querySelector('.qty').value=keep[k];tr.querySelector('.qty').className='qty'}});w.style.display='none'}}
function send(){var rows=[],left={},n=0;document.querySelectorAll('#tb tr[data-id]').forEach(function(tr){var id=+tr.getAttribute('data-id'),q=parseInt(tr.querySelector('.qty').value)||0;rows.push({id:id,qty:q});if(q>0)n++});
if(!n){if(!confirm('Заявката е с 0 от всичко. Да я пратя така (няма да получите нищо за '+dm(SEL)+')?'))return}else if(!confirm('Пращаш заявка за '+dowOf(SEL).toUpperCase()+' '+dm(SEL)+' — '+n+' артикула. Потвърди.'))return;
$('send').disabled=true;msg('Пращам…','info');api({action:'shop_form_send',for_date:SEL,rows:rows,left:left}).then(function(j){$('send').disabled=false;if(j.ok){msg('✓ Пратено в '+hhmm(j.sent_at)+' за '+dm(j.for_date)+'. Благодарим!','ok');D.existing={for_date:j.for_date,rows:j.rows,left_qty:j.left,sent_at:j.sent_at}}else msg('Не е пратено: '+(j.message||j.error||''),'err')}).catch(function(){$('send').disabled=false;msg('Няма връзка. Опитай пак.','err')})}
load(null);
</script></body></html>`;
}


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
    if (String(a.account_alias || "").includes("CLTEST") || isTrialClient(a)) continue;
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
  const lf = lotFor(date);
  const lot = (typeof lotOverride === "string") ? lotOverride : lf.lot;
  const lotExp = lf.lot_exp;
  // Складът се чете ВЕДНЪЖ за целия пакет и се споделя между магазините: така
  // допроизведеното за един магазин се знае при следващия (не дублираме и не
  // четем склада по 20 пъти → по-малко заявки, не удряме timeout-а).
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
    // ★ S27 — ③ САМО отваря сметката. БЕЗ авто-допроизводство: при развалена партида (ревизия
    // насред деня) Barsy отказва въпреки бройките, а допроизводството трупаше стотици документи
    // (338 CET KAWA на хартия) и изяждаше 60-те секунди. Производството е работа само на
    // ② Артикули; тук при отказ казваме КАКВО липсва. Дублиран UUID = сметката вече я има.
    let r = null, lastRaw = "", existed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let thrown = false;
      try { r = await cexCall("Accounts_place", { account, orders, flag_close_account: 0 }, user, pass); }
      catch (e) { r = { ok: false, raw: String(e && e.message) }; thrown = true; }
      if (r.ok) break;
      lastRaw = String(r.raw || "");
      if (/[Дд]ублиране/.test(lastRaw) && /UUID/i.test(lastRaw)) { existed = true; break; }
      if (!thrown) break; // Barsy отговори с отказ → не повтаряме; повтаряме само мрежова засечка
    }
    let hint = "";
    if (!(r && r.ok) && !existed) {
      const m = lastRaw.match(/Артикул\s*"([^"]+)"[\s\S]*?(?:в партида|в склада|наличност)[\s\S]*?:\s*(-?[\d.,]+)/);
      if (m) {
        const art = resolve(m[1]);
        const ord = art && orders.find(o => String(o.article_id) === String(art.id));
        hint = "НЕДОСТИГ: " + m[1] + " — Barsy вижда " + m[2] + (ord ? ", сметката иска " + ord.amount : "") + ". Пусни ② Артикули за този магазин и пак ③. ";
      }
    }
    const accId = r && (typeof r.data === "number" ? r.data : (r.data && (r.data.account_id || r.data.id))) || null;
    out.push({ client: s.client, rep: s.rep, ok: !!(r && r.ok) || existed, existed: existed || undefined, account_id: accId, items: orders.length,
      error: (r && r.ok) || existed ? undefined : (hint + lastRaw).slice(0, 320) });
  }
  return out;
}
// Произвежда `qty` от `art` под партидата, като ПРЕДИ това допроизвежда всеки компонент
// (ролка/сет/заготовка), чиято реална наличност е под нужното — рекурсивно, най-дълбокото
// първо. Суровините не се произвеждат (липсата им се вижда от отказа на Barsy). `sm` е
// картата {id: наличност} и се обновява с произведеното; `log` събира „име +кол".
async function produceDeep(art, qty, lot, lotExp, user, pass, sm, log, depth) {
  if (depth > 6) return { ok: false, error: "рецептата е твърде дълбока" };
  for (const c of (art.components || [])) {
    const ca = c.id != null ? byId(c.id) : resolve(c.name);
    if (!ca || ca.cat === "Суровини") continue;
    if (!(ca.is_menu || ca.is_set || ca.cat === "Заготовки")) continue;
    const need = qty * (Number(c.qty) || 0);
    const cur = Number(sm[String(ca.id)]) || 0;
    if (need <= cur) continue;
    const amt = Math.ceil((need - cur) * 100) / 100 + (ca.cat === "Заготовки" ? 0.5 : 2); // малък буфер за надеждност
    const rr = await produceDeep(ca, amt, lot, lotExp, user, pass, sm, log, depth + 1);
    if (!rr || !rr.ok) {
      if (ca.cat === "Заготовки") continue; // заготовка без рецепта → best-effort, Barsy ще каже
      return { ok: false, error: "компонент „" + ca.name + "\" +" + amt + ": " + String(rr && rr.error || "неизвестно") };
    }
    sm[String(ca.id)] = cur + amt; log.push(ca.name + " +" + amt);
  }
  // Опитваме производството; ако Barsy откаже заради конкретен компонент без реален склад
  // („…Артикул „X" има текуща наличност „N""), допроизвеждаме ТОЧНО този компонент и
  // повтаряме. Това хваща случаите, в които `sm` е разминат с реалния склад на Barsy.
  let pr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    pr = await createProduction([{ article_id: art.id, article_name: art.name, amount: qty, lot: lot, lot_exp: lotExp }], { lot: lot, lot_exp: lotExp, description: "авто-допроизводство за сметка" }, user, pass);
    if (pr && pr.ok) break;
    const raw = String((pr && pr.error) || "");
    const mm = raw.match(/Артикул\s*[„"]?([^„""\n]+?)[""]?\s*има текуща наличност\s*[„"]?(-?[\d.,]+)/);
    if (!mm) break;
    const comp = resolve(mm[1].trim());
    const have = parseFloat(String(mm[2]).replace(/[^\d.,-]/g, "").replace(",", ".")) || 0;
    if (!comp || comp.cat === "Суровини") break; // суровина → не можем да произведем, спираме
    // колко от компонента иска рецептата за `qty` от art (ако е директен компонент)
    const cc = (art.components || []).find(c => String(c.id != null ? c.id : (resolve(c.name) || {}).id) === String(comp.id));
    const per = cc ? (Number(cc.qty) || 0) : 0;
    const compNeed = (per > 0 ? qty * per : qty); // ако не е директен компонент, поне толкова
    const compAmt = Math.max(0, Math.ceil(compNeed - have)) + (comp.cat === "Заготовки" ? 1 : 3); // малък буфер за надеждност
    if (compAmt <= 0) break;
    const rr = await produceDeep(comp, compAmt, lot, lotExp, user, pass, sm, log, depth + 1);
    if (!rr || !rr.ok) { if (comp.cat === "Заготовки") continue; return { ok: false, error: "компонент „" + comp.name + "\" +" + compAmt + ": " + String(rr && rr.error || "неизвестно") }; }
    sm[String(comp.id)] = (Number(sm[String(comp.id)]) || 0) + compAmt; log.push(comp.name + " +" + compAmt);
  }
  if (pr && pr.ok) sm[String(art.id)] = (Number(sm[String(art.id)]) || 0) + qty;
  return pr;
}
// Пълна нужда по ЦЯЛОТО дърво (директна продажба + консумация като компонент), {id: кол}
// за ВСЕКИ артикул (меню/заготовки/суровини). Ползва се от авто-допроизводството в ②.
function fullNeeds(orderMap) {
  const need = {};
  const add = (art, qty) => {
    if (!art || !(qty > 0)) return;
    need[art.id] = (need[art.id] || 0) + qty;
    for (const c of (art.components || [])) { const ca = c.id != null ? byId(c.id) : resolve(c.name); if (ca) add(ca, qty * (Number(c.qty) || 0)); }
  };
  for (const [k, v] of Object.entries(orderMap || {})) add(resolve(k), Number(v) || 0);
  return need;
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
// Всички ЗАГОТОВКИ, нужни за дневната заявка — по ЦЯЛОТО рецептурно дърво: мини
// през сетовете И ролките, за да хване и заготовките, които висят ДИРЕКТНО под
// сет (напр. „заг. ХОСОМАКИ ПУШЕНА СЬОМГА" под CET MORI), плюс вложените заготовки.
function orderToZag(orderMap) {
  const zag = {};
  const walk = (art, qty) => {
    if (!art) return;
    for (const c of (art.components || [])) {
      const ca = c.id != null ? byId(c.id) : resolve(c.name);
      if (!ca) continue;
      const need = qty * (Number(c.qty) || 0);
      if (ca.cat === "Заготовки") { zag[ca.name] = (zag[ca.name] || 0) + need; walk(ca, need); }
      else if (ca.is_set || ca.is_menu) walk(ca, need); // през сетове/ролки към вложените заготовки
    }
  };
  for (const [k, v] of Object.entries(orderMap || {})) walk(resolve(k), Number(v) || 0);
  return zag;
}
// Заготовки, които висят ДИРЕКТНО под сет (напр. заг. под CET MORI) — БЕЗ да слизаме
// през ролките (те са в rollProduce и минават през orderToZag(rollProduce)), иначе бихме
// броили заготовките в ролките два пъти. Влизаме само във вложени сетове и в самите заготовки.
function setDirectZag(setMap) {
  const zag = {};
  const walkZag = (art, qty) => {
    for (const c of (art.components || [])) {
      const ca = c.id != null ? byId(c.id) : resolve(c.name);
      if (ca && ca.cat === "Заготовки") { const n = qty * (Number(c.qty) || 0); zag[ca.name] = (zag[ca.name] || 0) + n; walkZag(ca, n); }
    }
  };
  const walkSet = (art, qty) => {
    if (!art) return;
    for (const c of (art.components || [])) {
      const ca = c.id != null ? byId(c.id) : resolve(c.name);
      if (!ca) continue;
      const need = qty * (Number(c.qty) || 0);
      if (ca.cat === "Заготовки") { zag[ca.name] = (zag[ca.name] || 0) + need; walkZag(ca, need); }
      else if (ca.is_set) walkSet(ca, need); // вложен сет → пак само директните му заготовки
      // is_menu (ролка) → ПРОПУСКАМЕ: ролките са в rollProduce
    }
  };
  for (const [k, v] of Object.entries(setMap || {})) walkSet(resolve(k), Number(v) || 0);
  return zag;
}
// Дълбочина на заготовка в рецептата (1 = само суровини вътре). Произвеждаме
// заготовките от НАЙ-ДЪЛБОКАТА към плитката, та вложената да е налична преди
// родителя (заг. Марината → заг. Сварен ориз → заг. ХОСОМАКИ).
function zagDepth(art, seen) {
  if (!art) return 1; seen = seen || new Set(); if (seen.has(art.id)) return 1;
  seen.add(art.id); let d = 1;
  for (const c of (art.components || [])) {
    const ca = c.id != null ? byId(c.id) : resolve(c.name);
    if (ca && ca.cat === "Заготовки") { const cd = 1 + zagDepth(ca, seen); if (cd > d) d = cd; }
  }
  seen.delete(art.id); return d;
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
// ★ S20 — ПРЕД-ПОЛЕТЕН план за „Изчисли": какви СУРОВИНИ да заредиш и какви
// ЗАГОТОВКИ да произведеш ПРЕДИ ①, за да не гръмне производството насред процеса.
// Огледало на ① (produce_plan): продаваните ролки/сетове/поке се произвеждат ПЪЛНО
// (не се нетират срещу стар готов склад — иначе заготовки/суровини се подценяват);
// оспорваните НАЧИ = directFull+setNeed − наличност; чисто-компонентните = недостиг;
// заготовките = нетно срещу наличност. После смятаме суровинната консумация на РЕАЛНО
// произвежданото и връщаме недостига (за зареждане). GPT-прегледано (нетна MRP; тук
// финалните продажби НЕ се нетират, за да съвпадне с ①).
function preflightPlan(agg, stock) {
  const st = id => { const q = stock[String(id)]; return (q == null || isNaN(q)) ? 0 : Number(q); };
  const shortfall = (need, id) => Math.max(0, Number(need) - st(id));
  // 1) сетове (пълно) + директни ролки/поке (пълно)
  const setProduce = {}, directRoll = {};
  for (const [name, qty] of Object.entries(agg)) {
    const a = resolve(name); if (!a || !(Number(qty) > 0)) continue;
    if (a.is_set) setProduce[name] = (setProduce[name] || 0) + Number(qty);
    else if (a.is_menu) directRoll[name] = (directRoll[name] || 0) + Number(qty);
  }
  // 2) ролки: оспорвани (продавани + компонент) ПЪЛНО спрямо наличност; иначе недостиг
  const setRolls = explodeToRolls(setProduce);
  const rollProduce = {};
  for (const name of new Set([...Object.keys(directRoll), ...Object.keys(setRolls)])) {
    const a = resolve(name); if (!a || !a.is_menu || a.is_set) continue;
    const directFull = directRoll[name] || 0, setNeed = setRolls[name] || 0;
    const contested = directFull > 0 && setNeed > 0;
    const p = contested ? round(Math.max(0, directFull + setNeed - st(a.id)))
                        : round(directFull + shortfall(setNeed, a.id));
    if (p > 0) rollProduce[name] = p;
  }
  // 3) заготовки: нужда от реалното производство (ролки + директни под сет), нетно
  const zagNeed = {};
  for (const src of [orderToZag(rollProduce), setDirectZag(setProduce)])
    for (const [k, v] of Object.entries(src)) zagNeed[k] = (zagNeed[k] || 0) + v;
  const zagProduce = {};
  for (const [name, qty] of Object.entries(zagNeed)) { const a = resolve(name); if (a && Number(qty) > 0) { const p = round(shortfall(Number(qty), a.id)); if (p > 0) zagProduce[name] = p; } }
  // 4) суровинна консумация на ВСИЧКО реално произвеждано (директните суровини на всеки
  //    произвеждан артикул; вложените заготовки/ролки се броят при своето производство).
  const rawUse = {};
  const addDirectRaw = (art, q) => {
    if (!art || !(q > 0)) return;
    for (const c of (art.components || [])) {
      const ca = c.id != null ? byId(c.id) : resolve(c.name);
      if (ca && (ca.cat === "Суровини")) rawUse[ca.id] = (rawUse[ca.id] || 0) + q * (Number(c.qty) || 0);
    }
  };
  for (const [name, q] of Object.entries(setProduce)) addDirectRaw(resolve(name), q);
  for (const [name, q] of Object.entries(rollProduce)) addDirectRaw(resolve(name), q);
  for (const [name, q] of Object.entries(zagProduce)) addDirectRaw(resolve(name), q);
  const EXCLUDE_RAW = new Set(["Опаковка", "Етикет Опаковка"]);
  const loadRaw = {};
  for (const [id, use] of Object.entries(rawUse)) {
    const a = byId(id); if (!a || EXCLUDE_RAW.has(a.name)) continue;
    const deficit = round(use - st(id));
    if (deficit > 0.0005) loadRaw[id] = deficit;
  }
  return { zagProduce, rollProduce, setProduce, loadRaw };
}
// ★ S20 — ЕДИННА нетна MRP (двунивова), БЕЗ буфер, идемпотентна. Ползва се и от ① и от „Изчисли".
// `total` = обща наличност {id:кол}; `underL` = произведено под партида L {id:кол} (за продажбата
// под L + идемпотентност при повторно ①). Правило (GPT-прегледано):
//  • ПРОДАВАНИ (ролки/сетове от заявката) → нужда ПОД партида L: произведи max(0, поръчка − underL).
//  • КОМПОНЕНТИ/ЗАГОТОВКИ → нетно спрямо ОБЩАТА наличност.
//  • СУРОВИНИ → недостиг = зареди (не се произвеждат).
// Повторно ① с пресни данни → нищо (не дублира → не трупа излишък). Без никакъв буфер.
const RAWCATS = new Set(["Суровини", "Консумативи", "Некатегоризирани"]);
// ★ S24 — ЕДИН план за деня, общ за ①/② (produce_plan) И панела на „Изчисли" → панелът
// показва точно каквото ①/② ще направят (преди панелът ползваше брутния склад sm, а ①/② —
// свободното = склад − запазено от отворените сметки → разминаваха се).
async function computeDayPlan(shopsIn, prodDate, lot, razosDate, withOthers, user, pass) {
  // ★ S27 — ЕДНА ФОРМУЛА, същата като на Barsy (razosDate/withOthers вече не се ползват):
  //   свободно под партидата = реално + запазено (запазеното е с минус; само за ТАЗИ партида)
  //   ② произвежда = нуждата на тикнатите БЕЗ сметка − свободното  (+ дупката, ако свободното е < 0)
  // Чуждите сметки (на нетикнати магазини и забравени от вчера) не се смятат отделно: тези от
  // същата партида вече са в „запазено", а тези от друга партида не я засягат. Затворените сметки
  // вече са извадени от „реално". Повторно ② → нищо (реалното е пораснало); добавен магазин → разликата.
  // 1) кои тикнати вече имат сметка за тази дата (записва го ③) — те вече са в „запазено".
  const day = await dayGet(prodDate);
  const accs = (day.state && day.state.accounts) || {};
  // Два независими източника: записът на сървъра (③ го пише) И account_id от решетката в браузъра.
  const accIdOf = sh => { const e = accs[dayKey(sh)]; return (e && e.account_id) || sh.account_id || null; };
  const hasAcc = new Set(shopsIn.filter(sh => accs[dayKey(sh)] || sh.account_id).map(dayKey));
  const withId = shopsIn.filter(sh => hasAcc.has(dayKey(sh)) && accIdOf(sh));
  if (withId.length) {
    // анулирана в Barsy сметка не държи нищо → магазинът пак има нужда
    const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 600 }, user, pass);
    let all = list.data || []; if (!Array.isArray(all)) all = Object.values(all);
    if (!list.ok || !all.length) throw new Error("сметките не се прочетоха от Barsy");
    const byAcc = {}; for (const x of all) byAcc[String(x.account_id)] = x;
    for (const sh of withId) { const x = byAcc[String(accIdOf(sh))]; if (x && String(x.is_anulate != null ? x.is_anulate : (x.anulate_flag != null ? x.anulate_flag : "0")) === "1") hasAcc.delete(dayKey(sh)); }
  }
  const needShops = shopsIn.filter(sh => !hasAcc.has(dayKey(sh)));
  const agg = Object.assign({}, compute(needShops).agg);
  // 2) склад (Основен) и партидите — и двете ЗАДЪЛЖИТЕЛНИ; при неуспех спираме, не гадаем.
  const sm = await stockMap(user, pass);
  const all = await lotRows({}, user, pass);
  const realL = {}, resL = {}, freeL = {}, resAll = {}, staleMap = {}, oldHeld = {};
  const today = sofiaToday(), staleBefore = prodDate < today ? prodDate : today; // вечерта за утре: днешните още отворени НЕ са „стари"
  const lotCur = lotIso(lot);
  for (const x of all) {
    const id = String(x.article_id), real = Number(x.amount_real) || 0, rsv = Number(x.amount_reserved) || 0;
    resAll[id] = (resAll[id] || 0) + rsv;
    // по-стара партида с бройки, запазени за отворена сметка — производство на СЕТ ги изяжда първи (най-старата партида)
    if (lotCur && rsv < 0 && real > 0) { const iso = lotIso(x.lot_value); if (iso && iso < lotCur) (oldHeld[id] = oldHeld[id] || []).push({ lot: String(x.lot_value), held: round(-rsv) }); }
    if (lot && String(x.lot_value) === String(lot)) { realL[id] = (realL[id] || 0) + real; resL[id] = (resL[id] || 0) + rsv; freeL[id] = (freeL[id] || 0) + real + rsv; }
    else if (rsv < 0) { const iso = lotIso(x.lot_value); if (iso && iso < staleBefore) { const k = String(x.lot_value || "без партида"); staleMap[k] = (staleMap[k] || 0) + 1; } }
  }
  // свободно за КОМПОНЕНТИТЕ (НАЧИ за сетовете, заготовки, суровини) = склад − запазено по всички партиди
  const freeStock = {};
  for (const k in sm) freeStock[k] = (Number(sm[k]) || 0) + (resAll[k] || 0);
  for (const k in resAll) if (!(k in freeStock)) freeStock[k] = resAll[k];
  // ★ S28 — СКРИТ МИНУС под стара партида (ред с отрицателно „реално" не идва в списъка): общото в склада
  // е по-малко от видимото под L, а Barsy отказва сметката по ОБЩОТО. Свободното под L не може да е повече
  // от свободното общо → дупката се произвежда заедно с нуждата (02.10: RAY −13, AMO −3 под L.01.10).
  const hidden = {};
  if (lot) for (const id in freeL) { if (sm[id] == null || isNaN(sm[id])) continue; const tot = freeStock[id]; if (tot < freeL[id] - 1e-9) { hidden[id] = round(freeL[id] - tot); freeL[id] = tot; } }
  const plan = dayPlan(agg, freeStock, lot ? freeL : {});
  // 3) таблицата „какво вижда Barsy" — за собственика (Telegram) и за проверка
  const need = {}; for (const [n, q] of Object.entries(agg)) { const art = resolve(n); if (art && (art.is_menu || art.is_set)) need[String(art.id)] = (need[String(art.id)] || 0) + (Number(q) || 0); }
  const ids = new Set([...Object.keys(need), ...Object.keys(realL)]);
  const table = [];
  for (const id of ids) { const art = byId(id); if (!art || !(art.is_menu || art.is_set)) continue;
    table.push({ id: Number(id), name: art.name, is_set: !!art.is_set, real: round(realL[id] || 0), reserved: round(-(resL[id] || 0)), free: round(freeL[id] || 0), need: round(need[id] || 0), produce: round(plan.produce[id] || 0) }); }
  table.sort((x, y) => (y.is_set - x.is_set) || x.name.localeCompare(y.name));
  // 4) липсваща суровина, която я има в склад „Точка" (заредена/прехвърлена там по грешка)
  const inPoint = {};
  if (Object.keys(plan.loadRaw).length) {
    try { const sm2 = await stockMap(user, pass, 2); for (const id of Object.keys(plan.loadRaw)) { const q = Number(sm2[String(id)]) || 0; if (q > 0) inPoint[id] = round(q); } } catch (e) {}
  }
  const stale = Object.entries(staleMap).map(([l, n]) => ({ lot: l, articles: n }));
  return { plan, sm, underLot: realL, underRel: true, freeStock, others: [], table, stale, oldHeld, hidden, inPoint, withAccount: shopsIn.length - needShops.length, needShops: needShops.length };
}
function dayPlan(agg, total, underL) {
  const aT = {}; for (const k in (total || {})) aT[k] = Number(total[k]) || 0;
  const aL = {}; for (const k in (underL || {})) aL[k] = Number(underL[k]) || 0;
  // МИНУС наличност (счетоводен артефакт от анулирани буфери / незаписано зареждане) се
  // третира като 0: произвеждаме ТОЧНО нуждата за деня, БЕЗ да „запълваме" дупката → без
  // свръхпроизводство. Цехът е прясно производство всеки ден (Barsy позволява произв. под нула).
  const gT = id => Math.max(0, aT[String(id)] || 0), gL = id => Math.max(0, aL[String(id)] || 0);
  const produce = {}, loadRaw = {}, seen = new Set();
  function consumeTotal(art, qty) {
    if (!art || qty <= 1e-9) return;
    const id = String(art.id);
    // ★ S27 — ЗАГОТОВКА на минус е ИСТИНСКА липса: поке/ролки са записани без нея (② без ①) и
    // суровините ѝ никога не са изписани. Щом заготовката е нужна днес, произвеждаме и дупката.
    // За суровини и ролки минусът остава 0 (както досега) — там не „запълваме".
    const rawT = aT[id] || 0, zagHole = (art.cat === "Заготовки" && rawT < -1e-9) ? -rawT : 0;
    const have = gT(id), use = Math.min(have, qty); aT[id] = have - use;
    const deficit = qty - use + zagHole; if (deficit <= 1e-9) return;
    if (RAWCATS.has(art.cat)) { loadRaw[id] = (loadRaw[id] || 0) + deficit; return; }
    if (seen.has(id)) return; seen.add(id);
    produce[id] = (produce[id] || 0) + deficit;
    for (const c of (art.components || [])) { const ca = c.id != null ? byId(c.id) : resolve(c.name); if (ca) consumeTotal(ca, deficit * (Number(c.qty) || 0)); }
    seen.delete(id);
  }
  function sellLine(art, qty) {
    const id = String(art.id);
    // ★ S27 — Barsy пуска сметка само ако (под партидата − в отворени сметки) ≥ бройката. Когато
    // свободното под L е ОТРИЦАТЕЛНО (отворените сметки държат повече от наличното — след ревизия),
    // дупката се произвежда заедно с нуждата; иначе „25 в партидата, искате 2" отказва вечно.
    const rawL = aL[id] || 0, hole = Math.max(0, -rawL);
    const haveL = Math.max(0, rawL), useL = Math.min(haveL, qty); aL[id] = haveL - useL;
    aT[id] = Math.max(0, gT(id) - useL); // продадените под-L бройки напускат и общото
    const np = qty - useL + hole; if (np <= 1e-9) return;
    produce[id] = (produce[id] || 0) + np;
    for (const c of (art.components || [])) { const ca = c.id != null ? byId(c.id) : resolve(c.name); if (ca) consumeTotal(ca, np * (Number(c.qty) || 0)); }
  }
  for (const [name, qty] of Object.entries(agg || {})) {
    const art = resolve(name), q = Number(qty) || 0; if (!art || q <= 0) continue;
    if (art.is_menu || art.is_set) sellLine(art, q); else consumeTotal(art, q);
  }
  // ★ S27 — остана ли отрицателно свободно под партидата (отворени сметки държат повече от
  // наличното), произвеждаме дупката: иначе тези сметки не могат да се приключат.
  for (const id in aL) { if (aL[id] < -1e-9) { const art = byId(id); if (art && (art.is_menu || art.is_set)) sellLine(art, 0); } }
  return { produce, loadRaw };
}
const round = n => Math.round(n * 1000) / 1000;
function sortObj(o, d) { const out = {}; Object.keys(o || {}).sort().forEach(k => out[k] = Math.round(o[k] * 10 ** d) / 10 ** d); return out; }
const sofiaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());
const sofiaTime = () => new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit" }).format(new Date());
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function compute(shops) {
  const agg = {};
  for (const s of shops) for (const [k, v] of Object.entries(s.order || {})) agg[k] = (agg[k] || 0) + (Number(v) || 0);
  return { agg, rolls: explodeToRolls(agg), zag: orderToZag(agg) };
}
// Партида/срок: партида = L.<деня на производство>, срок = +3 дни (правилото на цеха).
function isoToDDMMYYYY(iso) { const p = String(iso).split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso; }
function isoPlusDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lotFor(prodDateIso) { return { lot: "L." + isoToDDMMYYYY(prodDateIso), lot_exp: isoToDDMMYYYY(isoPlusDays(prodDateIso, 3)) }; }

// ── HTML: екран за цеха (само четене) ────────────────────────────────────────
// ★ S31 — 🏠 „Начало" на всяка страница на собственика → хъбът „Цех и точка" (/api/transfer?view=hub).
// Само при силен ключ (OWNER_TOKEN не бива да се показва на персонала с четящия ключ); ?nohome=1 го маха (iframe в Репорти).
function withHome(q, html) {
  const own = process.env.OWNER_TOKEN, k = q && q.k;
  const strong = [process.env.RECONCILE_TOKEN, process.env.PAY_HMAC_SECRET, process.env.PREVIEW_TOKEN].filter(Boolean);
  if (!own || !k || !strong.includes(k) || typeof html !== "string" || (q && q.nohome === "1")) return html;
  const btn = `<a href="/api/transfer?view=hub&k=${encodeURIComponent(own)}" target="_top" style="position:fixed;top:8px;right:10px;z-index:9999;background:#fff;color:#14171a;border:1px solid #ddd;border-radius:999px;padding:7px 12px;font:14px system-ui,sans-serif;font-weight:700;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.18)">🏠 Начало</a>`;
  return html.replace(/<body([^>]*)>/, m => m + btn);
}

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
// Вътрешен хъб: Цех + Точка дашбордите в таб-ове (iframe, същия домейн, токен вътре).
function reportsHubPage(k) {
  const ek = encodeURIComponent(k || "");
  const cex = `/api/cex-plan?view=dashboard&k=${ek}&nohome=1`;
  const shop = `/api/shop-dash?view=dashboard&k=${ek}&nohome=1`;
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO · Репорти</title><style>
:root{color-scheme:light}*{box-sizing:border-box}html,body{height:100%}
body{margin:0;font:15px system-ui,Segoe UI,Roboto,sans-serif;background:#eef0f3;color:#14171a;display:flex;flex-direction:column}
header{background:linear-gradient(135deg,#c8151f,#7a0c12);color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;box-shadow:0 2px 12px rgba(122,12,18,.3);flex:0 0 auto}
header .brand{font-size:17px;font-weight:800;letter-spacing:.3px;display:flex;align-items:center;gap:9px}
header .brand img{width:30px;height:30px;border-radius:7px;background:#fff;padding:2px}
.tabs{display:flex;gap:10px}
.tabs button{font:17px system-ui;font-weight:800;padding:11px 26px;border:2px solid rgba(255,255,255,.65);border-radius:11px;cursor:pointer;background:rgba(255,255,255,.12);color:#fff;letter-spacing:.3px;transition:all .12s}
.tabs button:hover{background:rgba(255,255,255,.28)}
.tabs button.on{background:#fff;color:#b3121b;border-color:#fff;box-shadow:0 3px 10px rgba(0,0,0,.28);transform:translateY(-1px)}
.frames{position:relative;flex:1 1 auto;min-height:0}
.frames iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#eef0f3}
.frames iframe[hidden]{display:none}
</style></head><body>
<header>
  <div class="brand"><img src="https://motamo.bg/icons/icon-192.png" alt="" onerror="this.style.display='none'">MOTAMO · Репорти</div>
  <div class="tabs">
    <button id="tCex" class="on" onclick="show('cex')">🍣 Цех</button>
    <button id="tShop" onclick="show('shop')">🍱 Точка (Каравелов)</button>
    <button id="tRoutes" onclick="show('routes')">🚚 Маршрути</button>
  </div>
</header>
<div class="frames">
  <iframe id="fCex" src="${esc(cex)}" title="Цех"></iframe>
  <iframe id="fShop" data-src="${esc(shop)}" title="Точка" hidden></iframe>
  <iframe id="fRoutes" data-src="/api/cex-plan?view=routes&k=${ek}&nohome=1" title="Маршрути" hidden></iframe>
</div>
<script>
var F={cex:'fCex',shop:'fShop',routes:'fRoutes'},T={cex:'tCex',shop:'tShop',routes:'tRoutes'};
function show(w){if(!F[w])w='cex';Object.keys(F).forEach(function(k){var f=document.getElementById(F[k]);
  if(k===w&&f.getAttribute('data-src')){f.src=f.getAttribute('data-src');f.removeAttribute('data-src')}
  f.hidden=(k!==w);document.getElementById(T[k]).className=(k===w)?'on':''});
  try{location.hash=w}catch(e){}}
if(location.hash==='#shop')show('shop');if(location.hash==='#routes')show('routes');
</script>
</body></html>`;
}

// ── HTML: МАРШРУТИ НА ШОФЬОРА (собственикът влачи обектите в маршрути 1–5; ботът ползва записаното) ──
function routesPage(k, date) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOTAMO · Маршрути</title><style>
*{box-sizing:border-box}body{margin:0;font:15px system-ui,Segoe UI,Roboto,sans-serif;background:#eef0f3;color:#14171a}
.wrap{max-width:1100px;margin:0 auto;padding:14px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#666;font-size:14px;margin:0 0 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input[type=date]{font:15px system-ui;padding:5px 8px;border:1px solid #ccc;border-radius:8px}
.cols{display:grid;grid-template-columns:1fr 1.3fr;gap:14px;align-items:start}
@media (max-width:700px){.cols{grid-template-columns:1fr}}
.col h3{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#777;margin:10px 0 6px}
.pool,.route{background:#fff;border-radius:14px;padding:10px;margin:0 0 12px;box-shadow:0 2px 8px rgba(20,23,26,.08);min-height:54px}
.route{border:2px dashed transparent;transition:border-color .12s,background .12s}
.route.over,.pool.over{border-color:#c8151f;background:#fff5f5}
.route h2{font-size:16px;margin:0 0 6px;display:flex;gap:8px;align-items:center}
.route h2 .num{background:#14171a;color:#fff;border-radius:8px;padding:2px 9px;font-size:14px}
.route h2 input{font:15px system-ui;font-weight:700;border:1px solid #e3e3e3;border-radius:8px;padding:5px 8px;flex:1;min-width:0}
.route h2 .cnt{color:#888;font-weight:400;font-size:13px}
.route h2 .x{border:0;background:none;color:#aaa;font-size:18px;cursor:pointer;padding:0 4px}
.route h2 .x:hover{color:#c8151f}
.city{font-weight:800;font-size:14px;margin:8px 0 4px;color:#333}
.item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #e6e6e6;border-radius:10px;margin:4px 0;background:#fff;cursor:grab;user-select:none}
.item:active{cursor:grabbing}.item.drag{opacity:.4}
.item .h{color:#bbb;font-size:16px}.item .nm{flex:1;min-width:0;font-size:14px}.item .nm small{display:block;color:#999;font-size:11.5px}
.item.sbs{border-left:4px solid #c8151f}.item.nw{border-left:4px solid #e0a800;background:#fffbea}
.hint{color:#999;font-size:13px;text-align:center;padding:10px}
.bar{position:sticky;bottom:0;background:#fff;padding:10px 12px;display:flex;gap:8px;box-shadow:0 -2px 10px rgba(0,0,0,.08);border-radius:12px;margin-top:6px;flex-wrap:wrap}
.bar button{font:15px system-ui;font-weight:800;padding:11px 14px;border-radius:10px;border:0;cursor:pointer}
.bar .save{background:#c8151f;color:#fff;flex:1}.bar .auto,.bar .add,.bar .clear{background:#eee}
.bar button[disabled]{opacity:.45;cursor:not-allowed}
.msg{font-size:14px;color:#0a6b2e;margin:6px 0 0}.msg.err{color:#b3121b}.msg.warn{color:#b06a00}
</style></head><body><div class="wrap">
<h1>🚚 Маршрути на шофьора</h1>
<p class="sub">Обектите със <b>стокова</b> за <input type="date" id="date" value="${esc(date)}"> <span id="state"></span></p>
<div class="cols">
  <div class="col"><h3>Обекти (влачи ги вдясно)</h3><div class="pool" id="pool" data-r="-1"></div></div>
  <div class="col"><h3>Маршрути</h3><div id="routes"></div>
    <div class="bar"><button class="add" id="addBtn" onclick="addRoute()">+ Маршрут</button><button class="auto" onclick="applyAuto()">Автоматично</button><button class="clear" onclick="clearAll()">Изчисти</button><button class="save" onclick="save()">Запиши за шофьора</button></div>
    <p class="msg" id="msg"></p>
  </div>
</div>
</div>
<script>
var K=${JSON.stringify(k || "")},API='/api/cex-plan',MAXR=5,ST={stops:[],routes:[],auto:[]},DRAG=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function post(b){b.token=K;return fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()})}
function cityOf(z){return z==='Сливен'||z==='Хасково'?z:'Стара Загора'}
function isNew(k){var s=stop(k);return !!(s&&s.isNew)}
function stop(k){return ST.stops.filter(function(s){return s.key===k})[0]}
function load(){var d=document.getElementById('date').value;document.getElementById('state').textContent='зарежда…';
  post({action:'route_plan',date:d}).then(function(j){if(!j.ok){document.getElementById('state').textContent='грешка: '+(j.error||'');return}
    ST.stops=j.stops;ST.auto=j.auto;
    var src=(j.saved&&j.saved.length)?j.saved:[];
    ST.routes=src.map(function(r){return {name:r.name,keys:r.keys.filter(function(k){return !!stop(k)})}}).slice(0,MAXR);
    if(!ST.routes.length)ST.routes=[{name:'Маршрут 1',keys:[]}];
    document.getElementById('state').textContent=ST.stops.length+' обекта · '+(src.length?'записан план ('+new Date(j.saved_at).toLocaleTimeString('bg-BG',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Sofia'})+')':'няма записан план — влачи или натисни „Автоматично“');
    render()})}
function placed(){var m={};ST.routes.forEach(function(r){r.keys.forEach(function(k){m[k]=1})});return m}
function itemHtml(k){var s=stop(k);if(!s)return '';return '<div class="item'+(/^СиБиЕс/.test(s.zone)?' sbs':'')+(s.isNew?' nw':'')+'" draggable="true" data-k="'+esc(k)+'"><span class="h">⋮⋮</span><span class="nm">'+esc(s.name)+'<small>'+(s.isNew?'🆕 нов обект — без адрес за навигация (кажи на Claude да го добави)':esc(s.zone))+'</small></span></div>'}
function render(){var p=placed();var pool='';['Стара Загора','Сливен','Хасково'].forEach(function(c){var all=ST.stops.filter(function(s){return cityOf(s.zone)===c}),ks=all.filter(function(s){return !p[s.key]});
    pool+='<div class="city">'+c+' <span style="color:#999;font-weight:400">('+(all.length?(ks.length+' от '+all.length):'няма стокова днес')+')</span></div>'+(ks.length?ks.map(function(s){return itemHtml(s.key)}).join(''):(all.length?'<div class="hint" style="padding:4px 10px;text-align:left">всички са в маршрути ✓</div>':''))});
  if(!ST.stops.length)pool='<div class="hint">Няма издадени стокови за този ден.</div>';
  document.getElementById('pool').innerHTML=pool;
  var h='';ST.routes.forEach(function(r,ri){h+='<div class="route" data-r="'+ri+'"><h2><span class="num">'+(ri+1)+'</span><input value="'+esc(r.name)+'" onchange="ST.routes['+ri+'].name=this.value"><span class="cnt">'+r.keys.length+' об.</span><button class="x" title="Махни маршрута" onclick="delRoute('+ri+')">×</button></h2>'+(r.keys.length?r.keys.map(itemHtml).join(''):'<div class="hint">пусни обекти тук</div>')+'</div>'});
  document.getElementById('routes').innerHTML=h;
  document.getElementById('addBtn').disabled=ST.routes.length>=MAXR;
  wire()}
function wire(){document.querySelectorAll('.item').forEach(function(el){
    el.addEventListener('dragstart',function(e){DRAG=el.getAttribute('data-k');el.classList.add('drag');try{e.dataTransfer.setData('text/plain',DRAG);e.dataTransfer.effectAllowed='move'}catch(x){}});
    el.addEventListener('dragend',function(){el.classList.remove('drag');document.querySelectorAll('.over').forEach(function(z){z.classList.remove('over')})})});
  document.querySelectorAll('.route,.pool').forEach(function(z){
    z.addEventListener('dragover',function(e){e.preventDefault();z.classList.add('over')});
    z.addEventListener('dragleave',function(){z.classList.remove('over')});
    z.addEventListener('drop',function(e){e.preventDefault();z.classList.remove('over');var k=DRAG||(e.dataTransfer&&e.dataTransfer.getData('text/plain'));if(!k)return;
      var ri=Number(z.getAttribute('data-r'));var before=e.target.closest?e.target.closest('.item'):null;var bk=before?before.getAttribute('data-k'):null;
      ST.routes.forEach(function(r){r.keys=r.keys.filter(function(x){return x!==k})});
      if(ri>=0){var a=ST.routes[ri].keys;var i=bk?a.indexOf(bk):-1;if(i>=0)a.splice(i,0,k);else a.push(k)}
      DRAG=null;render()})})}
function addRoute(){if(ST.routes.length>=MAXR)return;ST.routes.push({name:'Маршрут '+(ST.routes.length+1),keys:[]});render()}
function delRoute(ri){if(ST.routes.length<=1){ST.routes[0].keys=[];render();return}ST.routes.splice(ri,1);render()}
function clearAll(){ST.routes=[{name:'Маршрут 1',keys:[]}];render()}
function applyAuto(){ST.routes=ST.auto.slice(0,MAXR).map(function(r){return {name:r.name,keys:r.keys.slice()}});if(!ST.routes.length)ST.routes=[{name:'Маршрут 1',keys:[]}];render()}
function save(){var m=document.getElementById('msg');var p=placed();var left=ST.stops.filter(function(s){return !p[s.key]}).length;
  var routes=ST.routes.filter(function(r){return r.keys.length}).map(function(r){var labels={};r.keys.forEach(function(k){if(isNew(k))labels[k]=stop(k).name});return {name:r.name,keys:r.keys,labels:labels}});
  if(!routes.length){m.className='msg err';m.textContent='Няма обекти в маршрутите.';return}
  m.className='msg';m.textContent='записва…';
  post({action:'route_plan_save',date:document.getElementById('date').value,routes:routes}).then(function(j){
    if(j.ok){m.className=left?'msg warn':'msg';m.textContent='✅ Записано — шофьорът ще види тези маршрути при „Тръгвам“.'+(left?' ⚠️ '+left+' обекта остават извън маршрутите (няма да ги види).':'');load()}else{m.className='msg err';m.textContent='Грешка: '+(j.error||'')}})}
document.getElementById('date').addEventListener('change',load);load();
</script></body></html>`;
}

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
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
@keyframes popIn{0%{opacity:0;transform:scale(.96)}60%{opacity:1;transform:scale(1.015)}100%{transform:scale(1)}}
@keyframes sheen{to{background-position:200% 0}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
body{font:15px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:radial-gradient(1200px 600px at 80% -5%,#f3f6fb,#e7ebf1 55%,#e2e6ec);color:#14171a;min-height:100vh}
header{background:linear-gradient(135deg,#3b4a5e,#1f2937 70%);background-size:200% 100%;color:#fff;padding:16px 20px;position:sticky;top:0;z-index:5;box-shadow:0 4px 18px rgba(16,20,26,.28);animation:sheen 18s linear infinite alternate}
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
table.cxa th.v{writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap;font-size:12px;padding:6px 4px}table.cxa td{white-space:nowrap}table.cxa td.n{position:sticky;left:0;background:#fff}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{--ac:#cfd4da;position:relative;overflow:hidden;background:linear-gradient(180deg,#fff,#fbfcfe);border-radius:14px;padding:15px 16px;box-shadow:0 3px 10px rgba(20,23,26,.07),0 1px 2px rgba(20,23,26,.05);border-left:5px solid var(--ac);transition:transform .18s cubic-bezier(.2,.7,.3,1),box-shadow .18s;animation:fadeUp .5s both}
.kpi::after{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--ac);opacity:.85}
.kpi:hover{transform:translateY(-4px) scale(1.01);box-shadow:0 10px 24px rgba(20,23,26,.14)}
.kpi:nth-child(1){animation-delay:.02s}.kpi:nth-child(2){animation-delay:.07s}.kpi:nth-child(3){animation-delay:.12s}.kpi:nth-child(4){animation-delay:.17s}.kpi:nth-child(5){animation-delay:.22s}.kpi:nth-child(6){animation-delay:.27s}.kpi:nth-child(7){animation-delay:.32s}.kpi:nth-child(8){animation-delay:.37s}.kpi:nth-child(9){animation-delay:.42s}
.kpi .l{font-size:12px;color:#7a8087;text-transform:uppercase;letter-spacing:.4px}
.kpi .v{font-size:26px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums;line-height:1.1}
.kpi.turn{--ac:#1f5b59}.kpi.turn .v{color:#1f5b59}
.kpi.inv{--ac:#8a6608}.kpi.inv .v{color:#8a6608}
.kpi.gap{--ac:#b3121b}.kpi.gap .v{color:#b3121b}
.kpi.cost{--ac:#b06a00}.kpi.cost .v{color:#b06a00}
.kpi.exp{--ac:#7a4b8a}.kpi.exp .v{color:#7a4b8a}
.kpi.res{--ac:#0a6b2e}.kpi.res .v{color:#0a6b2e}
.kpi.load{--ac:#2b6ca3}.kpi.load .v{color:#2b6ca3}
.kpi.stock{--ac:#0d7a6f}.kpi.stock .v{color:#0d7a6f}
.kpi .s{font-size:11px;color:#9aa0a6;margin-top:2px}
.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 3px 12px rgba(20,23,26,.08);animation:fadeUp .55s both;transition:box-shadow .2s,transform .2s}
.card:hover{box-shadow:0 10px 28px rgba(20,23,26,.12)}
.wrap>.card:nth-of-type(1){animation-delay:.12s}.wrap>.card:nth-of-type(2){animation-delay:.18s}.wrap>.card:nth-of-type(3){animation-delay:.24s}.wrap>.card:nth-of-type(4){animation-delay:.3s}.wrap>.card:nth-of-type(n+5){animation-delay:.36s}
.card>h2{margin:0;font-size:15px;font-weight:800;color:#fff;background:linear-gradient(135deg,#3b4a5e,#2a3340);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px}
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
.kpi.clk{cursor:pointer}.kpi.clk .l::after{content:"▸";float:right;opacity:.4;font-size:11px}
.kpi.sel{outline:2px solid var(--ac);outline-offset:1px}
#detail{background:#fff;border-radius:14px;box-shadow:0 3px 12px rgba(20,23,26,.08);overflow:hidden;display:none}
#detail.show{display:block;animation:popIn .25s both}
#detail h3{margin:0;font-size:14px;font-weight:800;color:#fff;background:linear-gradient(135deg,#3b4a5e,#2a3340);padding:10px 16px;display:flex;justify-content:space-between}
#detail .body{padding:8px 16px 12px}#detail .drow{padding:7px 0;border-top:1px solid #f1f2f4;font-variant-numeric:tabular-nums}#detail .drow:first-child{border-top:0}
.wf{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:620px){.wf{grid-template-columns:1fr}}
.wf label{font-size:12px;color:#555;font-weight:700;display:flex;justify-content:space-between}.wf label b{color:#1f2937}
.wf input[type=range]{width:100%;accent-color:#1f5b59;margin-top:4px}
.wf .out{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
.wf .out .b{background:#f5f8f7;border-radius:12px;padding:12px 14px;border-left:4px solid #0a6b2e}
.wf .out .b .l{font-size:11px;color:#7a8087;text-transform:uppercase}.wf .out .b .v{font-size:23px;font-weight:800;font-variant-numeric:tabular-nums}
.wf .mini{font-size:12px;color:#7a8087;margin-top:8px}.wf .reset{font:12px system-ui;font-weight:700;border:0;border-radius:7px;padding:5px 12px;background:#e7eaef;color:#374151;cursor:pointer;margin-top:10px}
tr.hl td{background:#eafaf4!important}
@media(max-width:520px){th,td{padding:8px 10px;font-size:13px}.kpi .v{font-size:22px}}
</style></head><body>
<header><h1>🍣 Цех · Дашборд</h1><div class="d">${err ? "грешка" : esc(data.from) + " – " + esc(data.to) + " · " + (data.accounts || 0) + " сметки · оборот без ДДС"}</div></header>
<div class="wrap">
<form class="period" method="get">
  <input type="hidden" name="view" value="dashboard">${k ? `<input type="hidden" name="k" value="${esc(k)}">` : ""}
  <div><label>от</label><input type="date" name="from" lang="bg-BG" value="${esc((data && data.from) || "")}"></div>
  <div><label>до</label><input type="date" name="to" lang="bg-BG" value="${esc((data && data.to) || "")}"></div>
  <div><label>разходи € (ръчно)</label><input type="number" step="0.01" name="exp" value="" placeholder="авто ${err ? "0" : bg(data.expenses || 0)}" style="width:110px"></div>
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
  <div class="kpi gap"><div class="l">Без фактура</div><div class="v">${bg(gapNeto)} €</div><div class="s">ИТТ изкл. · разносът в края на месеца се фактурира в началото на следващия</div></div>
  <div class="kpi load"><div class="l">Зареждания</div><div class="v">${bg(data.loads_neto)} €</div></div>
  <div class="kpi stock"><div class="l">Склад (в пари)</div><div class="v">${bg(data.stock_value)} €</div><div class="s">${data.stock_items || 0} артикула · себест.</div></div>
  <div class="kpi"><div class="l">Сметки</div><div class="v">${data.accounts || 0}</div><div class="s">среден чек ${bg(data.avg_check)} €</div></div>
</div>
<div id="detail"></div>
<div class="card"><h2>🧮 „Какво ако…"<span>местиш плъзгачите — смята на живо</span></h2>
  <div class="wf" style="padding:14px 16px 16px">
   <div>
     <div><label>Разходи (фиксирани) <b id="wfExpL"></b></label><input type="range" id="wfExp"></div>
     <div style="margin-top:12px"><label>Цени <b id="wfPriceL"></b></label><input type="range" id="wfPrice" min="-20" max="30" step="1" value="0"></div>
     <button class="reset" id="wfReset">↺ Върни реалните</button>
   </div>
   <div>
    <div class="out"><div class="b"><div class="l">Резултат</div><div class="v" id="wfRes"></div></div><div class="b" style="border-color:#1f5b59"><div class="l">Маржин</div><div class="v" id="wfMar" style="color:#1f5b59"></div></div></div>
    <div class="mini" id="wfNote"></div>
   </div>
  </div></div>
${data.fixed ? `<div class="card"><h2>Фиксирани разходи<span>${data.fixed.auto ? "авто · " : "ръчно · "}${bg(data.fixed.monthly)} €/мес × ${data.fixed.months} мес</span></h2>
  <table><thead><tr><th>Разход (${esc(data.fixed.source || "")})</th><th class="q">€ за периода</th></tr></thead><tbody>
  ${data.fixed.salaries.map(l => `<tr><td>${esc(l.label)}</td><td class="q">${bg(l.amount)}</td></tr>`).join("")}
  <tr><td>Осигуровки работодател (~18,9%, таван 2300)</td><td class="q">${bg(data.fixed.osig)}</td></tr>
  ${data.fixed.other.map(l => `<tr><td>${esc(l.label)}</td><td class="q">${bg(l.amount)}</td></tr>`).join("")}
  <tr><td><b>Средно месечно</b></td><td class="q"><b>${bg(data.fixed.monthly)}</b></td></tr>
  <tr><td><b>За периода (${data.fixed.months} мес)</b></td><td class="q"><b>${bg(data.fixed.total)} €</b></td></tr>
  ${data.fixed.byMonth ? `<tr><td colspan="2" style="color:#7a8087;font-size:12px;padding-top:8px">По месеци (бруто + осиг.${data.fixed.other.length ? " + наем/ток" : ""}): ${data.fixed.byMonth.map(b => `${b.month.slice(5)}.${b.month.slice(2,4)}: ${bg(b.total)}${b.share < 1 ? " (" + Math.round(b.share*100) + "%)" : ""}${b.estimated ? "*" : ""}`).join(" · ")}${data.fixed.byMonth.some(b => b.estimated) ? " · *по последната ведомост" : ""}</td></tr>` : ""}
  </tbody></table>
  <div class="s">Само цехът (бруто заплати по ведомост + осигуровки работодател). Точката (Роксана + наем + ток, от 09.2026) е в „Точка" дашборда.</div></div>` : ""}
${tips ? `<div class="card"><h2>💡 Съвети / Наблюдения</h2><ul class="tips">${tips}</ul></div>` : ""}
<div class="card"><h2 style="flex-wrap:wrap"><span>Оборот по период <b id="trTot" style="font-weight:600;opacity:.8;font-size:12px"></b></span><span class="seg" id="seg"><button data-g="day">Ден</button><button data-g="week">Седмица</button><button data-g="month" class="on">Месец</button><span style="width:8px"></span><button data-v="period" class="on">Периоди</button><button data-v="total">Тотал</button></span></h2>
  <div class="chartbox"><canvas id="cTrend" height="150"></canvas></div>
  <details class="tbl" open><summary>таблица · сравнение спрямо предходния</summary>
  <table><thead><tr><th>Период</th><th class="q">Оборот без ДДС</th><th class="q">Δ предх.</th></tr></thead><tbody id="bkt"></tbody></table></details></div>
<div class="card"><h2>Оборот по клиент<span>дял от оборота</span></h2>
  <div class="chartbox donut"><canvas id="cClients" height="260" style="max-width:420px"></canvas></div>
  <details class="tbl" open><summary>таблица</summary>
  <table><thead><tr><th>Клиент</th><th class="q">Оборот</th><th class="q">Маржин</th><th class="q">Фактурирано</th><th class="q">Без фактура</th><th class="q">Сметки</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6" class="note">Няма затворени сметки в периода.</td></tr>'}</tbody></table>
  <div class="note" style="margin:0 0 10px;text-align:left;padding:0 16px">„Без фактура" при месечен изглед включва разноса от края на месеца, който се фактурира в началото на следващия (фактурите са седмични партиди, броят се по датата на издаване). На годишен изглед остава само най-последният нефактуриран разнос.</div></details></div>
${(() => {
  const cl = err ? [] : (data.clients || []).filter(c => Array.isArray(c.arts) && c.arts.length);
  if (!cl.length) return "";
  const tot = {}, nm = {};
  for (const c of cl) for (const a of c.arts) { tot[a.id] = (tot[a.id] || 0) + a.units; nm[a.id] = a.name; }
  const menuId = id => { const m = ARTS[String(id)]; return m ? (m.is_menu || m.is_set) : true; };
  const cols = Object.keys(tot).filter(menuId).sort((a, b) => tot[b] - tot[a]).slice(0, 14);
  const n0 = v => v ? Math.round(v).toLocaleString("bg-BG") : "";
  const head = cols.map(id => `<th class="q v">${esc(nm[id])}</th>`).join("");
  const body = cl.map(c => { const u = {}; let rest = 0, all = 0; for (const a of c.arts) { if (cols.includes(String(a.id))) u[a.id] = a.units; else if (menuId(a.id)) rest += a.units; if (menuId(a.id)) all += a.units; }
    return `<tr><td class="n">${esc(c.name)}</td>${cols.map(id => `<td class="q">${n0(u[id])}</td>`).join("")}<td class="q">${n0(rest)}</td><td class="q"><b>${n0(all)}</b></td></tr>`; }).join("");
  const foot = `<tr><td class="n"><b>Общо</b></td>${cols.map(id => `<td class="q"><b>${n0(tot[id])}</b></td>`).join("")}<td class="q"></td><td class="q"></td></tr>`;
  return `<div class="card"><h2>🧾 Кой клиент какво купува<span>бройки за периода</span></h2>
  <div style="overflow-x:auto"><table class="cxa"><thead><tr><th>Клиент</th>${head}<th class="q">Други</th><th class="q">Общо</th></tr></thead><tbody>${body}${foot}</tbody></table></div></div>`;
})()}
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
var DASH=${err ? "{}" : JSON.stringify({ neto: data.total_neto || 0, cogs: data.cogs || 0, exp: data.expenses || 0, result: data.result || 0, stock: data.stock_value || 0, invoiced: data.invoiced_neto || 0, gap: gapNeto || 0, loads: data.loads_neto || 0, accounts: data.accounts || 0, avg: data.avg_check || 0, fixedMonthly: (data.fixed && data.fixed.monthly) || 0, months: (data.fixed && data.fixed.months) || 0 })};
var mView='period';
function bgn(n){return (Math.round((n||0)*100)/100).toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2})}
function bgi(n){return Math.round(n||0).toLocaleString('bg-BG')}
function wk(iso){var d=new Date(iso+'T12:00:00Z');var day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);return d.toISOString().slice(0,10)}
function bucketize(g){var b={};Object.keys(BYDAY).forEach(function(d){var key=g==='day'?d:g==='week'?wk(d):d.slice(0,7);b[key]=(b[key]||0)+BYDAY[d]});return b}
var trendChart=null;
function dpct(cur,prev){return (prev!=null&&prev!==0)?((cur-prev)/prev*100):null}
function dcell(d){if(d==null)return '<td class="c">—</td>';var c=d>=0?'#0a6b2e':'#b3121b';return '<td class="q" style="color:'+c+';font-weight:800">'+(d>=0?'▲ ':'▼ ')+Math.abs(d).toFixed(1)+'%</td>'}
var curG='month';
function render(g){curG=g;var b=bucketize(g);var keys=Object.keys(b).sort();
  var per=keys.map(function(k){return Math.round((b[k]||0)*100)/100});
  var tot=0,cum=per.map(function(v){tot+=v;return Math.round(tot*100)/100});
  var vals=mView==='total'?cum:per;
  var deltas=keys.map(function(k,i){return (mView==='period'&&i>0)?dpct(per[i],per[i-1]):null});
  var tt=document.getElementById('trTot');if(tt)tt.textContent='· тотал '+bgi(tot)+' €';
  var h='';for(var i=keys.length-1;i>=0;i--){var lab=g==='week'?'седм. от '+keys[i]:keys[i];h+='<tr><td>'+lab+'</td><td class="q">'+bgn(vals[i])+' €</td>'+dcell(deltas[i])+'</tr>'}
  var bkt=document.getElementById('bkt');if(bkt)bkt.innerHTML=h||'<tr><td colspan="3" class="note">няма данни</td></tr>';
  if(window.Chart){var ctx=document.getElementById('cTrend');
    if(trendChart)trendChart.destroy();
    trendChart=new Chart(ctx,{type:mView==='total'?'line':'bar',data:{labels:keys,datasets:[{label:'Оборот без ДДС',data:vals,borderColor:'#1f5b59',backgroundColor:mView==='total'?'rgba(31,91,89,.12)':'rgba(31,91,89,.85)',fill:mView==='total',tension:.3,pointRadius:mView==='total'?2:0,pointHoverRadius:5,borderWidth:2,borderRadius:5}]},
      options:{responsive:true,maintainAspectRatio:false,onClick:function(e,els){if(els.length)periodDetail(keys[els[0].index],per[els[0].index],cum[els[0].index],deltas[els[0].index])},plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return (mView==='total'?'натрупано ':'')+bgn(c.parsed.y)+' €'},afterLabel:function(c){var d=deltas[c.dataIndex];return d==null?'':'спрямо предх.: '+(d>=0?'+':'')+d.toFixed(1)+'%'}}}},scales:{y:{ticks:{callback:function(v){return bgn(v)}}},x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:14}}}}});}
}
function periodDetail(lab,v,c,d){showDetail('Период '+lab,bgi(v)+' €',[['Оборот за периода',bgn(v)+' €'],['Натрупано до тук',bgn(c)+' €'],['Δ спрямо предходния',d==null?'—':((d>=0?'+':'')+d.toFixed(1)+'%')]]);}
document.querySelectorAll('#seg button[data-g]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('#seg button[data-g]').forEach(function(x){x.classList.remove('on')});b.classList.add('on');render(b.getAttribute('data-g'))})});
document.querySelectorAll('#seg button[data-v]').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('#seg button[data-v]').forEach(function(x){x.classList.remove('on')});b.classList.add('on');mView=b.getAttribute('data-v');render(curG)})});
render('month');
if(window.Chart){var scl=CLIENTS.slice().sort(function(a,b){return b.t-a.t});var lead=scl.slice(0,7);var rest=scl.slice(7).reduce(function(s,c){return s+c.t},0);
  var labels=lead.map(function(c){return c.name});var vals=lead.map(function(c){return Math.round(c.t*100)/100});
  if(rest>0){labels.push('други');vals.push(Math.round(rest*100)/100)}
  var cols=['#1f5b59','#2b6ca3','#b06a00','#7a4b8a','#0a6b2e','#b3121b','#8a6608','#9aa0a6'];
  var ctotC=vals.reduce(function(a,b){return a+b},0);
  new Chart(document.getElementById('cClients'),{type:'doughnut',data:{labels:labels,datasets:[{data:vals,backgroundColor:cols,borderWidth:2,borderColor:'#fff'}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'58%',onClick:function(e,els){if(els.length){var i=els[0].index;showDetail(labels[i],bgi(vals[i])+' €',[['Дял от оборота',(ctotC?(vals[i]/ctotC*100).toFixed(1):0)+'%'],['Среден месечен',bgi(vals[i]/(DASH.months||1))+' €']])}},plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:12}}},tooltip:{callbacks:{label:function(c){var s=c.dataset.data.reduce(function(a,b){return a+b},0);return c.label+': '+bgn(c.parsed)+' € ('+(s?Math.round(c.parsed/s*100):0)+'%)'}}}}}});}
// ── детайл панел (клик за детайл) ──
function showDetail(title,sum,rows){var el=document.getElementById('detail');if(!el)return;
  el.innerHTML='<h3>'+title+(sum?'<span>'+sum+'</span>':'')+'</h3><div class="body">'+rows.map(function(r){return '<div class="drow">'+(r[1]?(r[0]+': <b>'+r[1]+'</b>'):r[0])+'</div>'}).join('')+'</div>';
  el.className='show';el.scrollIntoView({behavior:'smooth',block:'nearest'});}
// KPI клик за детайл
(function(){
  var det={turn:['Оборот (без ДДС)',function(){return [['Затворени сметки (÷1.2)',bgi(DASH.neto)+' €'],[DASH.accounts+' сметки · среден чек',bgn(DASH.avg)+' €']]}],
   cost:['Себестойност',function(){return [['Материали по рецепта',bgi(DASH.cogs)+' €'],['Дял от оборота',(DASH.neto?(DASH.cogs/DASH.neto*100).toFixed(1):0)+'%']]}],
   exp:['Разходи',function(){return [['Фиксирани (заплати+осиг.+наем/ток)',bgi(DASH.exp)+' €'],['Месечно × месеци',bgn(DASH.fixedMonthly)+' € × '+DASH.months]]}],
   res:['Резултат',function(){return [['Оборот − Себестойност − Разходи',bgi(DASH.result)+' €'],['= '+bgi(DASH.neto)+' − '+bgi(DASH.cogs)+' − '+bgi(DASH.exp),''],['Маржин',(DASH.neto?(DASH.result/DASH.neto*100).toFixed(1):0)+'%']]}],
   stock:['Склад (в пари)',function(){return [['Наличност × средна себестойност',bgi(DASH.stock)+' €'],['само положителните количества','']]}]};
  var sel=null;
  document.querySelectorAll('.kpis .kpi').forEach(function(d){
    var cls=['turn','cost','exp','res','stock'].filter(function(c){return d.classList.contains(c)})[0];
    if(!det[cls])return; d.classList.add('clk');
    d.addEventListener('click',function(){
      if(sel===cls){document.getElementById('detail').className='';d.classList.remove('sel');sel=null;return;}
      document.querySelectorAll('.kpi').forEach(function(x){x.classList.remove('sel')});d.classList.add('sel');sel=cls;
      showDetail(det[cls][0],'',det[cls][1]());
    });
  });
})();
// ── „Какво ако" ──
(function(){var we=document.getElementById('wfExp'),wp=document.getElementById('wfPrice');if(!we)return;
  we.min=0;we.max=Math.max(Math.round(DASH.exp*2),1000);we.step=500;we.value=Math.round(DASH.exp);
  function calc(){var p=+wp.value,exp=+we.value;var neto=DASH.neto*(1+p/100);var res=neto-DASH.cogs-exp;var mar=neto>0?res/neto*100:0;
    document.getElementById('wfExpL').textContent=bgi(exp)+' €';document.getElementById('wfPriceL').textContent=(p>0?'+':'')+p+'%';
    var rv=document.getElementById('wfRes');rv.textContent=bgi(res)+' €';rv.style.color=res>=0?'#0a6b2e':'#b3121b';
    document.getElementById('wfMar').textContent=mar.toFixed(1)+'%';
    var dr=res-DASH.result;document.getElementById('wfNote').innerHTML='спрямо реалното: <b style="color:'+(dr>=0?'#0a6b2e':'#b3121b')+'">'+(dr>=0?'+':'')+bgi(dr)+' €</b> · при цени '+(p>0?'+':'')+p+'% оборотът става '+bgi(neto)+' €';}
  we.oninput=calc;wp.oninput=calc;document.getElementById('wfReset').onclick=function(){we.value=Math.round(DASH.exp);wp.value=0;calc()};calc();
})();
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
// брояч на числата в KPI (count-up)
(function(){
  if(window.matchMedia&&matchMedia('(prefers-reduced-motion:reduce)').matches)return;
  var els=[].slice.call(document.querySelectorAll('.kpi .v'));
  els.forEach(function(el){
    var txt=el.textContent, m=txt.match(/-?\\d[\\d\\s\\u00a0.,]*/);
    if(!m)return; var raw=m[0];
    var dec=/,/.test(raw);
    var target=parseFloat(raw.replace(/[\\s\\u00a0]/g,'').replace(',','.'));
    if(!isFinite(target)||target===0)return;
    var pre=txt.slice(0,m.index), suf=txt.slice(m.index+raw.length);
    var fmt=function(v){return dec?v.toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2}):Math.round(v).toLocaleString('bg-BG')};
    var t0=null,dur=850;
    function step(ts){if(t0===null)t0=ts;var p=Math.min((ts-t0)/dur,1);var e=1-Math.pow(1-p,3);el.textContent=pre+fmt(target*e)+suf;if(p<1)requestAnimationFrame(step);else el.textContent=pre+fmt(target)+suf;}
    el.textContent=pre+fmt(0)+suf;requestAnimationFrame(step);
  });
})();
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
.sug{display:block;font-size:14px;font-weight:700;color:#1565c0;line-height:17px;margin-top:3px;white-space:nowrap;cursor:help}
.stok{display:inline-block;background:#c8151f;color:#fff;font-weight:800;font-size:11px;line-height:16px;width:16px;text-align:center;border-radius:4px;margin-left:4px}
#grid td.shop{z-index:1;font-weight:500}#grid th.shop{z-index:3;background:#2b2f36}
#grid td input{width:46px;text-align:center;border:1px solid #cfd3d8;border-radius:5px;padding:5px 3px;font-size:14px}
#grid td input:focus{outline:2px solid #0a7d33;border-color:#0a7d33}
#grid td.shop input.selbox,#grid th.shop #selall{width:17px;height:17px;margin-right:6px;vertical-align:-3px;cursor:pointer;accent-color:#0a7d33}
#grid tr.off td{opacity:.4}#grid tr.off td.shop{opacity:.6}
#grid td.set input{background:#fff7e6}#grid th.set{background:#4a3d1a;color:#ffe6a3}
h2{font-size:15px;margin:18px 0 6px}.plan{display:flex;gap:24px;flex-wrap:wrap}.plan table{width:auto;min-width:260px}.plan table td,.plan table th{border:1px solid #e2e4e8;padding:7px 12px;text-align:left}.plan table th{background:#f0f1f3}.plan td.q{font-weight:700;color:#b3121b;text-align:right}
@media print{header,.noprint{display:none}.wrap{padding:0}}
.pickwrap{position:fixed;inset:0;background:rgba(20,23,26,.5);display:flex;align-items:center;justify-content:center;z-index:20;padding:16px}
.pickbox{background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);width:min(560px,100%);max-height:82vh;display:flex;flex-direction:column;overflow:hidden}
.pickhd{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#2b2f36;color:#fff;flex-wrap:wrap}
.pickhd .pickhint{font-size:12px;opacity:.8;flex:1}
.pickbox #pickfilter{margin:10px 14px 6px;padding:9px 10px;border:1px solid #cfd3d8;border-radius:7px;font-size:15px}
.picklist{overflow:auto;padding:4px 8px 12px}
.pick{padding:11px 12px;border-radius:8px;cursor:pointer;user-select:none;border:1px solid #eef0f2;margin:4px 0;font-size:15px}
.pick:hover{background:#eef7f0;border-color:#0a7d33}
.pick.has{opacity:.55}
.pick .tag{font-size:11px;background:#e2e4e8;color:#555;border-radius:4px;padding:1px 6px;margin-left:6px}
</style></head><body>
<header><div class="brand"><img src="https://motamo.bg/icons/icon-192.png" alt="MOTAMO" onerror="this.style.display='none'"><h1>MOTAMO цех<small>производство · сметки · стокова</small></h1></div>
<span id="tokwrap"><input id="tok" type="password" placeholder="токен" size="16"></span>
<span class="grp"><label>Зареди</label><input id="date" type="date" lang="bg-BG"><b class="dlab" id="dlab"></b><button class="alt" onclick="loadRazos()" title="Зарежда РАЗНОСА за деня = отворените сметки (направени в навечерието/сутринта), без вчерашните затворени. За ③ Стокова.">Отворени сметки</button><button class="alt" onclick="loadByLot()" title="Зарежда сметките от партида L.[деня от Зареди] (±2 дни), през реалните движения. За референтен минал ден или преди ③ Стокова.">↻ По партида</button></span>
<span class="grp"><button class="alt" onclick="loadSug()" title="Средно изпратено в същия ден от седмицата (последните 4) минус % връщане. Датата е от „Партида". Не пише в Barsy.">Предложение</button><button class="alt" onclick="fillSug()" title="Слага предложението в полетата на ТИКНАТИТЕ магазини">Попълни</button></span>
<span class="grp"><button class="alt" onclick="openReq()" title="Заявките, пратени от магазините през формата (линк на телефона)">📥 Заявки</button></span><span class="grp"><button class="alt" onclick="calc()">Изчисли</button><button class="alt" onclick="openPicker()" title="Добави магазин, който днешният разнос не е заредил">+ Магазин</button><button class="alt" onclick="sendTg()" title="Праща плана от последното Изчисли (датата в Партида) в Telegram групата на цеха. Пак натиснато = само разликата.">📤 Прати на цеха</button></span>
<span class="grp"><label>Партида</label><input id="pdate" type="date" lang="bg-BG" title="Партида L.<тази дата>, срок +3 дни"><b class="dlab" id="plab"></b><button class="alt" onclick="openDay()" title="Отваря записаното за датата в „Партида" (магазини и заявки) — от всяко устройство.">📂 Отвори деня</button><b class="dlab" id="daysav"></b></span>
<span class="grp"><button class="prod" onclick="doZagotovki()">① Заготовки</button><button class="prod" onclick="doArticles()">② Артикули</button><button class="acc" onclick="doAccounts()">③ Генерирай сметки</button><button class="acc" onclick="doStokova()">④ Генерирай стокова</button></span></header>
<div class="wrap"><div id="msg" class="msg"></div><div class="scroll"><table id="grid"></table></div><div id="planbox"></div></div>
<div id="picker" class="pickwrap" style="display:none"><div class="pickbox">
<div class="pickhd"><b>Добави магазин</b><span class="pickhint">двоен клик върху ред → добавя се долу в решетката</span><button class="alt" onclick="closePicker()">Затвори</button></div>
<input id="pickfilter" placeholder="търси магазин…" oninput="renderPick()">
<div id="picklist" class="picklist"></div></div></div>
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
var sg=sugFor(s);MENU.forEach(function(m){var v=(s.order&&s.order[m.name])||0;var p=sg?sg[m.name]:null;var ph=sg?'<small class="sug" title="'+(p?('средно '+p.avg+' за '+p.weeks+(p.same?' същи дни':' последни доставки')+(p.rate?(', връщане '+p.rate+'%'):'')):'не е взимал')+'">пр. '+(p?p.n:0)+'</small>':'';h+='<td class="'+(m.is_set?'set':'')+'"><input data-i="'+i+'" data-n="'+esc(m.name)+'" value="'+v+'" inputmode="numeric">'+ph+'</td>'});h+='</tr>'});$('grid').innerHTML=h;
var sa=$('selall');if(sa){sa.addEventListener('change',function(){document.querySelectorAll('#grid .selbox').forEach(function(cb){cb.checked=sa.checked});syncRows()})}
document.querySelectorAll('#grid .selbox').forEach(function(cb){cb.addEventListener('change',syncRows)});syncRows();saveGrid()}
function sendTg(){var d=$('pdate').value||$('date').value;if(!d){msg('Избери дата в «Партида».','err');return}if(!confirm('Да пратя плана за '+d.split('-').reverse().join('.')+' в Telegram групата на цеха?'))return;msg('Пращам в Telegram…');api({action:'tg_send_plan',date:d}).then(function(j){if(j.ok){msg(j.unchanged?j.message:(j.kind==='addition'?'✓ Пратено ДОПЪЛНЕНИЕ (само разликата).':'✓ Планът е пратен в групата.'),'ok')}else msg('Не е пратено: '+(j.message||j.error||''),'err')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
var SUG=null;function sugFor(s){if(!SUG)return null;var k=(s.client_id!=null?s.client_id:'')+':'+(s.person_id!=null?s.person_id:'');return SUG[k]||null}
function loadSug(){var d=$('pdate').value||$('date').value;if(!d){msg('Избери дата в „Партида" (деня на разноса).','err');return}var n=0;msg('Смятам предложението за '+d.split('-').reverse().join('.')+'…');
(function go(){api({action:'suggest',date:d}).then(function(j){if(!j.ok){msg('Грешка: '+(j.message||j.error||''),'err');return}var p=j.sync&&j.sync.pending;if(p&&++n<5){msg('Чета стари стокови от Barsy… остават '+p+'.');go();return}SUG=j.by||{};collect();renderGrid();var c=shops.filter(function(s){return sugFor(s)}).length;msg('Предложение за '+d.split('-').reverse().join('.')+': сивото „пр. N" под всяко поле ('+c+' от '+shops.length+' магазина имат история). „Попълни" го слага в полетата.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})})()}
function fillSug(){if(!SUG){msg('Първо натисни „Предложение".','err');return}collect();var c=0;document.querySelectorAll('#grid .selbox').forEach(function(cb){if(!cb.checked)return;var s=shops[+cb.getAttribute('data-i')],sg=sugFor(s);if(!sg)return;var o={};Object.keys(sg).forEach(function(k){if(sg[k].n>0)o[k]=sg[k].n});s.order=o;c++});renderGrid();msg('Попълнени '+c+' тикнати магазина с предложението. Провери и коригирай.','ok')}
function syncRows(){document.querySelectorAll('#grid .selbox').forEach(function(cb){var tr=cb.closest('tr');if(tr)tr.className=cb.checked?'':'off'})}
function collect(){document.querySelectorAll('#grid input[data-n]').forEach(function(inp){var i=+inp.getAttribute('data-i'),n=inp.getAttribute('data-n'),v=parseFloat(inp.value)||0;if(!shops[i].order)shops[i].order={};if(v)shops[i].order[n]=v;else delete shops[i].order[n]})}
// Взима САМО избраните магазини (тикнати), след като събере числата от решетката.
function selShops(){collect();var out=[];document.querySelectorAll('#grid .selbox').forEach(function(cb){if(cb.checked){var i=+cb.getAttribute('data-i');if(shops[i])out.push(shops[i])}});return out}
function calc(){var sel=selShops();if(!sel.length){msg('Избери поне един магазин (тикчето отляво).','err');return}msg('Смятам и записвам за кухнята…');var kd=$('pdate').value||$('date').value;api({shops:sel,publish_kitchen:true,kitchen_date:kd}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}renderPlan(j);var sv=j.kitchen_saved?(' Записано за кухнята ('+j.kitchen_saved+') — момичетата го виждат на екрана.'):(j.kitchen_saved===false?' (записът за кухнята не мина)':'');msg('Планът е готов за '+sel.length+' магазина.'+sv,'ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function tbl(t,o){var ks=Object.keys(o||{});if(!ks.length)return '';var h='<table><tr><th class="shop">'+t+'</th><th>кол.</th></tr>';ks.forEach(function(k){h+='<tr><td class="shop">'+esc(k)+'</td><td class="q">'+o[k]+'</td></tr>'});return h+'</table>'}
function preBox(pf){if(!pf)return '';if(pf.error)return '<div class="prewarn" style="background:#fff8e1;border:1px solid #f0c36d;color:#7a5b00;padding:8px 10px;border-radius:8px;margin-bottom:10px">⚠ Не можах да прочета склада за проверка ('+esc(pf.message||'')+'). Плана по-долу е наред, но провери суровините ръчно.</div>';var lr=pf.load_raw||{},lk=Object.keys(lr);var zg=pf.produce_zagotovki||{};var h='';var ip=pf.in_point||{};if(pf.stale&&pf.stale.length){h+='<div style="background:#fff8e1;border:1px solid #f0c36d;color:#7a5b00;padding:8px 12px;border-radius:8px;margin-bottom:10px">⚠ Имаш отворени сметки от СТАРА партида: <b>'+pf.stale.map(function(x){return esc(x.lot)}).join(', ')+'</b>. Не пречат на днешната, но ги затвори в Barsy.</div>'}if(pf.with_account){h+='<div style="background:#eef4ff;border:1px solid #b9cdf0;color:#1f3f77;padding:8px 12px;border-radius:8px;margin-bottom:10px">'+pf.with_account+' от тикнатите магазини вече имат сметка за тази дата — не се броят втори път.</div>'}if(lk.length){h+='<div class="prebad" style="background:#fdecea;border:1px solid #e0a0a0;color:#8a1c1c;padding:10px 12px;border-radius:8px;margin-bottom:10px"><b>⚠ ЗАРЕДИ ПЪРВО (суровини — не могат да се произведат):</b><table style="margin-top:6px">'+lk.map(function(k){return '<tr><td class="shop">'+esc(k)+(ip[k]?' <small>(в склад „Точка" има '+ip[k]+' — прехвърли го в Основен)</small>':'')+'</td><td class="q">'+lr[k]+'</td></tr>'}).join('')+'</table><div style="margin-top:4px;font-size:12px">Зареди тези, инак производството ще гръмне насред процеса.</div></div>'}else{h+='<div class="preok" style="background:#e9f7ec;border:1px solid #a5d6b0;color:#1c6b2e;padding:8px 12px;border-radius:8px;margin-bottom:10px">✓ Няма суровини за зареждане — всички стигат.</div>'}var zk=Object.keys(zg);h+=tbl('Произведи заготовки ПЪРВО',zg);if(zk.length)h+='<div style="background:#eef4ff;border:1px solid #b9cdf0;color:#1f3f77;padding:8px 12px;border-radius:8px;margin-top:6px;font-size:13px">Кухнята ги прави физически. После натисни <b>„① Заготовки"</b> — бутонът само ги записва в Barsy и изписва суровините.</div>';return h?('<div style="margin-bottom:6px">'+h+'</div>'):''}
function renderPlan(j){$('planbox').innerHTML=preBox(j.preflight)+'<h2>За производство</h2><div class="plan">'+tbl('Сетове',j.produce_sets)+tbl('Ролки / поке',j.produce_rolls)+tbl('Заготовки',j.produce_zagotovki)+'</div>'}
function doZagotovki(){if(!shops.length){msg('Първо натисни „Зареди".','err');return}var sel=selShops();if(!sel.length){msg('Избери поне един магазин.','err');return}var pd=$('pdate').value;if(!confirm('① Ще произведа ЗАГОТОВКИТЕ (майонези, сосове, ориз…) за '+sel.length+' магазина, дата '+pd+'.\\nПродължавам?'))return;msg('Правя заготовките…');api({action:'produce_plan',only:'zag',shops:sel,prod_date:pd}).then(function(j){if(j.error&&!j.zagotovki){msg('Грешка: '+(j.error||j.message||''),'err');return}var z=j.zagotovki||{};var zp=(z.produced||[]).length,zs=(z.skipped||[]).length,zf=z.failed||[];var lr=j.load_raw||{},lrk=Object.keys(lr);var lrTxt=lrk.length?(' · ⚠️ ЗАРЕДИ суровини: '+lrk.map(function(k){return k+' '+lr[k]}).join(', ')):'';var zfTxt=zf.length?(' · ⚠️ НЕ излязоха: '+zf.map(function(f){return f.name+(f.reason?(' — '+f.reason):'')}).join(' | ')):'';var bad=zf.length||lrk.length;msg((bad?'⚠️ ':'✓ ')+'Заготовки: '+zp+' произв.'+(zs?(' ('+zs+' ръчни, без рецепта)'):'')+zfTxt+lrTxt+(bad?'':'. Сега натисни „② Артикули".'),bad?'err':'ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function detail(t){var d=document.getElementById('detailline');if(!d){d=document.createElement('div');d.id='detailline';d.style.cssText='margin:6px 0 0;font-size:13px;color:#9aa3b2;line-height:1.4';var m=document.getElementById('msg');if(m&&m.parentNode)m.parentNode.insertBefore(d,m.nextSibling)}d.textContent=t}
function doArticles(){if(!shops.length){msg('Първо натисни „Зареди".','err');return}var sel=selShops();if(!sel.length){msg('Избери поне един магазин.','err');return}var pd=$('pdate').value;var lot='L.'+pd.split('-').reverse().join('.');if(!confirm('② Ще произведа РОЛКИ/ПОКЕ и СЕТОВЕ под партида '+lot+' за '+sel.length+' магазина.\\n(Липсващите заготовки се записват автоматично преди тях.)\\nПродължавам?'))return;msg('Правя артикулите (ролки/поке → сетове)…');api({action:'produce_plan',only:'articles',shops:sel,prod_date:pd,razos_date:$('date').value}).then(function(j){if(!j.ok){if(j.error==='lot_dirty'){msg('⚠️ '+j.message,'err');return}msg('Грешка при производство: '+((j.rolls&&j.rolls.error)||(j.sets&&j.sets.error)||j.message||j.error||''),'err');return}var ri=j.rolls&&j.rolls.store_production_id,si=j.sets&&j.sets.store_production_id;var pr=j.produced_rolls||{},ps=j.produced_sets||{};var zz=(j.zagotovki&&j.zagotovki.produced)||[];if(zz.length)setTimeout(function(){detail('Записани заготовки преди артикулите: '+zz.join(', '))},50);
var mk=function(o){return Object.keys(o).map(function(k){return k+' '+o[k]}).join(', ')};
var madeTxt=[Object.keys(pr).length?('ролки/поке: '+mk(pr)):'',Object.keys(ps).length?('сетове: '+mk(ps)):''].filter(Boolean).join(' · ');var al=j.already_under_lot||{},alk=Object.keys(al);var lr=j.load_raw||{},lrk=Object.keys(lr);var lrTxt=lrk.length?(' · ⚠️ ЗАРЕДИ суровини/заготовки ПРЕДИ: '+mk(lr)):'';if(!ri&&!si){msg('Нищо ново не е произведено — поръчаното вече е налично под партида '+j.lot+'.'+lrTxt,'ok');if(alk.length)detail('Под партидата от по-рано днес (НЕ е произведено сега): '+mk(al));return}msg((lrk.length?'⚠️ ':'✓ ')+'ПРОИЗВЕДЕНО СЕГА · '+madeTxt+' · док. ролки №'+(ri||'—')+', сетове №'+(si||'—')+lrTxt+'. Сега „③ Генерирай сметки".',lrk.length?'err':'ok');if(alk.length)detail('Под партидата от по-рано днес (НЕ е произведено сега): '+mk(al));}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function doAccounts(){if(!shops.length){msg('Първо натисни „Зареди", за да заредиш деня.','err');return}var sel=selShops();if(!sel.length){msg('Избери поне един магазин (тикчето отляво).','err');return}var pd=$('pdate').value||$('date').value;var lot=pd?('L.'+pd.split('-').reverse().join('.')):'';if(!confirm('Ще СЪЗДАМ отворени сметки в Barsy за '+sel.length+' магазина'+(lot?(', ВЕЧЕ с партида '+lot):'')+'.\\nЦените ги слага Barsy по правилото на клиента.\\nПродължавам?'))return;if(window.ACCBUSY){msg('Още създавам сметките — изчакай да свърши.','err');return}window.ACCBUSY=1;msg('Създавам сметките…');var DAYBAD=false,CH=3,cr=[],dt=($('pdate').value||$('date').value);function step(i){if(i>=sel.length)return Promise.resolve();msg('Създавам сметките… '+Math.min(i+CH,sel.length)+' от '+sel.length);return api({action:'create_accounts',date:dt,shops:sel.slice(i,i+CH)}).then(function(j){if(j&&j.ok&&j.day_saved===false)DAYBAD=true;var part=(j&&j.ok&&j.created)||[];for(var x=0;x<Math.min(CH,sel.length-i);x++)cr.push(part[x]||{client:sel[i+x].client,rep:sel[i+x].rep,ok:false,error:(j&&(j.error||j.message))||'няма отговор'});return step(i+CH)},function(e){for(var x=0;x<Math.min(CH,sel.length-i);x++)cr.push({client:sel[i+x].client,rep:sel[i+x].rep,ok:false,error:'мрежова грешка/таймаут — натисни ③ пак (готовите не се дублират)'});return step(i+CH)})}step(0).then(function(){window.ACCBUSY=0;var ok=cr.filter(function(c){return c.ok}).length,bad=cr.filter(function(c){return c.ok===false}).length;sel.forEach(function(s,i){if(cr[i]&&cr[i].account_id){s.account_id=cr[i].account_id;s.acc_date=dt}});saveGrid();LASTACC=cr.filter(function(c){return c.ok&&c.account_id}).map(function(c){return c.account_id});msg('✓ Създадени '+ok+' сметки'+(bad?(', '+bad+' с грешка'):'')+'. После натисни ④ Стокова.'+(DAYBAD?' ⚠ Записът на деня не мина — НЕ натискай ② за тези магазини от друго устройство.':''),(bad||DAYBAD)?'err':'ok');renderCreated(cr)}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
// Тегли сметките, ползвали производствената ПАРТИДА L.<деня от „Зареди"> (±2 дни).
function loadByLot(){var d=$('date').value;var lot='L.'+(d?d.split('-').reverse().join('.'):'');msg('Търся сметките с партида '+lot+' (±2 дни)…');api({action:'load_by_lot',date:d}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}shops=j.shops||[];renderGrid();$('planbox').innerHTML='';if(!shops.length){msg('Няма сметки с партида '+(j.lot||lot)+'. (Провери деня в „Зареди" и че има производство с тази партида.)','err');return}var sc=shops.filter(function(s){return s.has_stokova}).length;msg('Партида '+(j.lot||lot)+': '+shops.length+' сметки я ползват. '+(sc?(sc+' вече имат стокова (червено „С", разтикнати). '):'')+'Тикни които искаш и натисни ③ Стокова.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
// Зарежда РАЗНОСА за деня = отворените сметки (направени в навечерието/сутринта), за ③ Стокова.
function loadRazos(){var d=$('date').value;msg('Зареждам разноса за '+d+'…');api({action:'load_razos',date:d}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}shops=j.shops||[];renderGrid();$('planbox').innerHTML='';if(!shops.length){msg('Няма отворени сметки за '+d+'. (Първо ② Сметки, или провери деня.)','err');return}var sc=shops.filter(function(s){return s.has_stokova}).length;msg('Разнос '+d+': '+shops.length+' отворени сметки.'+(sc?(' '+sc+' вече имат стокова (червено „С", разтикнати).'):'')+' Тикни които искаш и натисни ③ Стокова.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function doStokova(){var sel=selShops().filter(function(s){return s.account_id});if(!sel.length){msg('Няма сметки за стокова. Натисни „↻ Зареди по партида" (или ② Сметки), после тикни обектите.','err');return}var pd=$('pdate').value||$('date').value;if(!confirm('Ще СЪЗДАМ стокови за '+sel.length+' обекта (една по една), с дата '+pd+'.\\nПродължавам?'))return;var i=0,okc=0,errs=[];
function nextStok(){if(i>=sel.length){msg('✓ Стокови: '+okc+'/'+sel.length+' готови'+(errs.length?(' · грешки: '+errs.join(' | ')):''),errs.length?'err':'ok');return}var s=sel[i];msg('Правя стокова '+(i+1)+'/'+sel.length+' ('+shortName(s.client,s.rep)+')…');api({action:'create_stokova',account_id:s.account_id,date:pd}).then(function(j){if(j.ok)okc++;else errs.push('#'+s.account_id+': '+(j.error||''));i++;nextStok()}).catch(function(e){errs.push('#'+s.account_id+': мрежа');i++;nextStok()})}
nextStok()}
var OBJECTS=[];
// ── ★ S32 — заявки от формата на магазините → решетката ──
function openReq(){var d=$('pdate').value||$('date').value||new Date().toISOString().slice(0,10);msg('Чета заявките за '+d+'…');api({action:'shop_requests',date:d}).then(function(j){if(!j.ok){msg('Грешка: '+(j.message||j.error||''),'err');return}renderReq(j);$('msg').className='msg'}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function hhmm(s){var x=new Date(s);return isNaN(x)?'':('0'+x.getHours()).slice(-2)+':'+('0'+x.getMinutes()).slice(-2)}
function renderReq(j){var h='<div class="pickwrap" id="reqwrap" onclick="if(event.target===this)closeReq()"><div class="pickbox"><div style="padding:12px 14px;border-bottom:1px solid #e2e4e8;display:flex;justify-content:space-between;align-items:center"><b>📥 Заявки от формата за '+j.date.split('-').reverse().join('.')+'</b><button class="alt" onclick="closeReq()">✕</button></div><div style="overflow:auto;padding:10px 14px;font-size:13px">';
if(!j.requests.length)h+='<p style="color:#777">Още няма пратени заявки за този ден.</p>';
j.requests.forEach(function(r,i){var rows=r.rows.map(function(x){return x.name.replace('НACHI','')+' <b>'+x.qty+'</b>'}).join(' · ')||'<i>0 от всичко</i>';var lf=Object.keys(r.left||{}).length?' · останало: '+Object.keys(r.left).map(function(k){var m=MENU.filter(function(z){return String(z.id)===String(k)})[0];return (m?m.name.replace('НACHI',''):k)+' '+r.left[k]}).join(', '):'';
h+='<label style="display:block;padding:8px 0;border-bottom:1px solid #f0f1f3"><input type="checkbox" class="reqsel" data-i="'+i+'" '+(r.applied?'':'checked')+'> <b>'+esc(r.name)+'</b> <span style="color:#777">'+hhmm(r.sent_at)+(r.applied?' · ✓ приложена':(r.applied_at?' · ⚠ променена след прилагане':''))+'</span><br><span style="margin-left:22px">'+rows+'</span><span style="color:#777;margin-left:22px">'+lf+'</span></label>'});
if(j.silent.length)h+='<p style="color:#9b1c1c;margin:10px 0 4px"><b>Мълчат:</b> '+j.silent.map(function(x){return esc(x.name)}).join(', ')+'</p>';
h+='<details style="margin-top:10px"><summary style="cursor:pointer;color:#1565c0">Линкове за формата (прати на управителката във Viber)</summary>'+Object.keys(j.links).map(function(k){var n=(j.requests.filter(function(r){return r.obj_key===k})[0]||j.silent.filter(function(s){return s.obj_key===k})[0]||{name:k}).name;return '<div style="margin:6px 0"><b>'+esc(n)+'</b><br><input readonly value="'+esc(j.links[k])+'" style="width:100%;font-size:12px" onclick="this.select()"></div>'}).join('')+'</details>';
h+='</div><div style="padding:10px 14px;border-top:1px solid #e2e4e8;display:flex;gap:8px;justify-content:flex-end"><button class="alt" onclick="closeReq()">Затвори</button><button class="prod" onclick="applyReq()">Приложи избраните в решетката</button></div></div></div>';
var old=$('reqwrap');if(old)old.remove();document.body.insertAdjacentHTML('beforeend',h);REQ=j}
var REQ=null;function closeReq(){var w=$('reqwrap');if(w)w.remove()}
function applyReq(){if(!REQ)return;var sel=[];document.querySelectorAll('.reqsel').forEach(function(cb){if(cb.checked)sel.push(REQ.requests[+cb.getAttribute('data-i')])});if(!sel.length){msg('Не е избрана заявка.','err');return}collect();var added=0,upd=0;
sel.forEach(function(r){var s=shops.filter(function(x){return String(x.client_id||'')===String(r.client_id||'')&&String(x.person_id||'')===String(r.person_id||'')})[0];if(!s){s={client:r.name,rep:'',client_id:r.client_id,person_id:r.person_id,order:{},scheduled:true};shops.push(s);added++}else upd++;s.order={};r.rows.forEach(function(x){if(x.qty>0)s.order[x.name]=x.qty});s.scheduled=true;api({action:'shop_request_applied',id:r.id,applied_rows:r.rows})});
renderGrid();closeReq();msg('✓ Приложени '+sel.length+' заявки ('+upd+' обновени, '+added+' добавени). Провери решетката и натисни „Изчисли".','ok')}

function openPicker(){msg('Зареждам магазините…');api({action:'list_objects'}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}OBJECTS=j.objects||[];$('pickfilter').value='';renderPick();$('picker').style.display='flex';$('pickfilter').focus();msg('')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function closePicker(){$('picker').style.display='none'}
function pickLabel(o){return (o.client||'')+(o.rep?(' · '+o.rep):'')}
function inShops(o){return shops.some(function(s){return String(s.client_id||'')===String(o.client_id||'')&&String(s.person_id||'')===String(o.person_id||'')})}
function renderPick(){var f=($('pickfilter').value||'').toLowerCase();var h='';OBJECTS.forEach(function(o,idx){var lab=pickLabel(o);if(f&&lab.toLowerCase().indexOf(f)<0)return;var has=inShops(o);h+='<div class="pick'+(has?' has':'')+'" ondblclick="addShop('+idx+')" title="двоен клик за добавяне">'+esc(lab)+(has?' <span class="tag">вече е долу</span>':'')+'</div>'});$('picklist').innerHTML=h||'<div class="pick" style="opacity:.6;cursor:default">няма съвпадения</div>'}
function addShop(idx){var o=OBJECTS[idx];if(!o)return;if(inShops(o)){msg('„'+pickLabel(o)+'" вече е в решетката.','err');return}collect();shops.push({client:o.client,rep:o.rep,client_id:o.client_id,person_id:o.person_id,order:{},scheduled:true});renderGrid();renderPick();msg('Добавен „'+pickLabel(o)+'". Попълни количествата и натисни „Изчисли".','ok');var sc=document.querySelector('.scroll');if(sc)sc.scrollTop=sc.scrollHeight}
function renderCreated(cr){var h='<h2>Създадени сметки</h2><table><tr><th class="shop">Магазин</th><th>сметка №</th><th>артикули</th><th>статус</th></tr>';cr.forEach(function(c){var full=(c.client||'')+(c.rep?(' · '+c.rep):'');var tn=(c.topped_names&&c.topped_names.length)?(' [допроизв.: '+c.topped_names.join(', ')+']'):(c.topped?(' [допроизв. '+c.topped+']'):'');var st=c.ok?('✓'+(c.topped?tn:'')):('<span style="color:#c00" title="'+esc(c.error||'')+'">'+esc((c.error||c.skipped||'грешка'))+esc(tn)+'</span>');h+='<tr><td class="shop" title="'+esc(full)+'">'+esc(shortName(c.client,c.rep))+'</td><td>'+(c.account_id||'—')+'</td><td>'+(c.items||0)+'</td><td>'+st+'</td></tr>'});$('planbox').innerHTML=h+'</table>'}
// ── Авто-запис на попълненото (localStorage) — рефреш вече не трие решетката ──
var RESTORING=false;
function saveGrid(){if(RESTORING)return;try{collect();if(!shops.length){localStorage.removeItem('cex_grid');return}var ticks=[];document.querySelectorAll('#grid .selbox').forEach(function(cb){ticks[+cb.getAttribute('data-i')]=cb.checked});localStorage.setItem('cex_grid',JSON.stringify({v:1,date:$('date').value,pdate:$('pdate').value,shops:shops,ticks:ticks,ts:Date.now()}));queueDay()}catch(e){}}
var DAYT=null;function queueDay(){clearTimeout(DAYT);DAYT=setTimeout(saveDay,2500)}
function saveDay(){var pd=$('pdate').value;if(RESTORING||!pd||!shops.length||!$('tok').value)return;var ticks=[];document.querySelectorAll('#grid .selbox').forEach(function(cb){ticks[+cb.getAttribute('data-i')]=cb.checked});api({action:'save_day',date:pd,grid:{v:1,date:$('date').value,pdate:pd,shops:shops,ticks:ticks,ts:Date.now()}}).then(function(j){$('daysav').textContent=(j&&j.ok)?('💾 записано '+new Date().toLocaleTimeString('bg-BG',{hour:'2-digit',minute:'2-digit'})):'⚠ не е записано'}).catch(function(){$('daysav').textContent='⚠ не е записано'})}
function openDay(){var pd=$('pdate').value;if(!pd){msg('Избери дата в „Партида".','err');return}msg('Отварям записа за '+pd+'…');api({action:'load_day',date:pd}).then(function(j){if(!j.ok){msg('Грешка: '+(j.message||j.error||''),'err');return}var g=j.grid;if(!g||!g.shops||!g.shops.length){msg('Няма запис за '+pd+'.','err');return}RESTORING=true;shops=g.shops;if(g.date)$('date').value=g.date;updLabs();renderGrid();if(g.ticks)document.querySelectorAll('#grid .selbox').forEach(function(cb){var i=+cb.getAttribute('data-i');if(g.ticks[i]===false)cb.checked=false;else if(g.ticks[i]===true)cb.checked=true});syncRows();RESTORING=false;LASTACC=shops.filter(function(x){return x.account_id}).map(function(x){return x.account_id});var n=Object.keys(j.accounts||{}).length;msg('📂 Отворен записът за '+pd+': '+shops.length+' магазина, '+n+' със сметка.','ok')}).catch(function(e){RESTORING=false;msg('Мрежова грешка: '+e,'err')})}
function restoreGrid(){try{var raw=localStorage.getItem('cex_grid');if(!raw)return;var st=JSON.parse(raw);if(!st||!Array.isArray(st.shops)||!st.shops.length)return;RESTORING=true;shops=st.shops;if(st.date)$('date').value=st.date;if(st.pdate&&st.pdate>=new Date().toISOString().slice(0,10))$('pdate').value=st.pdate;updLabs();renderGrid();if(Array.isArray(st.ticks))document.querySelectorAll('#grid .selbox').forEach(function(cb){var i=+cb.getAttribute('data-i');if(st.ticks[i]===true)cb.checked=true;else if(st.ticks[i]===false)cb.checked=false});syncRows();LASTACC=shops.filter(function(s){return s.account_id}).map(function(s){return s.account_id});RESTORING=false;var d=st.ts?new Date(st.ts):null;msg('↩ Върнах попълненото'+(d?(' от '+d.toLocaleString('bg-BG')):'')+'.','ok')}catch(e){RESTORING=false}}
$('grid').addEventListener('input',saveGrid);$('grid').addEventListener('change',saveGrid);
$('date').addEventListener('change',saveGrid);$('pdate').addEventListener('change',saveGrid);
restoreGrid();
</script></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  if (req.method === "GET" && q.view) { const _send = res.send.bind(res); res.send = (html) => _send(withHome(q, html)); }
  const view = q.view;

  // 1) Страница за собственика (само UI shell; данните искат токен през POST).
  if (req.method === "GET" && view === "tool") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(toolPage());
    return;
  }

  // ── ВЪТРЕШЕН ХЪБ: двата дашборда (Цех + Точка) на едно място, таб-ове ──
  if (req.method === "GET" && view === "reports") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:24px'>Няма достъп — липсва или грешен ключ (?k=).</body>"); return; }
    res.status(200).send(reportsHubPage(q.k));
    return;
  }

  // ★ S31 — МАРШРУТИ НА ШОФЬОРА: собственикът подрежда обектите със стокова по маршрути (2 клика), ботът ги ползва.
  if (req.method === "GET" && view === "routes") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:24px'>Няма достъп — липсва или грешен ключ (?k=).</body>"); return; }
    res.status(200).send(routesPage(q.k, /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : sofiaToday()));
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
    const today = sofiaToday();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : today.slice(0, 4) + "-01-01"; // по подразбиране от 1 януари
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : today;
    // Фиксирани разходи (бруто заплати от 01.2026) — авто за периода; ?exp= ги замества ръчно.
    // ★ S31 — по РЕАЛНИТЕ ведомости по месеци (lib/payroll.js); ?exp= ги замества ръчно.
    const fx = PAYROLL.fixedFor("cex", from, to);
    const expenses = (q.exp !== undefined && q.exp !== "") ? (Number(q.exp) || 0) : fx.total;
    let data;
    try { data = await dashData(from, to, expenses, user, pass); }
    catch (e) { data = { from, to, error: "Не мога да прочета данните сега. Опитай пак след минута. (" + String(e && e.message) + ")" }; }
    if (!data.error) data.fixed = { ...fx, auto: !(q.exp !== undefined && q.exp !== "") };
    res.status(200).send(dashboardPage(data, q.k));
    return;
  }

  if (req.method === "GET" && view === "today") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send(todayPage(`<div class="wrap"><h2>Няма достъп</h2><p>Липсва или грешен ключ в линка.</p></div>`)); return; }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).send(todayPage(`<div class="wrap">Не е конфигуриран достъп до цеха.</div>`)); return; }
    // ПРЕДИМСТВО на записаното от „Изчисли" (собственикът маркира/коригира → пази се).
    // Ако няма запис — fallback към сметките (както преди). ?date= задава изрично ден.
    const reqDate = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : null;
    let snap = null;
    try { snap = await sbGetPlan(reqDate); } catch (e) {}
    // ИСТИНАТА за деня са СМЕТКИТЕ (от тях тръгват стоковите). Снимката от „Изчисли" е
    // само последната решетка на собственика — ако сметките са правени на два пъти
    // (снощи + сутринта) или количествата са сменени след „Изчисли", тя се разминава със
    // стоковите (10.09: 8 обекта/33 ТОКЕ в снимката срещу 10 сметки/56 ТОКЕ). Затова:
    // обект СЪС сметка → по сметката; обект от снимката БЕЗ сметка → по снимката.
    let seed, date, fromSnap = false, snapTime = null, extraSnap = 0;
    const snapShops = (snap && Array.isArray(snap.shops)) ? snap.shops : [];
    date = reqDate || (snapShops.length && snap.for_date) || isoPlusDays(sofiaToday(), 1);
    let real = null;
    try { real = await seedRazos(date, user, pass, true); } catch (e) { real = null; }
    // Само ОТВОРЕНИТЕ (текущия батч за правене) — затворените вече са разнесени/готови и
    // не са „за производство". Така „По маршрут" съвпада с картите за производство. (S21)
    if (real && Array.isArray(real.shops)) { real.shops = real.shops.filter(sh => !sh.close_date); real.accounts = real.shops.length; }
    // Сметка, направена ВЧЕРА сутринта за ВЧЕРАШНИЯ разнос (и още отворена), не е за днес:
    // ако вече има стокова от вчера (клиент+сума, както „С" в инструмента) — вън.
    if (real && real.shops.length) {
      try {
        const prevD = isoPlusDays(date, -1), prev2 = isoPlusDays(date, -2);
        const r = await cexCall("Invoices_getlist", { order_by: "inv_id desc", length: 300 }, user, pass);
        let inv = r.data; inv = Array.isArray(inv) ? inv : Object.values(inv || {});
        const stok = {};
        for (const x of inv) {
          if (String(x.type_id) !== "11" || String(x.is_anulate) === "1") continue;
          const cd = String(x.create_date || "").slice(0, 10);
          if (cd !== prevD && cd !== prev2) continue;
          (stok[x.client_id] = stok[x.client_id] || []).push(Number(x.total_all) || 0);
        }
        real.shops = real.shops.filter(sh => {
          if (sh.create_date !== prevD || sh.close_date) return true;
          const arr = stok[sh.client_id]; if (!arr || !arr.length) return true;
          const i = arr.findIndex(t => Math.abs(t - (sh.total || 0)) < 0.05);
          if (i < 0) return true; arr.splice(i, 1); return false;
        });
        real.accounts = real.shops.length;
      } catch (e) {}
    }
    if (real && real.shops.length) {
      const have = new Set(real.shops.map(cexKey));
      const extra = snapShops.filter(s => !have.has(cexKey(s))).map(s => ({ ...s, group: s.group || ((cexObj(s) || {}).group) || "adhoc" }));
      extraSnap = extra.length;
      seed = { shops: real.shops.concat(extra), accounts: real.shops.length };
      fromSnap = extraSnap > 0; snapTime = snap && snap.updated_at || null;
    } else if (snapShops.length) {
      seed = { shops: snapShops.map(s => ({ ...s, group: s.group || ((cexObj(s) || {}).group) || "adhoc" })), accounts: snapShops.length };
      fromSnap = true; snapTime = snap.updated_at || null;
    } else if (real) {
      seed = real;
    } else { res.status(200).send(todayPage(`<div class="wrap"><h2>Грешка</h2><p>Не мога да прочета сметките сега. Опитай пак след минута.</p></div>`)); return; }
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
    // Момичетата трябва да виждат КОЛКО ДА ПРОИЗВЕДАТ (нето, след наличното), не
    // общо поръчаното. Нетото се записва при „Изчисли" в снимката (snap.produce).
    // Има снимка → показваме нея; иначе fallback към общо поръчаното (докато не е смятал).
    const prod = (snap && snap.produce && typeof snap.produce === "object") ? snap.produce : null;
    const pSets = (prod && prod.sets) || {}, pRolls = (prod && prod.rolls) || {}, pZag = (prod && prod.zagotovki) || {};
    const haveProd = !!(Object.keys(pSets).length || Object.keys(pRolls).length || Object.keys(pZag).length);
    const empty = !haveProd && !Object.keys(rolls).length && !Object.keys(sets).length;
    const prodCards = haveProd
      ? `${card("sets", "Сетове · за производство", pSets)}${card("rolls", "Ролки / поке · за производство", pRolls)}${card("zag", "Заготовки · за производство", pZag)}`
      : `${card("sets", "Сетове (общо поръчани)", sets)}${card("rolls", "Ролки / поке (общо поръчани)", rolls)}${card("zag", "Заготовки (общо поръчани)", zag)}`;
    res.status(200).send(todayPage(`
      <header><h1>🍣 Цех · за производство ${esc(date)}</h1><div class="d">${real && real.shops.length ? `по сметките (${seed.accounts})${extraSnap ? ` + ${extraSnap} по въведеното` : ""} · ` : (fromSnap ? "по въведеното от собственика · " : "")}${seed.shops.length} магазина · обновено ${esc(sofiaTime())}</div></header>
      <div class="wrap">${empty
        ? `<div class="empty"><h2>Още няма план за ${esc(date)}</h2><p>Когато собственикът натисне „Изчисли", тук се показва колко да произведете.<br>Страницата се обновява сама.</p></div>`
        : `${prodCards}${routeCard}
        <div class="note">${haveProd ? "Числата са КОЛКО ДА ПРОИЗВЕДЕТЕ (след наличното в хладилника)." : "⚠ Още не е смятано днес — показано е ОБЩО поръчаното."} · „По маршрут" = продуктите за всеки град (за пакетиране) · обновява се на всеки 3 минути</div>`}</div>`));
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

  // ── ★ S32 — формата за заявка на магазин (без собственически токен; ключ по обект) ──
  if (req.method === "GET" && view === "zayavka") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const key = q.s ? formKeyFromSlug(q.s) : (formAuth(q.o, q.k) ? String(q.o) : null);   // кратък адрес (s) или пълен (o+k)
    if (!key) { res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:17px system-ui;padding:24px'>Линкът не е валиден. Поискай нов от MOTAMO.</body>"); return; }
    res.status(200).send(zayavkaPage(key, formToken(key)));
    return;
  }

  // 3) JSON изчисление (POST от страницата, или GET със seed_date). Токен-гейт.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};
  // ★ S32 — публичните действия на формата: удостоверени с ключа на обекта, не с токен.
  if (body.action === "shop_form_data" || body.action === "shop_form_send") {
    if (!formAuth(body.o, body.k)) { res.status(403).json({ ok: false, error: "forbidden" }); return; }
    try {
      const out = body.action === "shop_form_data" ? { ok: true, ...(await shopFormData(String(body.o), body.date)) } : await shopFormSend(String(body.o), body);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (e) { res.status(502).json({ ok: false, error: "form_failed", message: String(e && e.message).slice(0, 200) }); }
    return;
  }
  const token = body.token != null ? body.token : q.token;
  // Пишещите действия искат силен токен; „stock" е само четене → и CEX_VIEW_TOKEN.
  const strong = [process.env.RECONCILE_TOKEN, process.env.PAY_HMAC_SECRET, process.env.PREVIEW_TOKEN];
  // Само ПИШЕЩИТЕ действия искат силен токен; четенето/смятането приемат и четящия.
  const writeActions = ["tg_send_plan", "create_accounts", "produce_plan", "create_production", "create_stokova", "replace_account", "create_load"];
  // create_stokova/replace_account с dry само СГЛОБЯВАТ (не записват) → приемат и четящия токен.
  // replace_account е DRY по подразбиране (пише само при изричен dry:false).
  const isWrite = writeActions.includes(body.action)
    && !(body.action === "create_stokova" && body.dry === true)
    && !(body.action === "replace_account" && body.dry !== false)
    && !(body.action === "create_load" && body.dry !== false);
  // route_plan_save пише само в нашата таблица с маршрути (не в Barsy) → приема и четящия токен.
  const allowed = isWrite ? strong : strong.concat([process.env.CEX_VIEW_TOKEN]);
  const okJson = allowed.some(t => t && token === t);
  if (!okJson) { res.status(403).json({ ok: false, error: "forbidden" }); return; }

  // ── ★ S32 — заявките от формата за деня (таб „📥 Заявки" в инструмента) ──
  if (body.action === "shop_requests") {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    try { res.status(200).json({ ok: true, ...(await shopRequestsFor(date, req.headers && req.headers.host)) }); }
    catch (e) { res.status(502).json({ ok: false, error: "requests_failed", message: String(e && e.message).slice(0, 200) }); }
    return;
  }
  if (body.action === "shop_request_applied") {
    const id = Number(body.id); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
    try { await sbReq(`cex_shop_requests?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ applied_at: new Date().toISOString(), applied_rows: Array.isArray(body.applied_rows) ? body.applied_rows : [] }) }); res.status(200).json({ ok: true }); }
    catch (e) { res.status(502).json({ ok: false, error: "patch_failed", message: String(e && e.message).slice(0, 200) }); }
    return;
  }

  // ── ДИАГНОСТИК (само четене): записаната „Изчисли" снимка (за кухнята) ──
  if (body.action === "snapshot") {
    let snap = null;
    try { snap = await sbGetPlan(/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : null); } catch (e) {}
    if (!snap) { res.status(200).json({ ok: true, snapshot: null }); return; }
    const shops = Array.isArray(snap.shops) ? snap.shops : [];
    const art = body.article || null; // ако е зададено — разбивка по обект за този артикул
    let breakdown = null, artTotal = 0;
    if (art) { breakdown = []; for (const s of shops) { const v = (s.order || {})[art] || 0; if (v > 0) { artTotal += v; breakdown.push({ obj: (s.client || "") + (s.rep ? (" / " + s.rep) : ""), group: s.group || "adhoc", qty: v }); } } breakdown.sort((a, b) => b.qty - a.qty); }
    res.status(200).json({ ok: true, for_date: snap.for_date, updated_at: snap.updated_at, shops_count: shops.length, produce: snap.produce || null, article: art, article_total: artTotal, breakdown });
    return;
  }

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

  // ── Списък на ВСИЧКИ обекти от регистъра (за бутона „+ Магазин") ──
  // Връща по един ред на обект (client_id:person_id от CEX_OBJECTS) с име, за да
  // може собственикът да добави магазин, който днешният разнос не е заредил.
  if (body.action === "list_objects") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const r = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 2000 }, user, pass);
    let all = r.data || []; if (!Array.isArray(all)) all = Object.values(all);
    const byKey = {};
    for (const a of all) {
      if (String(a.account_alias || "").includes("CLTEST") || isTrialClient(a)) continue;
      const key = cexKey(a);
      if (!CEX_OBJECTS[key] || byKey[key]) continue; // подредено по account_id desc → първата е най-скорошната
      byKey[key] = { key, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null,
        rep: a.person_name || null, group: (CEX_OBJECTS[key] || {}).group || "adhoc",
        last: String(a.close_date || a.create_date || "").slice(0, 10) };
    }
    // ★ S28 — обект от регистъра БЕЗ нито една сметка (нов представител) иначе никога не се появява
    for (const [key, o] of Object.entries(CEX_OBJECTS)) {
      if (byKey[key] || !o.rep) continue;
      const [c, p] = key.split(":");
      byKey[key] = { key, client_id: Number(c), person_id: p ? Number(p) : null, client: o.client || null, rep: o.rep, group: o.group || "adhoc", last: "" };
    }
    const objects = Object.values(byKey).sort((x, y) =>
      (x.client || "").localeCompare(y.client || "", "bg") || (x.rep || "").localeCompare(y.rep || "", "bg"));
    res.status(200).json({ ok: true, count: objects.length, objects });
    return;
  }

  // ── ДИАГНОСТИК (само четене): продажби по артикул за период (за анализ) ──
  // body: {from:"YYYY-MM-DD", to:"YYYY-MM-DD"}. Връща на артикул: бройки, оборот
  // без ДДС, себестойност без ДДС, печалба, маржин%. Нетна справка (Barsy).
  if (body.action === "sales_articles") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || "") ? body.from : "2026-03-01";
    const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || "") ? body.to : sofiaToday();
    let rep;
    try { rep = await reportSalesByArticles(from, to, user, pass, body.client != null ? Number(body.client) : undefined); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    const arts = (rep.articles || []).map(a => {
      const profit = a.revenue - a.cost;
      return { id: a.article_id, name: a.name, cat: (ARTS[String(a.article_id)] || {}).cat || null,
        units: Math.round(a.units * 1000) / 1000, revenue: Math.round(a.revenue * 100) / 100,
        cost: Math.round(a.cost * 100) / 100, profit: Math.round(profit * 100) / 100,
        margin_pct: a.revenue > 0 ? Math.round((profit / a.revenue) * 1000) / 10 : null };
    }).sort((x, y) => y.units - x.units);
    const tot = arts.reduce((s, a) => { s.units += a.units; s.revenue += a.revenue; s.cost += a.cost; s.profit += a.profit; return s; }, { units: 0, revenue: 0, cost: 0, profit: 0 });
    res.status(200).json({ ok: true, from, to, incomplete: rep.incomplete, count: arts.length,
      totals: { units: Math.round(tot.units * 1000) / 1000, revenue: Math.round(tot.revenue * 100) / 100, cost: Math.round(tot.cost * 100) / 100, profit: Math.round(tot.profit * 100) / 100 },
      articles: arts });
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
        }))
        // Стоковата разписка е само за СТОКИ: махни не-стоковите редове (напр. „Авансово
        // плащане - ф. №…"), които идват с празен article_id — иначе се праща ред без
        // партида/артикул и замърсява/чупи документа.
        .filter(r => r.article_id && r.article_id !== "");
      }
    } catch (e) { rowsRaw = { error: String(e && e.message) }; }
    let paymethodOpts = null;
    (function w(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(w); if (n.name === "paymethod_id" && n.data_source) paymethodOpts = n.data_source; for (const k in n) w(n[k]); })(inner);
    const payload = { Invoices_create: { id: null, action_type: "save", values, rows } };
    if (body.dry === true) { res.status(200).json({ ok: true, dry: true, account_id: acc, rows_count: rows.length, paymethod_options: paymethodOpts, payload, rows_raw_sample: JSON.stringify(rowsRaw).slice(0, 300) }); return; }
    // Защита: не създавай ПРАЗНА стокова (0 реда) — иначе излиза документ без стоки.
    if (!rows.length) { res.status(200).json({ ok: false, account_id: acc, rows_count: 0, error: "стоковата е празна (0 реда) — сметката няма продукти или редовете не се прочетоха; не създавам празен документ" }); return; }
    const cr = await cexCallRoot(payload, user, pass);
    const invId = cr.data && (cr.data.Invoices_create || (cr.data.data && cr.data.data.inv_id)) || null;
    res.status(200).json({ ok: !!cr.ok, account_id: acc, rows_count: rows.length, inv_result: cr.data, error: cr.ok ? undefined : String(cr.raw || "").slice(0, 400) });
    return;
  }

  // ── ДИАГНОСТИК за „Замести сметка" (само четене): Accounts_edit + редовете + save-метод ──
  // ── ДИАГНОСТИК (само четене): един документ за зареждане — заглавие + редове (суров формат),
  // за да се копира точният формат при създаване на зареждане от снимка на фактура. ──
  // ДИАГНОСТИК (само четене): документи (стокови/фактури/кредитни) — типове и редове.
  if (body.action === "invoices_probe") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    if (body.inv_id) {
      const out = {};
      for (const [m, p] of [["Invoices_get", { inv_id: Number(body.inv_id), id: Number(body.inv_id) }], ["Invoices_getitems", { inv_id: Number(body.inv_id) }], ["Invoiceitems_getlist", { filters: { inv_id: Number(body.inv_id) } }]]) {
        try { const r = await cexCall(m, p, user, pass); out[m] = String(r.raw || "").slice(0, 30000); } catch (e) { out[m] = "ERR " + e.message; }
      }
      res.status(200).json({ ok: true, out }); return;
    }
    const r = await cexCall("Invoices_getlist", { order_by: "inv_id desc", length: Number(body.length) || 60, extra_properties: body.details ? ["all", "details"] : undefined }, user, pass);
    let L = r.data || []; if (!Array.isArray(L)) L = Object.values(L);
    const types = {}; for (const x of L) { const k = String(x.type_id) + " " + (x.type_name || x.doc_type_name || ""); types[k] = (types[k] || 0) + 1; }
    const pick = L.filter(x => !body.type || String(x.type_id) === String(body.type)).slice(0, Number(body.n) || 3);
    res.status(200).json({ ok: true, count: L.length, types, keys: L[0] ? Object.keys(L[0]) : [], sample: JSON.stringify(pick).slice(0, 6000) });
    return;
  }
  if (body.action === "load_inspect") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const lid = Number(body.id);
    const out = { ok: true, id: lid };
    if (lid) {
      try { const r = await cexCallRoot({ Storeloads_edit: { id: lid, store_load_id: lid, params: { bid: 1, id: lid } } }, user, pass); out.edit = String(r.raw || JSON.stringify(r.data || null)).slice(0, 12000); } catch (e) { out.edit_err = String(e && e.message); }
    }
    if (body.supplier) {
      try { const r = await cexCall("Suppliers_getlist", { length: 500 }, user, pass); let L = r.data || []; if (!Array.isArray(L)) L = Object.values(L); const q = String(body.supplier).toLowerCase(); out.suppliers = L.filter(x => JSON.stringify(x).toLowerCase().includes(q)).slice(0, 10); out.suppliers_total = L.length; } catch (e) { out.sup_err = String(e && e.message); }
    }
    res.status(200).json(out);
    return;
  }
  // ★ S24 — ЗАРЕЖДАНЕ ОТ СНИМКА НА ФАКТУРА. Редовете идват вече в БАЗОВА мярка (кг/л/бр) и
  // цена БЕЗ ДДС (превръщането от бр/пакети е моя работа при четенето — виж паметта
  // supplier-doc-units). По подразбиране: dry (само сглобява) ; draft:true = чернова (собственикът
  // я преглежда и сам натиска „вкарай в склада"); draft:false = вкарва директно.
  // Гард срещу двойно: отказва, ако вече има зареждане със същия doc_num.
  if (body.action === "create_load") {
    // host:"shop" → Barsy на ТОЧКАТА (Каравелов, motamoshop); иначе цехът. Артикулите на
    // точката имат СВОИ id-та → там името идва от реда (r.name), не от данните на цеха.
    const SHOP = body.host === "shop";
    const user = SHOP ? process.env.BARSY_USER : process.env.BARSY_CEX_USER, pass = SHOP ? process.env.BARSY_PASS : process.env.BARSY_CEX_PASS;
    const BASE = SHOP ? "https://motamoshop.barsy.online" : CEX_API;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "not_configured" }); return; }
    const rowsIn = Array.isArray(body.rows) ? body.rows : [];
    const docNum = String(body.doc_num || "").trim();
    const docDate = /^\d{4}-\d{2}-\d{2}$/.test(body.doc_date || "") ? body.doc_date : sofiaToday();
    if (!rowsIn.length || !docNum) { res.status(400).json({ ok: false, error: "rows_and_doc_num_required" }); return; }
    // доставчик по id или по част от името
    let supplierId = Number(body.supplier_id) || null, supplierName = null;
    try {
      const r = await cexCall("Suppliers_getlist", { length: 500 }, user, pass, BASE); let L = r.data || []; if (!Array.isArray(L)) L = Object.values(L);
      const hit = supplierId ? L.find(x => Number(x.supplier_id) === supplierId) : L.find(x => String(x.supplier_name || "").toLowerCase().includes(String(body.supplier || "").toLowerCase()) && body.supplier);
      if (hit) { supplierId = Number(hit.supplier_id); supplierName = hit.supplier_name; }
    } catch (e) {}
    if (!supplierId) { res.status(200).json({ ok: false, error: "supplier_not_found", supplier: body.supplier || null }); return; }
    // двойно?
    try {
      const hr = await cexCall("Storeloads_getlist", { length: 300, order_by: "store_load_id desc", extra_properties: ["all"] }, user, pass, BASE);
      let H = hr.data || []; if (!Array.isArray(H)) H = Object.values(H);
      const dup = H.find(h => String(h.doc_num || "").trim() === docNum && Number(h.supplier_id) === supplierId);
      if (dup) { res.status(200).json({ ok: false, error: "already_loaded", store_load_id: dup.store_load_id }); return; }
    } catch (e) {}
    const TAX = 20, TAX_ID = "2"; // 20% (Б)
    let net = 0; const rows = [], bad = [];
    for (const r of rowsIn) {
      const a = SHOP ? (Number(r.article_id) > 0 && r.name ? { id: Number(r.article_id), name: String(r.name) } : null) : byId(Number(r.article_id)); const q = Number(r.amount), pr = Number(r.price);
      if (!a || !(q > 0) || !(pr >= 0)) { bad.push(r); continue; }
      const tot = Math.round(q * pr * 100) / 100; net += tot;
      rows.push({ store_load_row_id: "", article_id: String(a.id), original_article_name: a.name, amount: String(q),
        current_price: String(pr), delivery_price: String(pr), delivery_total: String(tot),
        delivery_tax_id: TAX_ID, actual_tax_id: TAX_ID, tax: String(TAX), tax_sum: String(Math.round(tot * TAX) / 100),
        discount: "0", lot_value: String(r.lot || ""), lot_exp_date: r.lot_exp || null, lot_detail_id: "",
        notes: String(r.notes || ""), amount_unit: "1", is_group_art: 0 });
    }
    if (bad.length) { res.status(400).json({ ok: false, error: "bad_rows", bad }); return; }
    net = Math.round(net * 100) / 100;
    const draft = body.draft !== false;
    const payload = { Storeloads_save: { id: null, action_type: draft ? "save" : "save_and_close", values: {
      store_load_id: null, operation_type: "1", depot_id: String(SHOP ? 1 : CEX_DEPOT), doc_type_id: String(body.doc_type_id || "1"),
      doc_date: docDate + " 00:00:00", doc_num: docNum, supplier_id: String(supplierId), has_tax: 1, price_mode: 0, fill_delivery_price: 0,
      currency_id: "1", currency_rate: "1", store_load_cat_id: "1", discount: "0", total_costs: 0,
      description: String(body.description || ("Заредено от снимка на документа (" + (supplierName || "") + " № " + docNum + ")"))
    }, rows } };
    const summary = { host: SHOP ? "точка" : "цех", supplier: supplierName, supplier_id: supplierId, doc_num: docNum, doc_date: docDate, net, vat: Math.round(net * TAX) / 100, rows: rows.map(r => ({ name: r.original_article_name, amount: Number(r.amount), price: Number(r.delivery_price), total: Number(r.delivery_total) })) };
    if (body.dry !== false) { res.status(200).json({ ok: true, dry: true, draft, ...summary }); return; }
    const sv = await cexCallRoot(payload, user, pass, BASE);
    let lid = null, status = null, total = null;
    try {
      const hr = await cexCall("Storeloads_getlist", { length: 5, order_by: "store_load_id desc", extra_properties: ["all"] }, user, pass, BASE);
      let H = hr.data || []; if (!Array.isArray(H)) H = Object.values(H);
      const last = H.find(h => String(h.doc_num || "").trim() === docNum);
      if (last) { lid = last.store_load_id; status = last.status; total = last.total_sum; }
    } catch (e) {}
    res.status(200).json({ ok: !!lid, draft, store_load_id: lid, status, total_sum: total, ...summary, raw: lid ? undefined : String(sv.raw || "").slice(0, 500) });
    return;
  }
  if (body.action === "account_inspect") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const acc = Number(body.account_id); if (!acc) { res.status(400).json({ ok: false, error: "no_account_id" }); return; }
    const load = await cexCallRoot({ Accounts_edit: { account_id: acc, params: { bid: 1 } } }, user, pass);
    const inner = load.data && load.data.Accounts_edit;
    if (!inner) { res.status(502).json({ ok: false, error: "load_failed", raw: String(load.raw || "").slice(0, 400) }); return; }
    const content = Array.isArray(inner.content) ? inner.content : [];
    const actions = [];
    (function w(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(w); if (n.type === "action" && n.target) actions.push({ target: n.target, title: n.title, active_struct_id: n.active_struct_id || null }); for (const k in n) w(n[k]); })(inner);
    const gridBlock = content.find(c => c && c.type === "eStructListForm");
    const gridId = gridBlock && gridBlock.id;
    let rowsInfo = null, tgt = gridBlock && gridBlock.data && gridBlock.data.data_source && gridBlock.data.data_source.target;
    let forcedInfo = null, rawSample = null;
    const findRows = (node) => { let best = null; (function w(x) { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { if (x.length && x[0] && typeof x[0] === "object" && (x[0].article_id != null || x[0].item_id != null || x[0].row_id != null || x[0].order_id != null)) { if (!best || x.length > best.length) best = x; } return x.forEach(w); } for (const k in x) w(x[k]); })(node); return best || []; };
    if (tgt) {
      try {
        const rr = await cexCallRoot(tgt, user, pass);
        rawSample = String(rr.raw || "").slice(0, 1200);
        const rws = findRows(rr.data);
        rowsInfo = { count: rws.length, keys: rws[0] ? Object.keys(rws[0]) : [], first: rws[0] || null, second: rws[1] || null };
      } catch (e) { rowsInfo = { error: String(e && e.message) }; }
      // Опит с force_data_request — гридовете връщат само id-та, докато не поискаш данните.
      try {
        const mk = Object.keys(tgt)[0];
        const forced = JSON.parse(JSON.stringify(tgt));
        if (mk && forced[mk] && typeof forced[mk] === "object") {
          forced[mk].force_data_request = true;
          forced[mk].params = Object.assign({}, forced[mk].params, { force_data_request: true, bid: CEX_BID });
        }
        const fr = await cexCallRoot(forced, user, pass);
        const frows = findRows(fr.data);
        forcedInfo = { method: mk, sent: forced[mk], raw: String(fr.raw || "").slice(0, 1500), count: frows.length, keys: frows[0] ? Object.keys(frows[0]) : [], first: frows[0] || null, second: frows[1] || null };
      } catch (e) { forcedInfo = { error: String(e && e.message) }; }
    }
    const fields = []; (function w(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(w); if (typeof n.name === "string" && Object.prototype.hasOwnProperty.call(n, "value")) fields.push(n.name); for (const k in n) if (k !== "data_source" && k !== "elements" && k !== "tax_groups_by_country" && k !== "all_tax_groups" && k !== "countries") w(n[k]); })(inner);
    res.status(200).json({ ok: true, account_id: acc, page_title: inner.page_title || inner.object_title, top_keys: Object.keys(inner), grid_id: gridId, active_struct_id: inner.active_struct_id || (gridBlock && gridBlock.data && gridBlock.data.active_struct_id) || null, actions: actions.slice(0, 20), grid_target: tgt || null, rows: rowsInfo, rows_raw: rawSample, forced: forcedInfo, header_fields: Array.from(new Set(fields)).slice(0, 80) });
    return;
  }

  // ── ЗАМЕСТИ СМЕТКА (делта запис): чете текущите редове + шапката, смята делти
  //    (target − current) и сглобява „Accounts_save". DRY по подразбиране (не пише).
  //    Протоколът е разкодиран от Network на adminx (S20) — виж memory motamo-cex-api-map:
  //    в записа `amount` е ДЕЛТА, не абсолютно; праща се само променéният ред с order_id.
  //    target: { "<article_id|име>": <абсолютно к-во> | {amount, price, lot} }.
  //    Пише само при изричен dry:false (иначе връща `save_body` за преглед). РИСКОВО на реална.
  if (body.action === "replace_account") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const acc = Number(body.account_id); if (!acc) { res.status(400).json({ ok: false, error: "no_account_id" }); return; }
    const dry = body.dry !== false; // по подразбиране DRY
    const closeIt = body.close === true;
    const targetIn = (body.target && typeof body.target === "object") ? body.target : null;
    if (!targetIn) { res.status(400).json({ ok: false, error: "no_target" }); return; }
    // 1) шапката (values) от страницата на сметката
    let page; try { page = await cexCallRoot({ accounts_edit: { id: acc, params: { bid: CEX_BID } } }, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    const inner = page.data && page.data.accounts_edit;
    if (!inner) { res.status(502).json({ ok: false, error: "page_load_failed", raw: String(page.raw || "").slice(0, 300) }); return; }
    const fmap = {};
    (function w(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(w);
      if (typeof n.name === "string" && Object.prototype.hasOwnProperty.call(n, "value")) fmap[n.name] = n.value;
      for (const k in n) if (k !== "data_source" && k !== "elements" && k !== "tax_groups_by_country" && k !== "all_tax_groups" && k !== "countries") w(n[k]); })(inner);
    const gv = (k, d) => (fmap[k] !== undefined && fmap[k] !== null ? fmap[k] : d);
    const values = {
      user_id: gv("user_id", null), user_name: gv("user_name", ""), place_id: gv("place_id", "1"),
      ref_date: gv("ref_date", null), client_id: gv("client_id", null), client_name: gv("client_name", ""),
      deal_id: gv("deal_id", null), deal_title: gv("deal_title", ""), discount: gv("discount", "0"),
      person_id: gv("person_id", null), person_name: gv("person_name", ""), lang_id: gv("lang_id", "bg_BG"),
      delivery_date: gv("delivery_date", null), currency_id: gv("currency_id", "1"),
      account_alias: gv("account_alias", ""), description: gv("description", ""), notes: gv("notes", ""),
      delivery_address: { delivery_type: "no", delivery_type_title: "Без доставка" },
      phone: gv("phone", ""), speditor_id: gv("speditor_id", null), tracking_number: gv("tracking_number", null),
      reason_id: gv("reason_id", null), currency_rate: gv("currency_rate", "1"), paymethod_id: gv("paymethod_id", null),
      skip_account_discount_recalculate_flag: null, linked_accounts: ""
    };
    // 2) текущите редове
    let rr; try { rr = await cexCallRoot({ accounts_edit: { id: acc, action_type: "values", active_struct_id: "eStructListForm_1", params: { id: acc, bid: CEX_BID }, rows: 5000 } }, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    const curRows = (rr.data && rr.data.accounts_edit && Array.isArray(rr.data.accounts_edit.rows)) ? rr.data.accounts_edit.rows : [];
    const curByArt = {}; for (const r of curRows) curByArt[String(r.article_id)] = r;
    // 3) нормализирай target → article_id → {amount, price?, lot?}
    const tgt = {};
    for (const [k, v] of Object.entries(targetIn)) {
      const a = resolve(k); const id = a ? String(a.id) : String(k);
      const amount = (v && typeof v === "object") ? Number(v.amount) : Number(v);
      const price = (v && typeof v === "object" && v.price != null) ? Number(v.price) : null;
      const lot = (v && typeof v === "object" && v.lot != null) ? String(v.lot) : null;
      if (isNaN(amount) || amount < 0) continue;
      tgt[id] = { amount, price, lot };
    }
    // 4) делти (target − current); премахнат = делта до 0; нов = +target (иска цена)
    const saveRows = [], needPrice = [], plan = [];
    const ids = new Set([...Object.keys(curByArt), ...Object.keys(tgt)]);
    for (const id of ids) {
      const cur = curByArt[id]; const curAmt = cur ? Number(cur.amount) : 0;
      const want = tgt[id] ? tgt[id].amount : 0;
      const delta = round(want - curAmt);
      if (delta === 0) continue;
      const art = byId(id);
      const name = (cur && cur.article_name) || (art && art.name) || String(id);
      let price = cur ? Number(cur.current_price) : (tgt[id] && tgt[id].price != null ? tgt[id].price : null);
      if (price == null || isNaN(price)) { needPrice.push({ article_id: id, name, want }); plan.push({ article_id: id, name, current: curAmt, target: want, delta, note: "нужна цена (нов артикул)" }); continue; }
      const row = {
        article_name: name, article_id: String(id), amount: delta,
        package_name: "", package_ratio: "",
        current_price: price.toFixed(2), original_current_price: price.toFixed(2),
        system_current_price: cur ? String(cur.system_current_price) : String(price),
        discount: "0", total_price: (want * price).toFixed(2),
        tax_id: cur ? String(cur.tax_id) : String(gv("tax_id", "2")),
        depot_id: cur ? String(cur.depot_id) : String(CEX_DEPOT),
        delivery_price: cur ? String(cur.delivery_price) : "0",
        lot_value: cur ? (cur.lot_value || "") : ((tgt[id] && tgt[id].lot) || ""),
        start_service_date: "", currency_id: cur ? String(cur.currency_id) : "1",
        pricelist_id: cur ? String(cur.pricelist_id) : "3"
      };
      if (cur) row.order_id = cur.order_id; // съществуващ ред → носи order_id
      saveRows.push(row); plan.push({ article_id: id, name, current: curAmt, target: want, delta });
    }
    const saveBody = { Accounts_save: { id: acc, action_type: closeIt ? "save_and_close" : "save_and_continue", values, rows: saveRows } };
    const out = { ok: true, account_id: acc, dry, client: values.client_name, alias: values.account_alias,
      current: curRows.map(r => ({ article_id: r.article_id, name: r.article_name, amount: r.amount, lot: r.lot_value })),
      plan, need_price: needPrice, rows_to_save: saveRows.length, save_body: saveBody };
    if (dry) { res.status(200).json(out); return; }
    if (needPrice.length) { res.status(400).json({ ok: false, error: "need_price", need_price: needPrice, hint: "подай target:{<id>:{amount,price}}" }); return; }
    if (!saveRows.length) { res.status(200).json({ ok: true, account_id: acc, noop: true, message: "няма промени" }); return; }
    let wr; try { wr = await cexCallRoot(saveBody, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    out.write = { ok: wr.ok, status: wr.status, raw: String(wr.raw || "").slice(0, 400), data: wr.data };
    out.ok = !!wr.ok;
    res.status(wr.ok ? 200 : 502).json(out);
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

  // ── ИЗТЕГЛИ СМЕТКИ за ③ Стокова — ПО ПАРТИДА L.<дата> (замени date-базирания load_accounts,
  // защото партидата дава 100% точните сметки по стари дати чрез реалните движения).
  // Партида→сметка през справка Reports_lot_list_details (движения „AC", ref_id=сметка).
  // Предложение за поръчка: досинхронизира кеша (бюджет ~35 s) и смята за деня.
  // pending > 0 → първото пълнене не е свършило, клиентът вика пак. Не пише в Barsy.
  // ★ S25 — „📤 Прати на цеха": планът за деня отива в Telegram групата. Ботът помни
  // ВСЕКИ МАГАЗИН поотделно (Supabase `cex_tg_sent`, kind "plan", payload.shops =
  // {client:person → поръчка}). Всяко „Прати" слива магазините от последното „Изчисли"
  // в пратените (нов магазин се добавя, вече пратен — заменя поръчката си) и смята
  // общото наново (compute е линеен). Първо = целият план; после = ДОПЪЛНЕНИЕ (+N → общо)
  // и ОБЩО. Така работи и когато собственикът смята само новите магазини.
  if (body.action === "tg_send_plan") {
    const NL = "\n";
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    const snap = await sbGetPlan(date).catch(() => null);
    if (!snap || String(snap.for_date).slice(0, 10) !== date) {
      res.status(200).json({ ok: false, error: "no_plan", message: "Няма изчислен план за " + date + " — натисни «Изчисли» с тази дата в «Партида»." }); return;
    }
    const keyOf = s => (s.client_id != null ? s.client_id : "") + ":" + (s.person_id != null ? s.person_id : "") + (s.client_id == null ? "|" + (s.client || "") + "|" + (s.rep || "") : "");
    const flat = shopMap => {
      const list = Object.values(shopMap);
      const { agg, rolls, zag } = compute(list);
      const sets = {}; for (const [n, q] of Object.entries(agg)) { const a = resolve(n); if (a && a.is_set) sets[n] = q; }
      const groups = [["🍱 Сетове", sortObj(sets, 2)], ["🍣 Ролки / поке", sortObj(rolls, 2)], ["🥣 Заготовки", sortObj(zag, 3)]];
      const cur = {}; for (const [g, o] of groups) for (const [n, q] of Object.entries(o)) if (Number(q)) cur[g + "|" + n] = Number(q);
      return { groups, cur };
    };
    const prev = body.full ? null : await TG.sentGet("plan", date).catch(() => null);
    const pay = (prev && prev.payload) || null;
    const oldShops = (pay && pay.shops) || {};
    const merged = { ...oldShops };
    for (const s of (Array.isArray(snap.shops) ? snap.shops : [])) merged[keyOf(s)] = { client: s.client, rep: s.rep, client_id: s.client_id, person_id: s.person_id, order: s.order || {} };
    const now = flat(merged);
    // стар формат (без shops) → предишното общо е самият payload
    const oldCur = !pay ? null : (pay.shops ? flat(oldShops).cur : pay);
    const dd = date.split("-").reverse().slice(0, 2).join(".");
    const fmtQ = q => String(Math.round(q * 1000) / 1000).replace(".", ",");
    const shopsN = Object.keys(merged).length;
    // ★ S27 — ЕДИН СПИСЪК, ТРИ ЧИСЛА НА РЕД (ново · беше · общо). Преди бяха три отделни списъка
    // един под друг (добавете / вече пратено / общо) и кухнята четеше грешния. Първото пращане за
    // деня е обикновен списък; всяко следващо е номерирана ДОБАВКА.
    const soldG = shopMap => { const sets = {}, rest = {};
      for (const sh of Object.values(shopMap)) for (const [n, q] of Object.entries(sh.order || {})) { if (!Number(q)) continue; const art = resolve(n); const t = (art && art.is_set) ? sets : rest; t[n] = (t[n] || 0) + Number(q); }
      return [["🍱 Сетове", sortObj(sets, 2)], ["🍣 Ролки / поке", sortObj(rest, 2)]]; };
    const isWave = !!(pay && pay.shops && Object.keys(pay.shops).length);
    const waveN = isWave ? (Number(pay.n) || 1) + 1 : 1;
    let changed = false;
    const lines = (nowG, oldG) => {
      const oldM = {}; for (const [g, o] of (oldG || [])) oldM[g] = o || {};
      return nowG.map(([g, o]) => {
        const names = [...new Set([...Object.keys(o || {}), ...Object.keys(oldM[g] || {})])].sort();
        const rows = names.map(n => {
          const tot = Number((o || {})[n]) || 0, was = Number((oldM[g] || {})[n]) || 0, d = Math.round((tot - was) * 1000) / 1000;
          if (!isWave) return tot ? { k: 0, t: `• ${TG.escHtml(n)} — <b>${fmtQ(tot)}</b>` } : null;
          if (Math.abs(d) > 1e-9) changed = true;
          if (!tot && !was) return null;
          if (d > 1e-9) return { k: 0, t: `• ${TG.escHtml(n)}: <b>ново ${fmtQ(d)}</b> · беше ${fmtQ(was)} · общо ${fmtQ(tot)}` };
          if (d < -1e-9) return { k: 0, t: `• ${TG.escHtml(n)}: <b>по-малко ${fmtQ(-d)}</b> · беше ${fmtQ(was)} · общо ${fmtQ(tot)}` };
          return { k: 1, t: `• ${TG.escHtml(n)}: без промяна · общо ${fmtQ(tot)}` };
        }).filter(Boolean).sort((x, y) => x.k - y.k).map(x => x.t); // променените — първи
        return rows.length ? `<b>${g}</b>` + NL + rows.join(NL) : "";
      }).filter(Boolean).join(NL + NL);
    };
    const newNames = Object.keys(merged).filter(k => !oldShops[k]).map(k => merged[k].rep || merged[k].client).filter(Boolean);
    const kitchenBody = lines(now.groups, isWave ? flat(oldShops).groups : null);
    const expoBody = lines(soldG(merged), isWave ? soldG(oldShops) : null);
    if (isWave && !changed && !body.full) { res.status(200).json({ ok: true, unchanged: true, message: "Няма промяна спрямо пратеното — нищо не е изпратено." }); return; }
    // Кратко име на магазина (като в решетката): обектът, без „ул./бул./ж.к." и без пощенски код.
    const shopLabel = sh => String(sh.rep || sh.client || "").replace(/[„“”"']/g, "").replace(/^\s*(ул\.|бул\.|ж\.к\.?|жк|пл\.)\s*/i, "").replace(/,?\s*\d{4}\s+/g, ", ").replace(/\s{2,}/g, " ").trim();
    const allNames = Object.values(merged).map(shopLabel).filter(Boolean);
    const newLabels = Object.keys(merged).filter(k => !oldShops[k]).map(k => shopLabel(merged[k])).filter(Boolean);
    const head = (who, what) => isWave
      ? `${who} — ДОБАВКА №${waveN} за ${dd}</b> (общо ${shopsN} магазина)` + (newLabels.length ? NL + "➕ нови: " + TG.escHtml(newLabels.join(" · ")) : "") + NL + "всички: " + TG.escHtml(allNames.join(" · ")) + NL + `<i>първото число е НОВОТО ${what}</i>`
      : (body.full ? "🔄 ПОПРАВЕН план — важи този</b>" + NL + "<b>" : "") + `${who} — план за ${dd}</b> (${shopsN} магазина)` + NL + "магазини: " + TG.escHtml(allNames.join(" · "));
    const text = "🍳 <b>" + head("Кухня (Йорданка)", "за правене") + NL + NL + kitchenBody;
    const expoText = "🚚 <b>" + head("Експедиция (Маша)", "за товарене") + NL + NL + expoBody;
    // Таблицата „какво вижда Barsy" — ЛИЧНО на собственика (не в групата): под партидата, запазено,
    // свободно, трябва, ще произведа. Смята се за магазините от последното „Изчисли".
    let ownerText = null;
    try {
      const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
      if (user && pass) {
        const sh = (Array.isArray(snap.shops) ? snap.shops : []).map(x => ({ order: x.order || {}, client_id: x.client_id, person_id: x.person_id, client: x.client, rep: x.rep }));
        const cdp = await computeDayPlan(sh, date, lotFor(date).lot, null, false, user, pass);
        const pad = (v, n) => { const t = String(v); return t.length >= n ? t : " ".repeat(n - t.length) + t; };
        const rowsT = cdp.table.map(r => (r.name.replace("НACHI", "H.").replace("Poke ", "P.").replace("CET ", "C.") + "          ").slice(0, 9) + pad(fmtQ(r.real), 6) + pad(fmtQ(r.reserved), 6) + pad(fmtQ(r.free), 6) + pad(fmtQ(r.need), 6) + pad(fmtQ(r.produce), 6));
        const raw = Object.entries(cdp.plan.loadRaw).map(([id, q]) => ((byId(id) || {}).name || id) + " " + fmtQ(q) + (cdp.inPoint[id] ? " (в склад Точка има " + fmtQ(cdp.inPoint[id]) + ")" : ""));
        ownerText = `📊 <b>Партида ${TG.escHtml(lotFor(date).lot)}</b> — какво вижда Barsy` + NL
          + `магазини в „Изчисли": ${sh.length} (със сметка: ${cdp.withAccount})` + NL
          + "<pre>" + TG.escHtml("артикул   под п. запаз  своб трябва правя" + NL + rowsT.join(NL)) + "</pre>"
          + (raw.length ? NL + "⚠️ <b>Липсват суровини:</b> " + TG.escHtml(raw.join("; ")) : NL + "✓ Суровините стигат.")
          + (cdp.stale.length ? NL + "⚠️ Отворени сметки от стара партида: " + TG.escHtml(cdp.stale.map(x => x.lot).join(", ")) : "");
      }
    } catch (e) { ownerText = "📊 Таблицата за партидата не се прочете: " + TG.escHtml(String(e && e.message).slice(0, 120)); }
    if (body.dry) { res.status(200).json({ ok: true, dry: true, kind: isWave ? "addition" : "full", wave: waveN, text, expo_text: expoText, owner_text: ownerText }); return; }
    const r = await TG.tgSend(text, null, date);
    if (!r.ok) { res.status(502).json({ ok: false, error: "telegram", message: r.error }); return; }
    const r2 = await TG.tgSend(expoText, null, date).catch(() => ({ ok: false }));
    let r3 = { ok: false };
    if (ownerText && TG.OWNER_CHAT_ID) r3 = await TG.tgSend(ownerText, String(TG.OWNER_CHAT_ID), date).catch(() => ({ ok: false }));
    await TG.sentSave("plan", date, { shops: merged, n: waveN }).catch(() => {});
    res.status(200).json({ ok: true, kind: isWave ? "addition" : "full", wave: waveN, shops: shopsN, expo_ok: !!(r2 && r2.ok), owner_ok: !!(r3 && r3.ok) });
    return;
  }
  // ★ S25 — кои обекти имат СТОКОВА за деня (за маршрута на шофьора). Досинхронизира кеша на
  // документите (кратко) и връща ключовете „client:person". Само четене.
  // ★ S31 — план на маршрутите: четене (обекти със стокова + автоматично предложение + записан план) и запис.
  if (body.action === "route_plan" || body.action === "route_plan_save") {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    if (body.action === "route_plan_save") {
      const routes = Array.isArray(body.routes) ? body.routes.filter(r => r && Array.isArray(r.keys)).map((r, i) => {
        const labels = {}; if (r.labels && typeof r.labels === "object") for (const [k, v] of Object.entries(r.labels)) if (r.keys.includes(k)) labels[String(k)] = String(v).slice(0, 60);
        return { name: String(r.name || `Маршрут ${i + 1}`).slice(0, 40), keys: r.keys.map(String).slice(0, 60), labels };
      }).filter(r => r.keys.length) : [];
      try {
        await sbReq(`cex_route_plan?on_conflict=for_date`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify([{ for_date: date, routes, updated_at: new Date().toISOString() }]) });
        res.status(200).json({ ok: true, date, routes });
      } catch (e) { res.status(502).json({ ok: false, error: String(e && e.message).slice(0, 200) }); }
      return;
    }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    try { await syncDocCache(user, pass, 20000); } catch (e) { /* кешът може да е стар — показваме каквото има */ }
    try {
      const docs = await sbAll(`cex_docs?select=inv_id,client_id,person_id&type_id=eq.11&is_anulate=eq.0&doc_date=eq.${date}`);
      const have = new Set(docs.map(d => (d.client_id != null ? d.client_id : "") + ":" + (d.person_id != null ? d.person_id : "")));
      const dow = new Date(date + "T12:00:00Z").getUTCDay();
      const raw = RT.ROUTE.filter(s => (!s.onlyDow || s.onlyDow.includes(dow)) && s.keys.some(k => have.has(k))).map(s => ({ key: RT.stopKey(s), name: s.name, zone: s.zone }));
      // ★ Нов обект със стокова, който го няма в маршрута на буса (lib/route.js) → показва се като „нов, без адрес",
      // с име от сметките в Barsy. Собственикът го влачи в маршрут; навигация ще има, щом му се добави адрес в route.js.
      const known = new Set(RT.ROUTE.flatMap(s => s.keys));
      const unknown = [...have].filter(k => !known.has(k) && !RT.NOT_BUS.has(k));
      if (unknown.length) {
        const names = {};
        try {
          const r = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 400 }, user, pass);
          let all = r.data || []; if (!Array.isArray(all)) all = Object.values(all);
          for (const a of all) { const k = cexKey(a); if (!names[k] && (a.client_name || a.person_name)) names[k] = [a.client_name, a.person_name].filter(Boolean).join(" · "); }
        } catch (e) { /* без имена — показваме ключа */ }
        for (const k of unknown) raw.push({ key: k, name: names[k] || ("Обект " + k), zone: "Нов обект", isNew: true });
      }
      const auto = RT.splitRoutes(raw.filter(s => !s.isNew)).map(g => ({ name: g.zone, keys: g.stops.map(s => s.key) }));
      const saved = await sbReq(`cex_route_plan?for_date=eq.${date}&select=routes,updated_at&limit=1`).catch(() => null);
      res.status(200).json({ ok: true, date, stops: raw, auto, saved: saved && saved[0] ? saved[0].routes : null, saved_at: saved && saved[0] ? saved[0].updated_at : null });
    } catch (e) { res.status(502).json({ ok: false, error: String(e && e.message).slice(0, 200) }); }
    return;
  }

  if (body.action === "driver_stops") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let sync = null;
    try { sync = await syncDocCache(user, pass, 20000); } catch (e) { sync = { error: String(e && e.message).slice(0, 200) }; }
    try {
      const docs = await sbAll(`cex_docs?select=inv_id,client_id,person_id&type_id=eq.11&is_anulate=eq.0&doc_date=eq.${date}`);
      const keys = [...new Set(docs.map(d => (d.client_id != null ? d.client_id : "") + ":" + (d.person_id != null ? d.person_id : "")))];
      res.status(200).json({ ok: true, date, keys, docs: docs.length, sync });
    } catch (e) { res.status(502).json({ ok: false, error: String(e && e.message).slice(0, 200), sync }); }
    return;
  }
  if (body.action === "suggest") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let sync = null;
    try { sync = await syncDocCache(user, pass, 35000); }
    catch (e) { sync = { error: String(e && e.message).slice(0, 200) }; }
    try { const s = await computeSuggestion(date); res.status(200).json({ ok: true, sync, ...s }); }
    catch (e) { res.status(502).json({ ok: false, error: "suggest_failed", message: String(e && e.message).slice(0, 200), sync }); }
    return;
  }
  if (body.action === "load_by_lot") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let s;
    try { s = await seedByLot(date, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    // маркирай кои вече имат издадена стокова (±2 дни, по клиент+сума) — както при load_accounts
    const okDates = {}; for (let k = -2; k <= 2; k++) okDates[isoPlusDays(date, k)] = 1;
    let stok = {};
    try {
      const r = await cexCall("Invoices_getlist", { order_by: "inv_id desc", length: 400 }, user, pass);
      let inv = r.data; inv = Array.isArray(inv) ? inv : Object.values(inv || {});
      for (const x of inv) {
        if (String(x.type_id) !== "11" || String(x.is_anulate) === "1") continue;
        if (!okDates[String(x.create_date || "").slice(0, 10)]) continue;
        (stok[x.client_id] = stok[x.client_id] || []).push(Number(x.total_all) || 0);
      }
    } catch (e) { stok = {}; }
    const hasStok = (sh) => { const arr = stok[sh.client_id]; if (!arr || !arr.length) return false; const i = arr.findIndex(t => Math.abs(t - (sh.total || 0)) < 0.05); if (i < 0) return false; arr.splice(i, 1); return true; };
    res.status(200).json({ ok: true, date, lot: s.lot, seeded_accounts: s.shops.length,
      shops: s.shops.map(x => { const hs = hasStok(x); return { account_id: x.account_id, client: x.client, rep: x.rep, client_id: x.client_id, person_id: x.person_id, group: x.group, total: x.total, has_stokova: hs, scheduled: !hs, order: sortObj(x.order || {}, 2) }; }) });
    return;
  }

  // ── ЗАРЕЖДАНЕ НА РАЗНОСА (за ③ Стокова): ОТВОРЕНИТЕ сметки за деня (направени в
  // навечерието или същата сутрин). Изключва вчерашните ЗАТВОРЕНИ (те са минал разнос),
  // затова „по дата" вече не хваща вчерашните. Маркира и вече-издадена стокова („С").
  if (body.action === "load_razos") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let s;
    try { s = await seedRazos(date, user, pass, true); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    // само ОТВОРЕНИТЕ (черновите на разноса) — затворените са приключен минал разнос
    const openShops = s.shops.filter(x => !x.close_date);
    const okDates = {}; for (let k = -2; k <= 2; k++) okDates[isoPlusDays(date, k)] = 1;
    let stok = {};
    try {
      const r = await cexCall("Invoices_getlist", { order_by: "inv_id desc", length: 400 }, user, pass);
      let inv = r.data; inv = Array.isArray(inv) ? inv : Object.values(inv || {});
      for (const x of inv) {
        if (String(x.type_id) !== "11" || String(x.is_anulate) === "1") continue;
        if (!okDates[String(x.create_date || "").slice(0, 10)]) continue;
        (stok[x.client_id] = stok[x.client_id] || []).push(Number(x.total_all) || 0);
      }
    } catch (e) { stok = {}; }
    const hasStok = (sh) => { const arr = stok[sh.client_id]; if (!arr || !arr.length) return false; const i = arr.findIndex(t => Math.abs(t - (sh.total || 0)) < 0.05); if (i < 0) return false; arr.splice(i, 1); return true; };
    res.status(200).json({ ok: true, date, seeded_accounts: openShops.length,
      shops: openShops.map(x => { const hs = hasStok(x); return { account_id: x.account_id, client: x.client, rep: x.rep, client_id: x.client_id, person_id: x.person_id, group: x.group, total: x.total, has_stokova: hs, scheduled: !hs, order: sortObj(x.order || {}, 2) }; }) });
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
    // ★ S27 — помним на СЪРВЪРА кой магазин вече има сметка за тази дата: ② не го брои втори
    // път (сметката му вече е в „запазено"). Не зависи от браузъра/устройството.
    let day_saved = false;
    try {
      const day = await dayGet(date); const st = Object.assign({}, day.state || {}); const accs = Object.assign({}, st.accounts || {});
      shopsIn.forEach((sh, i) => { const c = created[i]; if (c && c.ok) accs[dayKey(sh)] = { account_id: c.account_id || (accs[dayKey(sh)] && accs[dayKey(sh)].account_id) || null, existed: c.existed || undefined, at: new Date().toISOString() }; });
      st.accounts = accs; day_saved = (await daySave(date, st)).ok;
    } catch (e) { day_saved = false; }
    res.status(200).json({ ok: true, created, day_saved });
    return;
  }
  // ★ S27 — запис/отваряне на деня (решетката на собственика) в Supabase. Не пипа Barsy.
  if (body.action === "save_day" || body.action === "load_day") {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : null;
    if (!date) { res.status(400).json({ ok: false, error: "no_date" }); return; }
    try {
      const day = await dayGet(date);
      if (body.action === "load_day") { res.status(200).json({ ok: true, date, grid: (day.state && day.state.grid) || null, accounts: (day.state && day.state.accounts) || {}, updated_at: day.updated_at }); return; }
      const st = Object.assign({}, day.state || {}); st.grid = body.grid || null;
      const sv = await daySave(date, st);
      res.status(200).json({ ok: sv.ok, date, updated_at: sv.updated_at });
    } catch (e) { res.status(200).json({ ok: false, error: "day_state", message: String(e && e.message).slice(0, 160) }); }
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
    const shopsIn = Array.isArray(body.shops) ? body.shops.map(s => ({ order: s.order || {}, client_id: s.client_id, person_id: s.person_id, client: s.client, rep: s.rep, account_id: (s.acc_date && s.acc_date === (/^\d{4}-\d{2}-\d{2}$/.test(body.prod_date || "") ? body.prod_date : sofiaToday()) && s.account_id) || null })) : [];
    if (!shopsIn.length) { res.status(400).json({ ok: false, error: "no_shops" }); return; }
    const prodDate = /^\d{4}-\d{2}-\d{2}$/.test(body.prod_date || "") ? body.prod_date : sofiaToday();
    // ★ S24 — ДОБАВЕН МАГАЗИН ПО-КЪСНО. underLot е ЦЯЛОТО произведено под L (за магазините от
    // сутринта), а agg беше само ТИКНАТИТЕ → новият магазин се „покриваше" от чуждото производство
    // → ② казваше „нищо ново". Сега към нуждата добавяме ВЕЧЕ СЪЗДАДЕНИТЕ сметки на ДРУГИТЕ
    // (нетикнати) обекти за същата партида/разнос → произвежда се точно разликата. Тикнат обект,
    // който вече има сметка, не се брои два пъти (ключ client_id:person_id).
    const auto = body.auto_lot === true; // авто-партида (същия ден) → празна партида
    const { lot, lot_exp } = auto ? { lot: "", lot_exp: null } : lotFor(prodDate);
    const toRows = (map) => Object.entries(map)
      .map(([name, qty]) => { const a = resolve(name); return a ? { article_id: a.id, article_name: a.name, amount: round(Number(qty)) } : null; })
      .filter(r => r && r.amount > 0);
    // ★ S27 — планът чете склада и партидите от Barsy + записа на деня; не се ли прочете нещо → СТОП (без гадаене).
    let cdp;
    try { cdp = await computeDayPlan(shopsIn, prodDate, lot, body.razos_date, body.only !== "zag", user, pass); }
    catch (e) { res.status(200).json({ ok: false, error: "plan_unreadable", message: "Не успях да прочета данните за плана (" + String(e && e.message).slice(0, 120) + "). Нищо не е произведено — натисни пак." }); return; }
    const { plan, sm, underLot, others } = cdp;
    const rawStock = id => { const q = sm[String(id)]; return (q == null || isNaN(q)) ? 0 : q; };
    const shortfall = (need, id) => Math.max(0, Number(need) - rawStock(id));
    const zagProduce = {}, rollProduce = {}, setProduce = {}, loadRawNamed = {};
    for (const [id, q] of Object.entries(plan.produce)) { const a = byId(id); if (!a || !(q > 0)) continue; if (a.is_set) setProduce[a.name] = round(q); else if (a.cat === "Заготовки") zagProduce[a.name] = round(q); else if (a.is_menu) rollProduce[a.name] = round(q); }
    for (const [id, q] of Object.entries(plan.loadRaw)) { const a = byId(id); if (a && q > 0 && a.name !== "Опаковка" && a.name !== "Етикет Опаковка") loadRawNamed[a.name] = round(q); }
    // ★ 2-стъпков поток: only:'zag' = само заготовки; only:'articles' = само ролки/сетове (под L).
    // НЯМА гард за „мръсна партида" — нормално е няколко производства на ден под СЪЩАТА партида
    // (различни магазини/вълни). Всяко ② Артикули прави ПЪЛНАТА поръчка на ИЗБРАНИТЕ магазини под
    // L; ③ ги продава → произведено = продадено → без излишък. (Внимавай да НЕ пуснеш два пъти
    // СЪЩИТЕ магазини — тогава ще произведеш двойно; сметките ще кажат „вече създадена".)
    const only = body.only === "zag" || body.only === "articles" ? body.only : null;
    const doZag = body.include_zag !== false; // ★ S27: и при ② — поке/ролки не се записват без заготовката си
    const doArticles = only !== "zag";
    // Ред: заготовки (най-дълбоката първо, БЕЗ партида) → ролки → сетове (под L).
    const zagRows = toRows(zagProduce).sort((a, b) => zagDepth(byId(a.article_id)) - zagDepth(byId(b.article_id)));
    const rollRows = toRows(rollProduce), setRows = toRows(setProduce);
    const alreadyNamed = {}; for (const [id, q] of Object.entries(underLot)) { const a = byId(id); if (a && q > 0) alreadyNamed[a.name] = round(q); }
    const out = { lot: lot || "(авто)", lot_exp, prod_date: prodDate, other_accounts: others.map(x => (x.client || "") + (x.rep ? " / " + x.rep : "") + " #" + x.account_id), already_under_lot: sortObj(alreadyNamed, 2), load_raw: sortObj(loadRawNamed, 3), produced_zagotovki: sortObj(zagProduce, 3), produced_rolls: sortObj(rollProduce, 2), produced_sets: sortObj(setProduce, 2),
      table: cdp.table, stale: cdp.stale, in_point: Object.fromEntries(Object.entries(cdp.inPoint).map(([id, q]) => [(byId(id) || {}).name || id, q])), with_account: cdp.withAccount, need_shops: cdp.needShops };
    // ★ S28 — ПРЕДПАЗИТЕЛ: производството на СЕТ взима компонентите (НАЧИ) от НАЙ-СТАРАТА партида,
    // включително запазените за отворени сметки → старите сметки после не могат да се приключат.
    // Ако сет от плана има компонент, запазен под по-стара партида → СТОП, нищо не се произвежда.
    if (doArticles && setRows.length) {
      const hit = {};
      for (const r of setRows) for (const c of ((byId(r.article_id) || {}).components || [])) {
        const ca = c.id != null ? byId(c.id) : resolve(c.name);
        if (ca && cdp.oldHeld[String(ca.id)]) hit[ca.name] = cdp.oldHeld[String(ca.id)];
      }
      if (Object.keys(hit).length) {
        out.step = only || "all"; out.ok = false; out.error = "old_lot_reserved"; out.old_lot_reserved = hit;
        out.message = "СТОП: сетовете ще изядат бройки, запазени за отворени сметки от по-стара партида — "
          + Object.entries(hit).map(([n, a]) => n + " " + a.map(x => x.held + " бр. (" + x.lot + ")").join(", ")).join("; ")
          + ". Първо приключи тези сметки, после натисни ② пак. Нищо не е произведено.";
        res.status(200).json(out); return;
      }
    }
    // Ред: заготовки → ролки → сетове.
    try {
      // Заготовките — ЕДНА ПО ЕДНА (best-effort): някои нямат производствена рецепта в
      // Barsy (напр. „заг. Марината за ориз") и се прескачат, без да чупят процеса.
      if (doZag && zagRows.length) {
        // produced = излезли; failed = РЕАЛЕН недостиг (суровина/наличност) → червено, коригирай
        // ПРЕДИ ② ; skipped = безобидни (ръчна заготовка без производствена рецепта, напр. Марината).
        const z = { ok: true, produced: [], skipped: [], failed: [] };
        for (const r of zagRows) {
          // Заготовките се произвеждат БЕЗ партида: теглят се от общата наличност (FIFO)
          // за ролките/сетовете, а базовите (Марината/Зеле/Сварен ориз/Ориз Поке) не са
          // настроени за партиди в Barsy → под L даваха „не е настроено ползване на партиди"
          // → фалшиво ЧЕРВЕНО. Партида L е само за крайната продажба (ролки/сетове).
          let rr; try { rr = await createProduction([r], { lot: "", lot_exp: null }, user, pass); } catch (e) { rr = { ok: false, error: String(e && e.message) }; }
          if (rr && rr.ok) { z.produced.push(r.article_name); continue; }
          const err = String((rr && rr.error) || "");
          if (/наличност|служебн|партид/i.test(err)) z.failed.push({ name: r.article_name, qty: r.amount, reason: err.slice(0, 160) });
          else z.skipped.push({ name: r.article_name, qty: r.amount, reason: err ? err.slice(0, 120) : "няма производствена рецепта" });
        }
        z.ok = z.failed.length === 0;
        out.zagotovki = z;
      }
      if (doArticles && out.zagotovki && !out.zagotovki.ok) {
        out.step = only || "all"; out.ok = false; out.error = "zag_failed";
        out.message = "Заготовка не излезе: " + out.zagotovki.failed.map(f => f.name + " " + f.qty + " (" + f.reason.replace(/\s+/g, " ").slice(0, 90) + ")").join("; ") + ". Артикулите НЕ са произведени — оправи суровината и натисни ② пак.";
        res.status(200).json(out); return;
      }
      if (doArticles && rollRows.length) out.rolls = await createProduction(rollRows, { lot, lot_exp }, user, pass);
      if (doArticles && setRows.length) out.sets = await createProduction(setRows, { lot, lot_exp }, user, pass);
    } catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    out.step = only || "all";
    // Успехът: при only:'zag' зависи от заготовките (без реален недостиг); иначе от ролки/сетове.
    out.ok = only === "zag"
      ? (!out.zagotovki || out.zagotovki.ok)
      : (!doArticles || ((!rollRows.length || (out.rolls && out.rolls.ok)) && (!setRows.length || (out.sets && out.sets.ok))));
    res.status(200).json(out);
    return;
  }

  // ── Наличности суровини+заготовки (JSON) ──
  // ── Вътрешна форма на артикул (четящо, диагностика): рецептата НЕ е в публичния API,
  // но формата за редакция в adminx я носи → викаме вътрешния метод с Basic auth
  // (както invoices_edit). host: cex (цех) | shop (точката). Само четене.
  if (body.action === "article_form") {
    const host = body.host === "shop" ? "https://motamoshop.barsy.online" : CEX_API;
    const user = body.host === "shop" ? process.env.BARSY_USER : process.env.BARSY_CEX_USER;
    const pass = body.host === "shop" ? process.env.BARSY_PASS : process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "not_configured" }); return; }
    const id = Number(body.id); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
    const method = String(body.method || "articles_edit").replace(/[^a-zA-Z_]/g, "");
    const auth = Buffer.from(`${user}:${pass}`).toString("base64");
    const params = Object.assign({ bid: 1, article_id: id, id: id }, body.params || {});
    try {
      const r = await withTimeout(async (signal) => {
        const rr = await fetch(`${host}/endpoints/json?bid=1`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
          body: JSON.stringify({ [method]: Object.assign({ params }, body.top || {}) }), signal });
        const text = await rr.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
        return { ok: rr.ok, status: rr.status, data: d, raw: text };
      });
      const txt = String(r.raw || "");
      // Изрежи само интересното: редове с article/amount/recipe, за да не връщаме 200 KB.
      const hits = []; const re = /"(recipe|composite|components|ingredients|rows|amount|article_name|article_id|measure|unit|qty|quantity)"\s*:/g; let m; let n = 0;
      while ((m = re.exec(txt)) && n < 400) { hits.push(txt.slice(Math.max(0, m.index - 20), m.index + 160)); n++; }
      const inner = r.data && r.data[method];
      res.status(200).json({ ok: r.ok, status: r.status, method, length: txt.length, keys: r.data && typeof r.data === "object" ? Object.keys(r.data) : null,
        inner_id: inner && inner.id, subnav: inner && inner.subnav, page_title: inner && (inner.page_title || inner.object_title),
        head: txt.slice(0, Number(body.head) || 1500), hits: body.hits ? hits.slice(0, 200) : undefined });
    } catch (e) { res.status(504).json({ ok: false, error: "unreachable", message: String(e && e.message) }); }
    return;
  }
  // ── Производства за ден (четящо): кои документи, какво е произведено, описание ──
  if (body.action === "productions") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    // Barsy дава НАЙ-СТАРИТЕ 3000 документа, ако няма филтър по дата (order_by не помага) →
    // винаги филтрираме по `filters.date` (единственият работещ ключ): дадения ден или
    // последните `days` (по подразбиране 30) дни. Открито 14.10: справката свършваше на 04.10.
    const days = Math.max(1, Number(body.days) || 30);
    const from = body.date ? date : (() => { const d = new Date(Date.parse(date + "T00:00:00Z") - (days - 1) * 86400000); return d.toISOString().slice(0, 10); })();
    let list;
    try {
      const r = await cexCall("Storeproductions_getlist", { filters: { date: [from, date] }, extra_properties: ["all", "details"], order_by: "store_production_id desc", length: Number(body.length) || 3000, limit: Number(body.length) || 3000 }, user, pass);
      list = r.data && (r.data.list || r.data) || [];
      if (!Array.isArray(list)) list = Object.values(list);
    } catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    const dOf = x => String(x.doc_date || x.create_date || x.date || "").slice(0, 10);
    list.sort((a, b) => Number(b.store_production_id || b.id) - Number(a.store_production_id || a.id));
    const docs = list.filter(x => !body.date || dOf(x) === date).map(x => ({
      id: x.store_production_id || x.id, date: dOf(x), created: x.create_date || null, status: x.status != null ? x.status : (x.item_status != null ? x.item_status : null),
      annulled: x.anulate_flag != null ? String(x.anulate_flag) === "1" : (x.is_anulate != null ? String(x.is_anulate) === "1" : undefined), description: x.description || "", lot: (x.details && x.details[0] && x.details[0].lot_value) || x.lot_value || null,
      rows: (x.details || []).map(d => ({ article_id: d.article_id, name: (ARTS[String(d.article_id)] || {}).name || d.article_name || null, amount: Number(d.amount_prod != null ? d.amount_prod : d.amount) || 0, lot: d.lot_value || null }))
    }));
    // Нето: анулирането маркира оригинала (anulate_flag) И добавя минусов документ → сумираме ВСИЧКО.
    const produced = {};
    for (const d of docs) for (const r of d.rows) produced[r.name || r.article_id] = (produced[r.name || r.article_id] || 0) + r.amount;
    if (body.raw) { res.status(200).json({ ok: true, date, sample: list.slice(0, 2) }); return; }
    if (body.lot) { // произведено под партида (нето, по справката за партиди) — това вижда и ①
      const ul = await producedUnderLot(String(body.lot), user, pass);
      const named = {}; for (const [id, q] of Object.entries(ul)) { const a = ARTS[String(id)]; named[a ? a.name : id] = round(q); }
      res.status(200).json({ ok: true, lot: body.lot, produced_under_lot: sortObj(named, 2) }); return;
    }
    res.status(200).json({ ok: true, date, count: docs.length, produced: sortObj(produced, 2), docs });
    return;
  }
  // ── Движения на едно производство (четящо): изтеглени съставки + произведено ──
  // ДИАГНОСТИКА (S20 ден2): суровите движения по партида — типове/знаци, за да смятам НЕТНО.
  if (body.action === "lot_net") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const lot = String(body.lot || ""); if (!lot) { res.status(400).json({ ok: false, error: "no_lot" }); return; }
    const artId = body.article_id != null ? String(body.article_id) : null;
    const all = [];
    for (let pg = 1; pg <= 12; pg++) {
      let d = null;
      try { const r = await cexCall("Reports_lot_list_details", { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { lot_value: lot } }, user, pass); if (r && r.ok) d = r.data; } catch (e) {}
      if (!d) break; const rows = Array.isArray(d.rows) ? d.rows : []; all.push(...rows); if (rows.length < 50) break;
    }
    const types = {}; for (const x of all) { const t = x.operation_ref_type || x.operation_type || "?"; types[t] = (types[t] || 0) + 1; }
    const forArt = artId ? all.filter(x => String(x.article_id) === artId) : [];
    res.status(200).json({ ok: true, lot, total_rows: all.length, ref_types: types,
      sample: all.slice(0, 4),
      article_rows: forArt.map(x => ({ type: x.operation_ref_type, amount: x.amount, ref_id: x.ref_id, keys: Object.keys(x).slice(0, 20) })).slice(0, 40) });
    return;
  }
  if (body.action === "production_movements") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const id = Number(body.id); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
    // Barsy гридът връща само дефиниции на колони, докато не поискаш ДАННИТЕ с
    // force_data_request. eStructList_1 = „Складови движения — заредени артикули"
    // (ИЗТЕГЛЕНИТЕ суровини за това производство). Втора заявка изважда редовете.
    const struct = body.struct || "eStructList_1";
    const findRows = (node) => { let best = null; (function w(x) { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { if (x.length && x[0] && typeof x[0] === "object" && ((x[0].amount != null && (x[0].article_name != null || x[0].article_id != null || x[0].article_name_prod != null)) || x[0].store_id != null)) { if (!best || x.length > best.length) best = x; } return x.forEach(w); } for (const k in x) w(x[k]); })(node); return best || []; };
    try {
      const rr = await cexCall("Storeproductions_movements", { id, store_production_id: id, action_type: "values", active_struct_id: struct, force_data_request: true, page_num: 1, rows: 5000, params: { id, store_production_id: id, bid: CEX_BID, force_data_request: true } }, user, pass);
      const raw = findRows(rr.data);
      const rows = raw.map(r => ({ produced: r.article_name_prod || null, withdrawn: r.article_name || null, withdrawn_id: r.article_id != null ? Number(r.article_id) : null, amount: Number(r.amount) || 0, cost: Number(r.avg_delivery_price_sum != null ? r.avg_delivery_price_sum : r.avg_delivery_price) || 0 }));
      if (body.debug) { res.status(200).json({ ok: true, id, count: raw.length, sample_keys: raw[0] ? Object.keys(raw[0]) : [], rows, raw_sample: String(rr.raw || "").slice(0, 1000) }); return; }
      res.status(200).json({ ok: true, id, count: raw.length, rows });
    }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); }
    return;
  }
  // ── ДИАГНОСТИК (само четене): заглавия на зареждания (доставчик/сума/дата/№) ──
  // body: {ids:[...]} конкретни, или {recent:N} последните. Цена = total_sum/qty (ако
  // зареждането е само опаковка). Доставчикът често е празен/„Анонимен" в цеха.
  if (body.action === "load_heads") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    let ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) { // ако не са дадени — вземи последните N id-та от списъка
      try { const hr = await cexCall("Storeloads_getlist", { length: 5000, limit: 5000, order_by: "store_load_id desc" }, user, pass); let L = hr.data || []; if (!Array.isArray(L)) L = Object.values(L); ids = L.map(h => Number(h.store_load_id || h.id)).filter(Boolean).slice(0, Number(body.recent) || 40); } catch (e) {}
    }
    // Пълните данни (сума/доставчик/дата) идват от ЕДИНИЧНОТО четене Storeloads_get.
    const heads = await mapLimit(ids, 8, async (lid) => {
      try { const r = await cexCall("Storeloads_get", { id: lid, store_load_id: lid }, user, pass); const h = r.data || {}; return { id: lid, date: (h.doc_date || h.date || "").slice(0, 10), doc_num: h.doc_num || null, supplier: h.supplier_name || "", total_sum: Number(h.total_sum) || 0, total_real: Number(h.total_real) || 0, has_tax: h.has_tax }; }
      catch (e) { return { id: lid, error: true }; }
    });
    heads.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    res.status(200).json({ ok: true, count: heads.length, heads });
    return;
  }
  if (body.action === "stock") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    let rows;
    try {
      if (body.all) { // и менюто (ролки/поке/сетове), не само суровини+заготовки
        const sm = await stockMap(user, pass);
        rows = Object.entries(sm).map(([id, qty]) => { const a = ARTS[String(id)]; return a ? { id: Number(id), name: a.name, cat: a.cat, is_menu: !!a.is_menu, is_set: !!a.is_set, qty } : null; }).filter(Boolean);
      } else rows = await readStock(user, pass);
    }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    res.status(200).json({ ok: true, rows });
    return;
  }

  // ── ДИАГНОСТИК (само четене): ВСИЧКИ складови движения на ЕДНА суровина/артикул ──
  // За да хванем защо наличността е надута — разделя входа (зареждания/ревизии/производство)
  // от изхода (изписване по производство/продажба). Barsy: Storemoves_getlist по article_id.
  if (body.action === "raw_moves") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const id = Number(body.id); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
    const findRows = (node) => { let best = null; (function w(x) { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { if (x.length && x[0] && typeof x[0] === "object") { if (!best || x.length > best.length) best = x; } return x.forEach(w); } for (const k in x) w(x[k]); })(node); return best || []; };
    const attempts = [];
    let rows = [];
    // Няколко варианта на параметрите — Barsy е капризен кой ключ приема.
    const variants = [
      { method: "Storemoves_getlist", params: { filters: { article_id: id }, action_type: "values", active_struct_id: "eStructList_1", force_data_request: true, page_num: 1, rows: 5000, params: { article_id: id, bid: CEX_BID, force_data_request: true } } },
      { method: "Reports_store_moves", params: { filters: { article_id: id }, action_type: "values", active_struct_id: "eStructList_1", force_data_request: true, page_num: 1, rows: 5000 } },
      { method: "Reports_goods_movement", params: { filters: { article_id: id }, action_type: "values", active_struct_id: "eStructList_1", force_data_request: true, page_num: 1, rows: 5000 } },
      { method: "Articledetails_getlist", params: { filters: { article_id: id }, length: 5000, limit: 5000 } }
    ];
    for (const v of variants) {
      try {
        const r = await cexCall(v.method, v.params, user, pass);
        const found = findRows(r.data);
        attempts.push({ method: v.method, ok: r.ok, status: r.status, count: found.length, keys: found[0] ? Object.keys(found[0]).slice(0, 25) : [], raw_sample: String(r.raw || "").slice(0, 300) });
        if (found.length && (rows.length === 0)) rows = found;
      } catch (e) { attempts.push({ method: v.method, error: String(e && e.message) }); }
    }
    // Ако не намерим движения по артикул — сглоби входа от документите за зареждане:
    // Storeloads_getlist дава заглавията, Storeloads_get дава редовете (article_id+amount).
    if (body.loads) {
      let heads = [];
      try { const hr = await cexCall("Storeloads_getlist", { length: 5000, limit: 5000, order_by: "store_load_id desc" }, user, pass); let L = hr.data || []; if (!Array.isArray(L)) L = Object.values(L); heads = L; } catch (e) {}
      const findRows2 = (node) => { let best = null; (function w(x) { if (!x || typeof x !== "object") return; if (Array.isArray(x)) { if (x.length && x[0] && typeof x[0] === "object" && (x[0].article_id != null)) { if (!best || x.length > best.length) best = x; } return x.forEach(w); } for (const k in x) w(x[k]); })(node); return best || []; };
      const ids = heads.map(h => h.store_load_id || h.id).filter(Boolean);
      if (body.debug) {
        // пробвай различни методи/грид-структури за РЕДОВЕТЕ на едно зареждане
        const one = ids[0];
        const R = "Reports_lot_list_details";
        const probes = [
          { m: R, p: { active_struct_id: "eStructList_1", action_type: "values", page_num: 1, filters: { article_id: [id] } } },
          { m: R, p: { active_struct_id: "eStructList_1", action_type: "values", page_num: 1, filters: { article_name: "Пиле Панирано" } } },
          { m: R, p: { active_struct_id: "eStructList_1", action_type: "values", page_num: 1, filters: { articles: [id] } } },
          { m: R, p: { active_struct_id: "eStructList_1", action_type: "values", page_num: 1, rows: 200, filters: { article_id: id } } },
          { m: "Revisions_getlist", p: { filters: {}, length: 500, order_by: "id desc" } }
        ];
        const summ = (r) => { const rr = findRows2(r.data); const only127 = rr.filter(x => Number(x.article_id) === id); const types = {}; for (const x of only127) { const t = x.operation_ref_type || "?"; types[t] = (types[t] || 0) + (Number(x.amount) || 0); } return { total_rows: rr.length, rows_127: only127.length, types_127: types, distinct_articles: [...new Set(rr.map(x => x.article_id))].slice(0, 8) }; };
        const out = [];
        for (const pr of probes) {
          try { const r = await cexCall(pr.m, pr.p, user, pass); const s = summ(r); out.push({ m: pr.m, p: JSON.stringify(pr.p.filters || pr.p).slice(0, 60), ok: r.ok, status: r.status, ...s }); } catch (e) { out.push({ m: pr.m, error: String(e && e.message) }); }
        }
        res.status(200).json({ ok: true, id, heads_count: ids.length, first_id: one, probes: out });
        return;
      }
      let total = 0, docs = 0; const hits = [];
      const details = await mapLimit(ids, 8, async (lid) => {
        try { const r = await cexCall("Storeloads_get", { id: lid, store_load_id: lid, action_type: "values", active_struct_id: "eStructListForm_1", force_data_request: true, rows: 5000, params: { id: lid, store_load_id: lid, bid: CEX_BID, force_data_request: true } }, user, pass); return { lid, rows: findRows2(r.data) }; } catch (e) { return { lid, rows: [] }; }
      });
      const headById = {}; for (const h of heads) headById[String(h.store_load_id || h.id)] = h;
      for (const d of details) for (const r of d.rows) { if (Number(r.article_id) === id) { const amt = Number(r.amount) || 0; total += amt; docs++; const h = headById[String(d.lid)] || {}; hits.push({ load: d.lid, date: (h.doc_date || h.create_date || h.date || "").slice(0, 10), amount: amt }); } }
      hits.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      res.status(200).json({ ok: true, id, name: (ARTS[String(id)] || {}).name, total_loaded: Math.round(total * 1000) / 1000, load_docs: docs, recent: hits.slice(0, 30) });
      return;
    }
    // ── ПЪЛЕН РЕГИСТЪР на движенията за ЕДНА суровина (обхожда Reports_lot_list_details).
    // Сървърът не филтрира по артикул → теглим всички страници и филтрираме тук.
    if (body.ledger) {
      const PER = 1000;
      const getPage = async (pg) => {
        for (let t = 0; t < 3; t++) {
          try { const r = await cexCall("Reports_lot_list_details", { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, rows: PER, filters: {} }, user, pass); if (r && r.ok && r.data) return r.data; } catch (e) {}
          await new Promise(res => setTimeout(res, 150 * (t + 1)));
        }
        return null;
      };
      const first = await getPage(1);
      const records = first && Number(first.total_records || first.records) || 0;
      const totalPages = first ? Math.max(1, Math.ceil((records || (first.total ? first.total * PER : 0)) / PER)) : 0;
      const pagesToGet = Math.min(totalPages || 1, 120); // таван, за да не гръмне таймаутът
      const pageNums = []; for (let p = 2; p <= pagesToGet; p++) pageNums.push(p);
      const datas = await mapLimit(pageNums, 8, getPage);
      const allData = [first, ...datas].filter(Boolean);
      const mine = [];
      for (const d of allData) { const rws = Array.isArray(d.rows) ? d.rows : []; for (const x of rws) if (Number(x.article_id) === id) mine.push(x); }
      const byType = {}; let net = 0;
      for (const x of mine) { const t = x.operation_ref_type || "?"; const a = Number(x.amount) || 0; byType[t] = (byType[t] || 0) + a; net += a; }
      const ins = mine.filter(x => (Number(x.amount) || 0) > 0).map(x => ({ date: (x.operation_doc_date || x.create_date || "").slice(0, 10), type: x.operation_ref_type, amount: Number(x.amount) || 0, lot: x.lot_value, ref: x.ref_id })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
      Object.keys(byType).forEach(k => byType[k] = Math.round(byType[k] * 1000) / 1000);
      // ── Цена по ДОСТАВЧИК: LD движенията носят ref_id (=store_load_id) + amount_sum
      // (стойност). Единична цена = amount_sum/amount; доставчикът е в заглавието на
      // зареждането (Storeloads_getlist.supplier_name).
      let by_supplier = null;
      if (body.suppliers) {
        let heads = [];
        try { const hr = await cexCall("Storeloads_getlist", { length: 5000, limit: 5000, order_by: "store_load_id desc" }, user, pass); let L = hr.data || []; if (!Array.isArray(L)) L = Object.values(L); heads = L; } catch (e) {}
        const headById2 = (ref, hs) => hs.find(h => String(h.store_load_id) === String(ref) || String(h.id) === String(ref) || String(h.barsy_id) === String(ref)) || null;
        const supById = {}; for (const h of heads) supById[String(h.store_load_id || h.id)] = { sup: h.supplier_name || "?", date: (h.doc_date || h.date || "").slice(0, 10) };
        const grp = {};
        for (const x of mine) {
          const t = x.operation_ref_type; if (t !== "LD") continue;
          const amt = Number(x.amount) || 0; if (amt <= 0) continue;
          const val = Number(x.amount_sum) || 0; const unit = val / amt;
          const meta = supById[String(x.ref_id)] || { sup: "?", date: "" };
          const g = grp[meta.sup] || (grp[meta.sup] = { supplier: meta.sup, qty: 0, value: 0, loads: 0, prices: [] });
          g.qty += amt; g.value += val; g.loads++;
          g.prices.push({ date: meta.date || (x.operation_doc_date || "").slice(0, 10), qty: amt, unit: Math.round(unit * 10000) / 10000, ref: x.ref_id });
        }
        by_supplier = Object.values(grp).map(g => ({ supplier: g.supplier, qty: Math.round(g.qty * 1000) / 1000, total_value: Math.round(g.value * 100) / 100, avg_unit: g.qty ? Math.round((g.value / g.qty) * 10000) / 10000 : null, loads: g.loads, recent: g.prices.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 8) })).sort((a, b) => b.qty - a.qty);
        // debug: свържи LD редовете със заглавията (доставчик + обща сума на документа)
        const ld = mine.filter(x => x.operation_ref_type === "LD" && (Number(x.amount) || 0) > 0);
        by_supplier.push({ _debug: true, ld_count: ld.length, header_count: heads.length,
          sample_ld: ld.slice(0, 12).map(x => { const h = headById2(x.ref_id, heads); return { ref: x.ref_id, amount: Number(x.amount) || 0, amount_sum: Number(x.amount_sum) || 0, date: (x.operation_doc_date || "").slice(0, 10), sup: h ? (h.supplier_name || "") : "НЯМА ЗАГЛАВИЕ", total_sum: h ? h.total_sum : null } }) });
      }
      res.status(200).json({ ok: true, id, name: (ARTS[String(id)] || {}).name, records_total: records, pages_scanned: allData.length, pages_total: totalPages, my_rows: mine.length, by_type: byType, net_in_register: Math.round(net * 1000) / 1000, in_moves_count: ins.length, in_moves: ins.slice(0, 40), by_supplier });
      return;
    }
    if (body.debug) { res.status(200).json({ ok: true, id, attempts, sample: rows.slice(0, 6) }); return; }
    // Обобщение вход/изход, ако разпознаем ключове amount + дата/тип.
    const summ = { in: 0, out: 0, count: rows.length, by_type: {} };
    for (const x of rows) {
      const amt = Number(x.amount != null ? x.amount : (x.amount_sum != null ? x.amount_sum : 0)) || 0;
      const t = x.operation_ref_type || x.operation_type || x.doc_type || x.type || "?";
      summ.by_type[t] = (summ.by_type[t] || 0) + amt;
      if (amt >= 0) summ.in += amt; else summ.out += amt;
    }
    res.status(200).json({ ok: true, id, attempts, summary: summ, sample: rows.slice(0, 10) });
    return;
  }

  // ── НЕДОСТИГ ЗА ДЕНЯ: сравнява днешната нужда (разнос → fullBOM консумация) срещу
  // наличността и връща суровините/заготовките, които ЩЕ СВЪРШАТ днес (deficit > 0),
  // най-лошото първо. Read-only (view токен). Това хваща напр. скаридите Маки Еби,
  // които простата „наличност <= 0" справка изпуска в шума от нулите. ──
  if (body.action === "shortage") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    let seed, stockRows;
    try {
      seed = await seedRazos(date, user, pass, true);
      stockRows = await readStock(user, pass);
    } catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    const agg = {};
    for (const s of (seed.shops || [])) for (const [k, v] of Object.entries(s.order || {})) agg[k] = (agg[k] || 0) + (Number(v) || 0);
    const demand = fullBOM(agg); // {article_id: кол} по цялото дърво (заготовки+суровини)
    const stockById = {}; for (const r of stockRows) stockById[String(r.id)] = r.qty;
    const EXCLUDE = new Set(["Опаковка", "Етикет Опаковка"]);
    const items = [];
    for (const [id, need] of Object.entries(demand)) {
      if (!(need > 0)) continue;
      const meta = byId(Number(id)); if (!meta || EXCLUDE.has(meta.name)) continue;
      if (meta.cat !== "Суровини" && meta.cat !== "Заготовки") continue;
      const have = stockById[String(id)];
      const haveNum = (have == null || isNaN(have)) ? 0 : have;
      const deficit = round(need - haveNum);
      if (deficit > 0.0005) items.push({ id: Number(id), name: meta.name, cat: meta.cat, need: round(need), have: have == null ? null : round(have), deficit });
    }
    items.sort((a, b) => b.deficit - a.deficit);
    res.status(200).json({ ok: true, date, razos_accounts: seed.accounts, shortages: items });
    return;
  }

  let shops = null, seededAccounts = null;
  const seedDate = body.seed_date || q.seed_date;
  const hasInput = (Array.isArray(body.shops) && body.shops.length) || (body.orders && typeof body.orders === "object") || seedDate;
  if (!hasInput) { res.status(400).json({ ok: false, error: "no_input", hint: "подай shops:[] / orders:{} / seed_date:YYYY-MM-DD" }); return; }
  if (Array.isArray(body.shops) && body.shops.length) {
    shops = body.shops.map(s => ({ client: s.client || null, rep: s.rep || null, client_id: s.client_id || null, person_id: s.person_id || null, account_id: s.account_id || null, acc_date: s.acc_date || null, order: s.order || {} }));
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
  const shopsOut = shops.map(s => ({ client: s.client, rep: s.rep, client_id: s.client_id, person_id: s.person_id, account_id: s.account_id, order: sortObj(s.order || {}, 2) }));
  const produceOut = { sets: sortObj(sets, 2), rolls: sortObj(rolls, 2), zagotovki: sortObj(zag, 3) };
  // „Изчисли" пази последното изчислено за момичетата (view=today) + какво е попълнил
  // собственикът — до следващото „Изчисли". Дата = kitchen_date (Партида/деня на разноса).
  let kitchen_saved = null;
  if (body.publish_kitchen) {
    const kd = /^\d{4}-\d{2}-\d{2}$/.test(body.kitchen_date || "") ? body.kitchen_date : sofiaToday();
    try { const sv = await sbSavePlan(kd, shopsOut, produceOut, body.kitchen_note || null); kitchen_saved = sv.ok ? kd : false; }
    catch (e) { kitchen_saved = false; }
  }
  // ★ S20 — ПРЕД-ПОЛЕТЕН план: чете живия склад и връща какво да заредиш (суровини) и
  // произведеш (заготовки) ПРЕДИ ①, за да не гръмне производството. Само ако има Barsy
  // креденшъли; при проблем със склада връщаме preflight:null (не чупим „Изчисли").
  let preflight = null;
  if (body.preflight !== false) {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (user && pass) {
      try {
        // ★ S24 — СЪЩИЯТ computeDayPlan като ①/② (свободно = склад − запазено; продаваните
        // нетно спрямо L; физическа проверка) → панелът показва ТОЧНО каквото ще се произведе.
        const pfDay = /^\d{4}-\d{2}-\d{2}$/.test(body.kitchen_date || "") ? body.kitchen_date : sofiaToday();
        const pfShops = (shops || []).map(x => ({ order: x.order || {}, client_id: x.client_id, person_id: x.person_id }));
        const pfShopsFull = (shops || []).map(x => ({ order: x.order || {}, client_id: x.client_id, person_id: x.person_id, client: x.client, rep: x.rep, account_id: (x.acc_date && x.acc_date === pfDay && x.account_id) || null }));
        const cdp = await computeDayPlan(pfShopsFull, pfDay, lotFor(pfDay).lot, null, false, user, pass);
        const pf = cdp.plan;
        const zag = {}; for (const [id, q] of Object.entries(pf.produce)) { const a = byId(id); if (a && a.cat === "Заготовки" && q > 0) zag[id] = q; }
        const named = (m, d) => { const o = {}; for (const [k, q] of Object.entries(m)) { const a = resolve(k); o[a ? a.name : k] = Math.round(q * 10 ** d) / 10 ** d; } return o; };
        preflight = {
          load_raw: named(pf.loadRaw, 3),        // СУРОВИНИ за зареждане (недостиг)
          produce_zagotovki: named(zag, 3),      // ЗАГОТОВКИ за производство (нетно)
          ok: Object.keys(pf.loadRaw).length === 0, // true = нищо не липсва → чисто минаване
          in_point: named(cdp.inPoint, 3),        // липсващото го ИМА в склад „Точка" → прехвърли го обратно
          stale: cdp.stale,                       // отворени сметки от СТАРА партида (забравени)
          with_account: cdp.withAccount, table: cdp.table
        };
      } catch (e) { preflight = { error: "stock_read_failed", message: String(e && e.message).slice(0, 120) }; }
    }
  }
  res.status(200).json({
    ok: true, seed_date: seedDate || null, seeded_accounts: seededAccounts, kitchen_saved,
    shops: shopsOut, preflight,
    order_total: sortObj(agg, 2), produce_sets: produceOut.sets, produce_rolls: produceOut.rolls, produce_zagotovki: produceOut.zagotovki
  });
};

