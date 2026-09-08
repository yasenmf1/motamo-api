// api/shop-dash.js — Дашборд за ТОЧКАТА (Каравелов, motamoshop.barsy.online).
// По образеца на цеховия дашборд, но за B2C дейността на магазина/бара:
//   GET /api/shop-dash?view=dashboard&k=<токен>   → страница (Chart.js)
//   GET /api/shop-dash?debug=1&k=<токен>          → JSON (данните + мостри полета)
//
// Данни: сметки/поръчки + справка „Продажби по артикули" от Barsy на точката
// (BARSY_USER/PASS). СЕБЕСТОЙНОСТ/МАРЖИН от api/costs.js (в този Barsy няма цена на
// доставка, за разлика от цеха) → точен маржин по поддържаната таблица разходи.
// Само ЧЕТЕ. Гейт: CEX_VIEW_TOKEN (или силните токени).

const COSTSMOD = require("./costs.js");
const COSTS = COSTSMOD.COSTS || {};
const PACKAGING = COSTSMOD.PACKAGING || {};
const FALLBACK_FOOD_COST = COSTSMOD.FALLBACK_FOOD_COST || {};
const PACKAGING_DEFAULT = 0.19, FALLBACK_DEFAULT = 0.28;

const SHOP_API = "https://motamoshop.barsy.online", SHOP_BID = 1, TIMEOUT_MS = 9000;
const ONLINE_CLIENT_ID = 7;                 // клиент „Онлайн" (сайтът) — виж docs
const VAT = 1.2;

const round = n => Math.round((Number(n) || 0) * 100) / 100;
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sofiaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());

function withTimeout(run) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  return Promise.resolve(run(c.signal)).finally(() => clearTimeout(t));
}
function shopCall(action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${SHOP_API}/endpoints/json/${action}?bid=${SHOP_BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}), signal });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d };
  });
}
const arrOf = x => { let d = x && x.data; d = Array.isArray(d) ? d : (d && (d.list || (typeof d === "object" ? Object.values(d) : []))) || []; return Array.isArray(d) ? d : []; };

// Справка „Продажби по артикули" (оборот+бройки на артикул за периода), странирано.
async function salesByArticles(from, to, user, pass) {
  const by = {}; let ok = false, incomplete = false; const PAGE = 50, MAXPG = 30;
  for (let pg = 1; pg <= MAXPG; pg++) {
    let rows = null;
    for (let t = 0; t < 3 && rows === null; t++) {
      try {
        const r = await shopCall("Reports_sales_by_articles",
          { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { ref_date: [from, to] } }, user, pass);
        if (r && r.ok && r.data && Array.isArray(r.data.rows)) { rows = r.data.rows; ok = true; }
      } catch (e) {}
      if (rows === null) await new Promise(res => setTimeout(res, 250 * (t + 1)));
    }
    if (rows === null) { incomplete = true; break; }
    for (const x of rows) {
      const id = String(x.article_id);
      const a = by[id] || (by[id] = { article_id: Number(x.article_id), name: x.article_name || ("#" + id), units: 0, revenue: 0 });
      a.units += Number(x.cnt) || 0;
      a.revenue += Number(x.total_no_dds) || 0;   // без ДДС
    }
    if (rows.length < PAGE) break;
  }
  return { ok, incomplete, articles: Object.values(by) };
}

// Карта артикул → категория (за опаковка + донат по категория). Идва от ПУБЛИЧНОТО
// меню на точката (Categories_getalltree), както в api/menu.js.
const MENU_PUBLIC = "https://motamoshop.barsyonline.menu/public/endpoints/json?";
async function articleCats() {
  const map = {};
  try {
    const r = await withTimeout(async (signal) => {
      const resp = await fetch(MENU_PUBLIC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ Categories_getalltree: {} }), signal });
      return resp.ok ? resp.json() : null;
    });
    const tree = (r && r.Categories_getalltree) || {};
    for (const entry of (tree.categories || [])) {
      const name = (entry.category && entry.category.cat_name) || null;
      for (const a of (entry.articles || [])) { const id = a && a.article_id; if (id != null && map[String(id)] == null) map[String(id)] = name; }
    }
    for (const a of (tree.articles || [])) { const id = a && a.article_id; if (id != null && map[String(id)] == null) map[String(id)] = (tree.category && tree.category.cat_name) || "Други"; }
  } catch (e) {}
  return map;
}

