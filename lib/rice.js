// lib/rice.js — „ориз": колко от сутрешните 12 кг сварен ориз са изразходвани на точката и трябва ли допълнителна доставка.
// Само четене. Изразходено = продажби днес (Reports_sales_by_articles) × рецептите (lib/shop-recipes.js, лист 287 „заг. Сварен суши ориз").
// Остатъкът до края на деня се оценява по два начина и се взима средното:
//   а) по дела на оборота след часа на проверката в същия ден от седмицата (последните 4 седмици, Accounts_getlist);
//   б) по средния дневен разход на ориз в същия ден от седмицата (последните 4 седмици) минус изразходеното днес.
const R = require("./shop-recipes.js").units;
const TG = require("./telegram.js");

const RICE_ID = "287";
const DELIVERED_KG = Number(process.env.RICE_DELIVERY_KG) || 12;
const WEEKS = 4;
const MARGIN_KG = 0.5;      // малка резерва над сметката
const STEP_KG = 0.5;        // доставката се закръгля нагоре на 0,5 кг

const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const r1 = x => Math.round(x * 10) / 10;
const fmt = x => String(r1(x)).replace(".", ",");

async function riceUsedOn(shopCall, day) {
  const by = {};
  for (let pg = 1; pg <= 6; pg++) {
    const r = await shopCall("Reports_sales_by_articles", { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { ref_date: [day, day] } });
    const rows = (r && r.ok && r.data && Array.isArray(r.data.rows)) ? r.data.rows : null;
    if (!rows) throw new Error("справката за продажби не се прочете");
    for (const x of rows) by[String(x.article_id)] = (by[String(x.article_id)] || 0) + (Number(x.cnt) || 0);
    if (rows.length < 50) break;
  }
  let kg = 0;
  for (const [aid, cnt] of Object.entries(by)) { const rc = R[aid]; if (rc && rc.leaves[RICE_ID]) kg += cnt * rc.leaves[RICE_ID]; }
  return kg;
}

async function afterShare(shopCall, days, cutHM) {
  const from = days[days.length - 1], to = days[0];
  const r = await shopCall("Accounts_getlist", { filters: { ref_date: [from, to] }, length: 6000, order_by: "account_id desc" });
  const raw = r && r.data, list = Array.isArray(raw) ? raw : Object.values(raw || {});
  let tot = 0, late = 0;
  for (const a of list) {
    const d = String(a.create_date || "").slice(0, 10), t = String(a.create_date || "").slice(11, 16), v = Number(a.total_sum || 0);
    if (!days.includes(d) || !(v > 0)) continue;
    tot += v; if (t >= cutHM) late += v;
  }
  return tot > 0 ? late / tot : null;
}

// Колко ориз е реално изпратено на точката днес (изпълнени заявки за прехвърляне, shop_id 287). Няма ли такива → приемаме DELIVERED_KG.
async function deliveredToday(today) {
  try {
    const q = `${TG.SB_URL}/rest/v1/transfer_requests?status=eq.done&updated_at=gte.${addDays(today, -1)}T21:00:00Z&select=items,updated_at&limit=50`;
    const r = await fetch(q, { headers: TG.sbH, signal: AbortSignal.timeout(6000) });
    const rows = r.ok ? await r.json() : [];
    let kg = 0;
    for (const x of rows) {
      if (TG.sofiaDate(new Date(x.updated_at)) !== today) continue;
      for (const it of (Array.isArray(x.items) ? x.items : [])) if (Number(it.shop_id) === Number(RICE_ID)) kg += Number(it.sent != null ? it.sent : it.qty) || 0;
    }
    return kg > 0 ? kg : null;
  } catch (e) { return null; }
}

// → { text, extra_kg, used, left, need }
async function check(shopCall, now) {
  const today = TG.sofiaDate(now);
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false }).format(now || new Date());
  const past = []; for (let i = 1; i <= WEEKS; i++) past.push(addDays(today, -7 * i));
  const [usedToday, pastKg, share] = await Promise.all([
    riceUsedOn(shopCall, today),
    Promise.all(past.map(d => riceUsedOn(shopCall, d).catch(() => null))),
    afterShare(shopCall, past, hm).catch(() => null)
  ]);
  const okPast = pastKg.filter(x => x != null && x > 1);
  const avgTotal = okPast.length ? okPast.reduce((a, b) => a + b, 0) / okPast.length : null;
  const ests = [];
  if (share != null && share < 0.9) ests.push(usedToday * share / (1 - share));
  if (avgTotal != null) ests.push(Math.max(avgTotal - usedToday, 0));
  if (!ests.length) return { text: "🍚 Ориз: не мога да сметна — няма достатъчно данни за предишните седмици.", extra_kg: null };
  const need = ests.reduce((a, b) => a + b, 0) / ests.length;
  const delivered = (await deliveredToday(today)) || DELIVERED_KG;
  const left = delivered - usedToday;
  const gap = need + MARGIN_KG - left;
  const extra = gap > 0.25 ? Math.ceil(gap / STEP_KG - 1e-9) * STEP_KG : 0;
  const lines = [`🍚 Ориз ${today.slice(8, 10)}.${today.slice(5, 7)} към ${hm}`,
    `Доставени днес: ${fmt(delivered)} кг · изразходени: ${fmt(usedToday)} кг · остават: ${fmt(left)} кг`,
    `До края на деня ще трябват още около ${fmt(need)} кг.`];
  lines.push(extra > 0 ? `👉 Поръчайте допълнително ${fmt(extra)} кг сега.` : (left - need > 3 ? `✅ Не поръчвайте. Има риск да останат около ${fmt(left - need)} кг, които ще се изхвърлят.` : "✅ Стига. Не поръчвайте допълнително."));
  return { text: lines.join("\n"), extra_kg: extra, used: usedToday, left, need };
}

module.exports = { check };
