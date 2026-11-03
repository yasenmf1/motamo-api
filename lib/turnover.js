// lib/turnover.js — „точка: оборот" от Telegram: оборот на точката до момента (щанд/онлайн/от реклама, спрямо същия ден миналата седмица).
// Само четене. Същата логика като tasks/turnover.py (14:30/17:30/19:30 в GitHub Actions).
const TG = require("./telegram.js");

async function report(shopCall) {
  const r = await shopCall("Accounts_getlist", { order_by: "account_id desc", length: 600 });
  const raw = r && r.data;
  const data = Array.isArray(raw) ? raw : Object.values(raw || {});
  if (!data.length) return "Оборотът не се чете: Barsy на точката не отговори.";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(new Date());
  const g = t => (parts.find(p => p.type === t) || {}).value;
  const today = `${g("year")}-${g("month")}-${g("day")}`, hm = `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}:${g("second")}`;
  const week = new Date(Date.parse(today + "T12:00:00Z") - 7 * 86400000).toISOString().slice(0, 10);
  const day = d => data.filter(a => String(a.create_date || "").slice(0, 10) === d && String(a.create_date).slice(11) <= hm && Number(a.total_sum || 0) > 0);
  const sum = L => Math.round(L.reduce((s, a) => s + Number(a.total_sum), 0) * 100) / 100;
  const T = day(today), W = day(week);
  const on = T.filter(a => a.user_name === "Motamo Online"), cn = T.filter(a => a.user_name !== "Motamo Online");
  let ads = "";
  try {
    const q = await fetch(`${TG.SB_URL}/rest/v1/order_attribution?created_at=gte.${today}T00:00:00%2B02:00&select=total,utm_source,fbclid`, { headers: TG.sbH });
    if (q.ok) { const rows = await q.json(); const fb = rows.filter(x => x.utm_source === "facebook" || x.fbclid);
      ads = `, от реклама ${fb.length}` + (fb.length ? ` (${Math.round(fb.reduce((s, x) => s + Number(x.total || 0), 0) * 100) / 100} €)` : ""); }
  } catch (e) {}
  const dn = ["нд", "пн", "вт", "ср", "чт", "пт", "сб"][new Date(today + "T12:00:00Z").getUTCDay()];
  const cmp = sum(W) ? `${Math.round((sum(T) / sum(W) - 1) * 100) >= 0 ? "+" : ""}${Math.round((sum(T) / sum(W) - 1) * 100)} %` : "няма база";
  const chk = T.length ? Math.round(sum(T) / T.length * 100) / 100 : 0;
  const dd = `${today.slice(8, 10)}.${today.slice(5, 7)}`;
  return `🏪 Точка ${dd} до ${hm.slice(0, 5)}: ${sum(T)} € · ${T.length} сметки · чек ${chk} €\nЩанд ${sum(cn)} € (${cn.length}) · Онлайн ${sum(on)} € (${on.length})${ads} · спрямо мин. ${dn} ${cmp}`;
}

module.exports = { report };