function payKind(name) {
  const s = String(name || "").toLowerCase();
  if (/карт|card|visa|master|apple|google|site|сайт/.test(s)) return "card";
  if (/брой|кеш|cash|налич/.test(s)) return "cash";
  return "other";
}
function costOf(id, revenueNeto, cat) {
  const known = COSTS[id];
  if (typeof known === "number") return known;
  const r = Number(revenueNeto) || 0;
  return r * (FALLBACK_FOOD_COST[cat] || FALLBACK_DEFAULT);
}
function packOf(cat) { return typeof PACKAGING[cat] === "number" ? PACKAGING[cat] : PACKAGING_DEFAULT; }

async function shopDashData(from, to, expenses, user, pass) {
  const inRange = d => d && d >= from && d <= to;
  // предходен период със същата дължина (за „растеж/спад")
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5) + 1);
  const prevTo = new Date(new Date(from) - 864e5).toISOString().slice(0, 10);
  const prevFrom = new Date(new Date(prevTo) - (days - 1) * 864e5).toISOString().slice(0, 10);

  const [accR, salesRep, prevRep, cats] = await Promise.all([
    shopCall("Accounts_getlist", { order_by: "account_id desc", length: 12000 }, user, pass),
    salesByArticles(from, to, user, pass).catch(() => ({ ok: false, incomplete: true, articles: [] })),
    salesByArticles(prevFrom, prevTo, user, pass).catch(() => ({ ok: false, articles: [] })),
    articleCats(),
  ]);

  const all = arrOf(accR);
  const byDay = {}, byHour = {}, byChanDay = {};   // ден→нето, час→нето, ден→{online,counter}
  let totalNeto = 0, accountsN = 0, onlineNeto = 0, counterNeto = 0, onlineN = 0, counterN = 0;
  // Плащане: в брой / карта / друго — от самата СМЕТКА (payment_name на затворената сметка)
  const byPay = { cash: { neto: 0, n: 0 }, card: { neto: 0, n: 0 }, other: { neto: 0, n: 0 } };
  let payUsed = false, sample = null;
  for (const a of all) {
    if (String(a.account_alias || "").includes("CLTEST")) continue;
    const full = String(a.close_date || "");
    const day = full.slice(0, 10);
    if (!inRange(day)) continue;
    const gross = Number(a.total_sum != null ? a.total_sum : (a.total_all != null ? a.total_all : a.total)) || 0;
    if (!gross) continue;
    if (!sample) sample = a;
    const neto = round(gross / VAT);
    byDay[day] = round((byDay[day] || 0) + neto);
    const hm = full.length >= 13 ? parseInt(full.slice(11, 13), 10) : NaN;
    if (!isNaN(hm)) byHour[hm] = round((byHour[hm] || 0) + neto);
    const online = Number(a.client_id) === ONLINE_CLIENT_ID;
    const cd = byChanDay[day] || (byChanDay[day] = { online: 0, counter: 0 });
    if (online) { onlineNeto = round(onlineNeto + neto); onlineN++; cd.online = round(cd.online + neto); }
    else { counterNeto = round(counterNeto + neto); counterN++; cd.counter = round(cd.counter + neto); }
    const pn = a.payment_name || a.payment_short_name;
    if (pn) { payUsed = true; const k = payKind(pn); byPay[k].neto = round(byPay[k].neto + neto); byPay[k].n++; }
    totalNeto = round(totalNeto + neto); accountsN++;
  }

  // Продукти: оборот/бройки от справката, себестойност от costs.js, опаковка по категория
  const unitsTrunc = !!(salesRep && salesRep.incomplete);
  const byCat = {};
  const products = (salesRep && salesRep.articles || []).map(a => {
    const un = round(a.units), rev = round(a.revenue);
    const cat = cats[String(a.article_id)] || null;
    const food = costOf(a.article_id, rev, cat) * un;
    const pack = packOf(cat) * un;
    const tc = round(food + pack);
    if (cat) byCat[cat] = round((byCat[cat] || 0) + rev);
    return { article_id: a.article_id, name: a.name, units: un, category: cat,
      total_cost: tc, revenue: rev, profit: round(rev - tc) };
  }).filter(p => p.units > 0 || p.revenue > 0).sort((a, b) => b.revenue - a.revenue);
  const cogs = round(products.reduce((s, p) => s + p.total_cost, 0));
  const exp = round(Number(expenses) || 0);
  const result = round(totalNeto - cogs - exp);

  // Растеж/спад по артикул спрямо предходния равен период
  const prevRev = {}; for (const a of (prevRep && prevRep.articles || [])) prevRev[String(a.article_id)] = round(a.revenue);
  const movers = products.map(p => {
    const pv = prevRev[String(p.article_id)] || 0;
    const d = pv > 0 ? round((p.revenue - pv) / pv * 100) : (p.revenue > 0 ? null : 0);
    return { name: p.name, revenue: p.revenue, prev: pv, delta_abs: round(p.revenue - pv), delta_pct: d };
  });

  const avgCheck = accountsN ? round(totalNeto / accountsN) : 0;

  // ── Съвети/наблюдения ───────────────────────────────────────────────────────
  const insights = [];
  const money = n => round(n).toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  const byMonth = {}; for (const d in byDay) { const ym = d.slice(0, 7); byMonth[ym] = round((byMonth[ym] || 0) + byDay[d]); }
  const months = Object.keys(byMonth).sort(); const curYm = to.slice(0, 7); const full = months.filter(m => m < curYm);
  if (full.length >= 2) { const a = byMonth[full[full.length - 1]], b = byMonth[full[full.length - 2]]; if (b) { const d = (a - b) / b * 100;
    insights.push({ t: d >= 0 ? "good" : "bad", text: `Оборот ${full[full.length - 1]}: ${money(a)} — ${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(1)}% спрямо ${full[full.length - 2]} (${money(b)}).` }); } }
  if (totalNeto > 0) { const m = result / totalNeto * 100;
    insights.push({ t: m >= 35 ? "good" : m >= 20 ? "warn" : "bad", text: `Обща рентабилност: ${m.toFixed(1)}% (резултат ${money(result)} след ${money(exp)} разходи).` }); }
  if (totalNeto > 0) { const sh = Math.round(onlineNeto / totalNeto * 100);
    insights.push({ t: "info", text: `Онлайн (сайт): ${money(onlineNeto)} — ${sh}% от оборота (${onlineN} поръчки). Каса: ${money(counterNeto)} (${counterN}).` }); }
  const payTot = byPay.cash.neto + byPay.card.neto + byPay.other.neto;
  if (payUsed && payTot > 0) { const cp = Math.round(byPay.card.neto / payTot * 100);
    insights.push({ t: "info", text: `Плащане с карта: ${cp}% (${money(byPay.card.neto)}), в брой: ${money(byPay.cash.neto)}.` }); }
  const hoursArr = Object.keys(byHour).map(h => ({ h: +h, v: byHour[h] })).sort((a, b) => b.v - a.v);
  if (hoursArr.length) insights.push({ t: "info", text: `Най-силен час: ${String(hoursArr[0].h).padStart(2, "0")}:00 (${money(hoursArr[0].v)}).` });
  const pm = products.filter(p => p.revenue > 30).map(p => ({ p, m: p.profit / p.revenue * 100 }));
  if (pm.length) { const low = pm.slice().sort((a, b) => a.m - b.m)[0], hi = pm.slice().sort((a, b) => b.m - a.m)[0];
    insights.push({ t: low.m < 25 ? "warn" : "info", text: `Маржин по артикул: най-нисък ${low.p.name} (${low.m.toFixed(1)}%), най-висок ${hi.p.name} (${hi.m.toFixed(1)}%).` }); }
  const upList = movers.filter(m => m.delta_pct != null && m.prev > 20).sort((a, b) => b.delta_pct - a.delta_pct);
  if (upList.length) insights.push({ t: "good", text: `Най-растящ: ${upList[0].name} ▲ ${upList[0].delta_pct.toFixed(0)}% (${money(upList[0].revenue)}).` });
  const downList = movers.filter(m => m.delta_pct != null && m.prev > 20).sort((a, b) => a.delta_pct - b.delta_pct);
  if (downList.length && downList[0].delta_pct < 0) insights.push({ t: "warn", text: `Най-падащ: ${downList[0].name} ▼ ${Math.abs(downList[0].delta_pct).toFixed(0)}% (беше ${money(downList[0].prev)}, сега ${money(downList[0].revenue)}).` });

  return { from, to, prev_from: prevFrom, prev_to: prevTo, total_neto: totalNeto, accounts: accountsN,
    avg_check: avgCheck, by_day: byDay, by_hour: byHour, by_chan_day: byChanDay,
    online_neto: onlineNeto, counter_neto: counterNeto, online_n: onlineN, counter_n: counterN,
    pay: byPay, pay_used: payUsed, cogs, expenses: exp, result, products, by_cat: byCat, movers,
    units_truncated: unitsTrunc, insights,
    _debug: { acc_total: all.length, acc_sample: sample, pay: byPay, sales_ok: salesRep && salesRep.ok, sales_n: (salesRep && salesRep.articles || []).length, cat_n: Object.keys(cats).length } };
}

