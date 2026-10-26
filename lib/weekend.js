// ★ S36 — петъчно „Добър уикенд“: оборот на точката за седмицата (само към собственика).
// Vercel cron в петък вика два пъти (UTC); run() праща само в 19 ч София (след затваряне).
const TG = require("./telegram.js");

const SHOP_API = "https://motamoshop.barsy.online", SHOP_BID = 1;
const sofiaHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(new Date()));
const sofiaWeekday = () => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", weekday: "short" }).format(new Date());
const eur = n => (Math.round(n * 100) / 100).toLocaleString("bg-BG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DN = { 1: "пн", 2: "вт", 3: "ср", 4: "чт", 5: "пт" };

async function accounts() {
  const user = process.env.BARSY_USER, pass = process.env.BARSY_PASS;
  if (!user || !pass) throw new Error("no_barsy_creds");
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const r = await fetch(`${SHOP_API}/endpoints/json/Accounts_getlist?bid=${SHOP_BID}`, {
    method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ order_by: "account_id desc", length: 2600 }), signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  const a = Array.isArray(d) ? d : (d && (d.list || Object.values(d))) || [];
  return Array.isArray(a) ? a : [];
}

async function run(opts) {
  opts = opts || {};
  if (!opts.force && (sofiaWeekday() !== "Fri" || sofiaHour() !== 19)) return { ok: true, skipped: "not_friday_19" };
  const today = TG.sofiaDate();
  const mon = addDays(today, -4), prevMon = addDays(mon, -7);       // петък → понеделник
  const list = await accounts();
  const sum = { cur: {}, prev: {} }, cnt = { cur: 0, prev: 0 };
  for (const a of list) {
    if (String(a.account_alias || "").includes("CLTEST")) continue;
    const day = String(a.create_date || "").slice(0, 10), v = Number(a.total_sum) || 0;
    if (!(v > 0)) continue;
    const key = day >= mon && day <= today ? "cur" : (day >= prevMon && day <= addDays(prevMon, 4) ? "prev" : null);
    if (!key) continue;
    sum[key][day] = (sum[key][day] || 0) + v; cnt[key]++;
  }
  const tot = o => Object.values(o).reduce((s, x) => s + x, 0);
  const cur = tot(sum.cur), prev = tot(sum.prev);
  const days = Object.keys(sum.cur).sort();
  const best = days.slice().sort((a, b) => sum.cur[b] - sum.cur[a])[0];
  const cmp = prev ? `${Math.round((cur / prev - 1) * 100) >= 0 ? "+" : ""}${Math.round((cur / prev - 1) * 100)} % спрямо миналата седмица (${eur(prev)} €)` : "няма база за сравнение";
  const text = `🎉 <b>Добър уикенд!</b>\n\n🏪 Точката тази седмица (пн–пт): <b>${eur(cur)} €</b> с ДДС · ${cnt.cur} сметки · среден чек ${cnt.cur ? eur(cur / cnt.cur) : "0,00"} €\n📈 ${cmp}`
    + (best ? `\n🏆 Най-силен ден: ${DN[new Date(best + "T12:00:00Z").getUTCDay()] || best} — ${eur(sum.cur[best])} €` : "")
    + `\n\nБлагодаря за добрата седмица! Почивайте си. 🌿`;
  const r = await TG.tgSend(text, TG.OWNER_CHAT_ID).catch(() => ({}));
  return { ok: !!r.ok, cur: Math.round(cur * 100) / 100, prev: Math.round(prev * 100) / 100, n: cnt.cur };
}

module.exports = { run };
