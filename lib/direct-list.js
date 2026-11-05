// lib/direct-list.js — понеделнишки списък „какво да заредиш на точката с доставка директно в Barsy" (05.11, по искане на собственика).
// Само четене. Артикулите са съставките от lib/point-direct.js (не се заявяват от цеха).
// Седмичен разход = продажби за последните 14 дни (Reports_sales_by_articles) × рецептите (point-direct.units), средно на седмица.
// Предложение = разход за седмица × резерва − наличност днес (Articles_getlistobject, депо 1), закръглено нагоре. Нищо не записва в Barsy:
// собственикът казва какво е заредил и записът се прави само след неговото „да".
const D = require("./point-direct.js");
const TG = require("./telegram.js");

const DAYS = 14;
const RESERVE = 1.25;                 // малка резерва над седмичния разход
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const fmt = x => String(Math.round(x * 100) / 100).replace(".", ",");
const stepFor = unit => (unit === "бр" ? 1 : 0.5);
const ceilTo = (x, s) => Math.ceil(x / s - 1e-9) * s;

async function soldOn(shopCall, day) {
  const by = {};
  for (let pg = 1; pg <= 6; pg++) {
    const r = await shopCall("Reports_sales_by_articles", { active_struct_id: "eStructList_1", action_type: "values", page_num: pg, filters: { ref_date: [day, day] } });
    const rows = (r && r.ok && r.data && Array.isArray(r.data.rows)) ? r.data.rows : null;
    if (!rows) throw new Error("справката за продажби не се прочете");
    for (const x of rows) by[String(x.article_id)] = (by[String(x.article_id)] || 0) + (Number(x.cnt) || 0);
    if (rows.length < 50) break;
  }
  return by;
}

async function stockNow(shopCall) {
  const r = await shopCall("Articles_getlistobject", { filters: { depot_id: 1 }, extra_properties: ["store_amount"] });
  const raw = r && r.data, list = Array.isArray(raw) ? raw : Object.values((raw && raw.list) || raw || {});
  if (!list.length) throw new Error("наличностите не се прочетоха");
  const m = {};
  for (const a of list) { const id = a && (a.article_id || a.id); if (id != null) { const q = Number(a.store_amount); m[String(id)] = isNaN(q) ? 0 : q; } }
  return m;
}

// → { text, rows:[{id,name,unit,stock,week,load}] }
async function build(shopCall, now) {
  const today = TG.sofiaDate(now || new Date());
  const days = []; for (let i = 1; i <= DAYS; i++) days.push(addDays(today, -i));
  const [stock, perDay] = await Promise.all([stockNow(shopCall), Promise.all(days.map(d => soldOn(shopCall, d).catch(() => null)))]);
  const okDays = perDay.filter(Boolean);
  if (okDays.length < DAYS / 2) throw new Error("няма достатъчно данни за продажбите");
  const used = {};
  for (const by of okDays) for (const [uid, cnt] of Object.entries(by)) {
    const u = D.units[uid]; if (!u) continue;
    for (const [lid, q] of Object.entries(u.leaves)) used[lid] = (used[lid] || 0) + cnt * q;
  }
  const weeks = okDays.length / 7, rows = [];
  for (const [id, it] of Object.entries(D.items)) {
    if (it.name === "Вода") continue;
    const week = (used[id] || 0) / weeks, st = stock[id] != null ? stock[id] : 0;
    const need = week * RESERVE - st;
    const load = need > 0.0001 && week > 0 ? ceilTo(need, stepFor(it.unit)) : 0;
    rows.push({ id, name: it.name, unit: it.unit, stock: st, week, load });
  }
  rows.sort((a, b) => (b.load > 0) - (a.load > 0) || a.name.localeCompare(b.name, "bg"));
  const need = rows.filter(r => r.load > 0), ok = rows.filter(r => r.load === 0 && r.week > 0);
  const L = [`📦 Зареждане на точката — седмичен списък ${today.slice(8, 10)}.${today.slice(5, 7)}`, "Това, което не идва от цеха (доставка директно в Barsy на точката)."];
  if (need.length) {
    L.push("", "👉 Заредете:");
    for (const r of need) L.push(`• ${r.name}: ${fmt(r.load)} ${r.unit}  (на склад ${fmt(r.stock)}, седмица ≈ ${fmt(r.week)})`);
  } else L.push("", "✅ Нищо не трябва да се зарежда тази седмица.");
  if (ok.length) L.push("", "Достатъчно: " + ok.map(r => `${r.name} (${fmt(r.stock)} ${r.unit})`).join(", "));
  L.push("", "Кажи ми какво си заредил и го записвам в Barsy след твоето „да“.");
  return { text: L.join("\n"), rows };
}

module.exports = { build };