// ── Страница ─────────────────────────────────────────────────────────────────
function page(data, k) {
  const bg = n => round(n).toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const err = data && data.error;
  const tot = err ? 0 : (data.total_neto || 0);
  const pctOf = v => tot > 0 ? Math.round((Number(v) || 0) / tot * 100) + "%" : "—";
  const tips = err ? "" : (data.insights || []).map(x => `<li class="${x.t}"><span class="ic">${x.t === "good" ? "✅" : x.t === "warn" ? "⚠️" : x.t === "bad" ? "🔴" : "💡"}</span><span>${esc(x.text)}</span></li>`).join("");
  const pay = err ? { cash: {}, card: {}, other: {} } : data.pay;
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Каравелов · Дашборд</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script><style>
:root{color-scheme:light}*{box-sizing:border-box}
body{font:15px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#eef0f3;color:#14171a}
header{background:linear-gradient(135deg,#c8151f,#7a0c12);color:#fff;padding:16px 20px;position:sticky;top:0;z-index:5;box-shadow:0 2px 12px rgba(122,12,18,.3)}
header h1{margin:0;font-size:22px;font-weight:800}header .d{font-size:14px;opacity:.92;margin-top:3px}
.wrap{padding:16px;max-width:960px;margin:0 auto;display:grid;gap:16px}
form.period{display:flex;gap:8px;align-items:end;flex-wrap:wrap;background:#fff;border-radius:12px;padding:12px 14px;box-shadow:0 2px 8px rgba(20,23,26,.08)}
form.period label{font-size:12px;color:#555;display:block}
form.period input{font:14px system-ui;padding:6px 8px;border:1px solid #d7dade;border-radius:7px}
form.period button{font:14px system-ui;font-weight:700;padding:7px 14px;border:0;border-radius:7px;background:#c8151f;color:#fff;cursor:pointer}
.quick{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.quick a{font:12px system-ui;font-weight:700;text-decoration:none;color:#7a0c12;background:#f7e1e2;border-radius:20px;padding:5px 12px}
.quick a:hover{background:#f0cdcf}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.kpi{background:#fff;border-radius:12px;padding:14px 16px;box-shadow:0 2px 8px rgba(20,23,26,.08);border-left:5px solid #cfd4da;transition:transform .12s}
.kpi:hover{transform:translateY(-2px)}
.kpi .l{font-size:12px;color:#7a8087;text-transform:uppercase;letter-spacing:.4px}
.kpi .v{font-size:26px;font-weight:800;margin-top:4px;font-variant-numeric:tabular-nums}
.kpi .s{font-size:11px;color:#9aa0a6;margin-top:2px}
.kpi.turn{border-color:#b3121b}.kpi.turn .v{color:#b3121b}
.kpi.cost{border-color:#b06a00}.kpi.cost .v{color:#b06a00}
.kpi.res{border-color:#0a6b2e}.kpi.res .v{color:#0a6b2e}
.kpi.on{border-color:#2b6ca3}.kpi.on .v{color:#2b6ca3}
.kpi.card2{border-color:#7a4b8a}.kpi.card2 .v{color:#7a4b8a}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(20,23,26,.08)}
.card>h2{margin:0;font-size:15px;font-weight:800;color:#fff;background:#c8151f;padding:11px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.card>h2>span:not(.seg){font-size:12px;font-weight:600;opacity:.9}
.seg{display:flex;gap:4px}.seg button{font:12px system-ui;font-weight:700;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;background:rgba(255,255,255,.25);color:#fff}
.seg button.on{background:#fff;color:#b3121b}
.chartbox{padding:14px 16px 6px}.chartbox.donut{display:flex;justify-content:center}.chartbox canvas{max-height:300px}
details.tbl{border-top:1px solid #eef0f3}details.tbl>summary{cursor:pointer;padding:9px 16px;font-size:12px;font-weight:700;color:#7a8087;text-transform:uppercase;letter-spacing:.3px;list-style:none}
details.tbl>summary::-webkit-details-marker{display:none}details.tbl>summary::before{content:"▸ "}details.tbl[open]>summary::before{content:"▾ "}
table{width:100%;border-collapse:collapse}
th,td{padding:9px 14px;font-size:14px;border-top:1px solid #f1f2f4;text-align:left}
th{background:#f7f8fa;font-size:12px;color:#555;text-transform:uppercase;letter-spacing:.3px}
td.q,th.q{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td.q{font-weight:700}
td.c{text-align:right;color:#7a8087}tr:nth-child(even) td{background:#fafbfc}
.tips{list-style:none;margin:0;padding:8px 10px;display:grid;gap:8px}
.tips li{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;font-size:14px;line-height:1.35;background:#f7f8fa;border-left:5px solid #9aa0a6}
.tips li .ic{font-size:16px;flex:0 0 auto}.tips li.good{background:#eaf6ee;border-color:#0a6b2e}.tips li.warn{background:#fdf3e3;border-color:#b06a00}
.tips li.bad{background:#fdecec;border-color:#b3121b}.tips li.info{background:#eef3f8;border-color:#2b6ca3}
.split{display:flex;gap:16px;flex-wrap:wrap;padding:8px 8px 14px}.split table{flex:1;min-width:240px;border:1px solid #eef0f3;border-radius:10px;overflow:hidden}
.note{color:#7a8087;font-size:12px;text-align:center;margin:2px 0 20px}
.err{background:#fff;border-radius:12px;padding:24px;text-align:center;color:#b3121b}
@media(max-width:520px){th,td{padding:8px 10px;font-size:13px}.kpi .v{font-size:22px}}
</style></head><body>
<header><h1>🍱 Каравелов · Дашборд</h1><div class="d">${err ? "грешка" : esc(data.from) + " – " + esc(data.to) + " · " + (data.accounts || 0) + " сметки · оборот без ДДС"}</div></header>
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
  <div class="kpi cost"><div class="l">Себестойност${data.units_truncated ? " ⚠" : ""}</div><div class="v">${data.units_truncated ? "~" : ""}${bg(data.cogs)} €</div><div class="s">материали + опаковка</div></div>
  <div class="kpi res"><div class="l">Резултат</div><div class="v">${data.units_truncated ? "~" : ""}${bg(data.result)} €</div><div class="s">след ${bg(data.expenses)} € разходи</div></div>
  <div class="kpi"><div class="l">Сметки</div><div class="v">${data.accounts || 0}</div><div class="s">среден чек ${bg(data.avg_check)} €</div></div>
  <div class="kpi on"><div class="l">Онлайн (сайт)</div><div class="v">${bg(data.online_neto)} €</div><div class="s">${data.online_n || 0} поръчки · каса ${bg(data.counter_neto)} €</div></div>
  <div class="kpi card2"><div class="l">Плащане с карта</div><div class="v">${data.pay_used ? bg(pay.card.neto) + " €" : "—"}</div><div class="s">${data.pay_used ? "в брой " + bg(pay.cash.neto) + " €" : "няма данни за плащане"}</div></div>
</div>
<div class="card"><h2>Разбивка на оборота<span>${bg(data.total_neto)} € общо · без ДДС</span></h2>
  <div class="split">
    <table><thead><tr><th>По плащане</th><th class="q">Сума</th><th class="q">Дял</th><th class="q">Бр.</th></tr></thead><tbody>
      <tr><td>💵 В брой</td><td class="q">${bg(pay.cash.neto)} €</td><td class="q">${pctOf(pay.cash.neto)}</td><td class="c">${pay.cash.n || 0}</td></tr>
      <tr><td>💳 С карта</td><td class="q">${bg(pay.card.neto)} €</td><td class="q">${pctOf(pay.card.neto)}</td><td class="c">${pay.card.n || 0}</td></tr>
      ${pay.other && pay.other.neto > 0 ? `<tr><td>Друго</td><td class="q">${bg(pay.other.neto)} €</td><td class="q">${pctOf(pay.other.neto)}</td><td class="c">${pay.other.n || 0}</td></tr>` : ""}
    </tbody></table>
    <table><thead><tr><th>По канал</th><th class="q">Сума</th><th class="q">Дял</th><th class="q">Бр.</th></tr></thead><tbody>
      <tr><td>🏪 На място (каса)</td><td class="q">${bg(data.counter_neto)} €</td><td class="q">${pctOf(data.counter_neto)}</td><td class="c">${data.counter_n || 0}</td></tr>
      <tr><td>🌐 Сайт (онлайн)</td><td class="q">${bg(data.online_neto)} €</td><td class="q">${pctOf(data.online_neto)}</td><td class="c">${data.online_n || 0}</td></tr>
    </tbody></table>
  </div>
  ${data.pay_used ? "" : '<div class="note" style="margin:0 0 10px">⚠ Няма данни за начин на плащане по сметките за този период.</div>'}</div>
${tips ? `<div class="card"><h2>💡 Съвети / Наблюдения</h2><ul class="tips">${tips}</ul></div>` : ""}
<div class="card"><h2>Оборот по период<span class="seg" id="seg"><button data-g="day">Ден</button><button data-g="week">Седмица</button><button data-g="month" class="on">Месец</button></span></h2>
  <div class="chartbox"><canvas id="cTrend" height="150"></canvas></div>
  <details class="tbl" open><summary>таблица · сравнение спрямо предходния</summary>
  <table><thead><tr><th>Период</th><th class="q">Оборот без ДДС</th><th class="q">Δ предх.</th></tr></thead><tbody id="bkt"></tbody></table></details></div>
<div class="card"><h2>Сайт vs Каса по дни<span>оборот без ДДС</span></h2>
  <div class="chartbox"><canvas id="cChan" height="150"></canvas></div></div>
<div class="card"><h2>По категория<span>дял от оборота</span></h2>
  <div class="chartbox donut"><canvas id="cCat" height="260" style="max-width:420px"></canvas></div></div>
<div class="card"><h2>🕒 Часови пик<span>оборот по час на деня</span></h2>
  <div class="chartbox"><canvas id="cHour" height="140"></canvas></div></div>
<div class="card"><h2>🏆 Топ артикули · оборот · печалба<span class="seg" id="prodseg"><button data-s="revenue" class="on">по оборот</button><button data-s="profit">по печалба</button></span></h2>
  <table><thead><tr><th>Артикул</th><th class="q">Бройки</th><th class="q">Оборот</th><th class="q">Себест.</th><th class="q">Печалба</th><th class="q">Маржин</th></tr></thead>
  <tbody id="prodrows"></tbody></table></div>
<div class="card"><h2>📈 Растеж / спад<span>спрямо предх. период (${esc(data.prev_from)} – ${esc(data.prev_to)})</span></h2>
  <table><thead><tr><th>Артикул</th><th class="q">Сега</th><th class="q">Преди</th><th class="q">Промяна</th></tr></thead><tbody id="moverows"></tbody></table></div>
<div class="note">Всичко е <b>без ДДС</b>. Оборот = затворените сметки (÷1.2). „Онлайн" = клиент „Онлайн" (сайтът), „каса" = останалите. Себестойност и маржин идват от поддържаната таблица разходи (<b>costs.js</b>) — материали по артикул + опаковка по категория; в Barsy на точката няма цена на доставка. Плащане в брой/карта — от плащанията (Payments). Резултат = оборот − себестойност − разходи.${data.units_truncated ? " ⚠ Справката не се зареди докрай — числата може да са частични, презареди." : ""}</div>
<script>
var BYDAY=${err ? "{}" : JSON.stringify(data.by_day || {})};
var CHAN=${err ? "{}" : JSON.stringify(data.by_chan_day || {})};
var BYHOUR=${err ? "{}" : JSON.stringify(data.by_hour || {})};
var BYCAT=${err ? "{}" : JSON.stringify(data.by_cat || {})};
var PRODUCTS=${err ? "[]" : JSON.stringify(data.products || [])};
var MOVERS=${err ? "[]" : JSON.stringify(data.movers || [])};
function bgn(n){return (Math.round((n||0)*100)/100).toLocaleString('bg-BG',{minimumFractionDigits:2,maximumFractionDigits:2})}
function wk(iso){var d=new Date(iso+'T12:00:00Z');var day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day);return d.toISOString().slice(0,10)}
function bucketize(g){var b={};Object.keys(BYDAY).forEach(function(d){var key=g==='day'?d:g==='week'?wk(d):d.slice(0,7);b[key]=(b[key]||0)+BYDAY[d]});return b}
function dpct(cur,prev){return (prev!=null&&prev!==0)?((cur-prev)/prev*100):null}
function dcell(d){if(d==null)return '<td class="c">—</td>';var c=d>=0?'#0a6b2e':'#b3121b';return '<td class="q" style="color:'+c+';font-weight:800">'+(d>=0?'▲ ':'▼ ')+Math.abs(d).toFixed(1)+'%</td>'}
var trendChart=null;
function render(g){var b=bucketize(g);var keys=Object.keys(b).sort();var vals=keys.map(function(k){return Math.round((b[k]||0)*100)/100});
  var deltas=keys.map(function(k,i){return dpct(b[k],i>0?b[keys[i-1]]:null)});
  var h='';for(var i=keys.length-1;i>=0;i--){var lab=g==='week'?'седм. от '+keys[i]:keys[i];h+='<tr><td>'+lab+'</td><td class="q">'+bgn(b[keys[i]])+' €</td>'+dcell(deltas[i])+'</tr>'}
  var bkt=document.getElementById('bkt');if(bkt)bkt.innerHTML=h||'<tr><td colspan="3" class="note">няма данни</td></tr>';
  if(window.Chart){var ctx=document.getElementById('cTrend');if(trendChart)trendChart.destroy();
    trendChart=new Chart(ctx,{type:'line',data:{labels:keys,datasets:[{label:'Оборот',data:vals,borderColor:'#b3121b',backgroundColor:'rgba(179,18,27,.12)',fill:true,tension:.3,pointRadius:2,pointHoverRadius:5,borderWidth:2}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return bgn(c.parsed.y)+' €'}}}},scales:{y:{ticks:{callback:function(v){return bgn(v)}}},x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:14}}}}});}}
document.querySelectorAll('#seg button').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('#seg button').forEach(function(x){x.className=''});b.className='on';render(b.getAttribute('data-g'))})});
render('month');
// Сайт vs Каса по дни
if(window.Chart){var dk=Object.keys(CHAN).sort();
  new Chart(document.getElementById('cChan'),{type:'line',data:{labels:dk,datasets:[
    {label:'Каса',data:dk.map(function(d){return Math.round((CHAN[d].counter||0)*100)/100}),borderColor:'#c8151f',backgroundColor:'rgba(200,21,31,.10)',fill:true,tension:.3,pointRadius:0,borderWidth:2},
    {label:'Сайт',data:dk.map(function(d){return Math.round((CHAN[d].online||0)*100)/100}),borderColor:'#2b6ca3',backgroundColor:'rgba(43,108,163,.10)',fill:true,tension:.3,pointRadius:0,borderWidth:2}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:12}},tooltip:{callbacks:{label:function(c){return c.dataset.label+': '+bgn(c.parsed.y)+' €'}}}},scales:{y:{ticks:{callback:function(v){return bgn(v)}}},x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:14}}}}});}
// По категория (донат)
if(window.Chart){var ck=Object.keys(BYCAT).sort(function(a,b){return BYCAT[b]-BYCAT[a]});var cl=ck.slice(0,8);var rest=ck.slice(8).reduce(function(s,k){return s+BYCAT[k]},0);
  var labels=cl.slice();var vals=cl.map(function(k){return Math.round(BYCAT[k]*100)/100});if(rest>0){labels.push('други');vals.push(Math.round(rest*100)/100)}
  var cols=['#b3121b','#2b6ca3','#b06a00','#7a4b8a','#0a6b2e','#0d7a6f','#8a6608','#c8151f','#9aa0a6'];
  if(labels.length)new Chart(document.getElementById('cCat'),{type:'doughnut',data:{labels:labels,datasets:[{data:vals,backgroundColor:cols,borderWidth:2,borderColor:'#fff'}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'58%',plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:12}}},tooltip:{callbacks:{label:function(c){var s=c.dataset.data.reduce(function(a,b){return a+b},0);return c.label+': '+bgn(c.parsed)+' € ('+(s?Math.round(c.parsed/s*100):0)+'%)'}}}}}});}
// Часови пик
if(window.Chart){var hh=[];for(var i=0;i<24;i++)hh.push(i);var hv=hh.map(function(h){return Math.round((BYHOUR[h]||0)*100)/100});
  new Chart(document.getElementById('cHour'),{type:'bar',data:{labels:hh.map(function(h){return (h<10?'0':'')+h+'ч'}),datasets:[{label:'Оборот',data:hv,backgroundColor:'#b06a00',borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return bgn(c.parsed.y)+' €'}}}},scales:{y:{ticks:{callback:function(v){return bgn(v)}}}}}});}
// Топ артикули
function renderProducts(s){var body=document.getElementById('prodrows');if(!body)return;var arr=PRODUCTS.slice().sort(function(a,b){return (b[s]||0)-(a[s]||0)});
  var h=arr.slice(0,40).map(function(p){var m=p.revenue>0?Math.round(p.profit/p.revenue*1000)/10:0;var mc=m>=40?'#0a6b2e':m>=25?'#b06a00':'#b3121b';
    return '<tr><td class="n">'+p.name+'</td><td class="c">'+bgn(p.units)+'</td><td class="q">'+bgn(p.revenue)+' €</td><td class="q" style="color:#b06a00">'+bgn(p.total_cost)+' €</td><td class="q" style="color:#0a6b2e">'+bgn(p.profit)+' €</td><td class="q" style="color:'+mc+';font-weight:800">'+m.toLocaleString('bg-BG',{minimumFractionDigits:1,maximumFractionDigits:1})+'%</td></tr>'}).join('');
  body.innerHTML=h||'<tr><td colspan="6" class="note">Няма продажби в периода.</td></tr>'}
document.querySelectorAll('#prodseg button').forEach(function(b){b.addEventListener('click',function(){document.querySelectorAll('#prodseg button').forEach(function(x){x.className=''});b.className='on';renderProducts(b.getAttribute('data-s'))})});
renderProducts('revenue');
// Растеж/спад
(function(){var body=document.getElementById('moverows');if(!body)return;
  var arr=MOVERS.filter(function(m){return m.delta_pct!=null&&m.prev>10}).sort(function(a,b){return b.delta_pct-a.delta_pct});
  var top=arr.slice(0,8),bot=arr.slice(-8).reverse();var seen={};var list=top.concat(bot).filter(function(m){if(seen[m.name])return false;seen[m.name]=1;return true});
  var h=list.map(function(m){var c=m.delta_pct>=0?'#0a6b2e':'#b3121b';return '<tr><td class="n">'+m.name+'</td><td class="q">'+bgn(m.revenue)+' €</td><td class="c">'+bgn(m.prev)+' €</td><td class="q" style="color:'+c+';font-weight:800">'+(m.delta_pct>=0?'▲ ':'▼ ')+Math.abs(m.delta_pct).toFixed(0)+'%</td></tr>'}).join('');
  body.innerHTML=h||'<tr><td colspan="4" class="note">Няма достатъчно данни за сравнение.</td></tr>'})();
// бързи периоди
(function(){var q=document.getElementById('quick');if(!q)return;var y=new Date().getFullYear();var t=new Date().toISOString().slice(0,10);
  var m0=t.slice(0,7)+'-01';var qs=[[y+' г.',y+'-01-01',t],['този месец',m0,t],['30 дни',new Date(Date.now()-30*864e5).toISOString().slice(0,10),t],['7 дни',new Date(Date.now()-7*864e5).toISOString().slice(0,10),t]];
  qs.forEach(function(o){var a=document.createElement('a');a.textContent=o[0];a.href='?view=dashboard${k ? "&k=" + encodeURIComponent(k) : ""}&from='+o[1]+'&to='+o[2];q.appendChild(a)})})();
</script>`}
</div></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
  if (!okV) { res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:24px'>Няма достъп — липсва или грешен ключ (?k=).</body>"); return; }
  const user = process.env.BARSY_USER, pass = process.env.BARSY_PASS;
  if (!user || !pass) { res.status(500).send("Не е конфигуриран достъп до Barsy."); return; }
  const today = sofiaToday();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : today.slice(0, 4) + "-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : today;
  const expenses = Number(q.exp) || 0;
  let data;
  try { data = await shopDashData(from, to, expenses, user, pass); }
  catch (e) { data = { from, to, error: "Не мога да прочета данните сега. Опитай пак след минута. (" + String(e && e.message) + ")" }; }
  if (q.debug === "1") { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.status(200).send(JSON.stringify(data, null, 2)); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(page(data, q.k));
};
