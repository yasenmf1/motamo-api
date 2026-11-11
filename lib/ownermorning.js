// lib/ownermorning.js — утринно табло в Telegram (08:00 София): последният работен ден за точката и цеха, месецът с прогноза,
// какво да се поръча, наблюдения за цеха, пратени поръчки. Само текст от вече смятаните части на таблото на собственика (lib/ownerdash.js).
const WD = ["неделя", "понеделник", "вторник", "сряда", "четвъртък", "петък", "събота"];
const WD_ON = ["неделя", "понеделник", "вторник", "сряда", "четвъртък", "петък", "събота"];
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const eur = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " €";
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const dm = (iso) => iso.slice(8) + "." + iso.slice(5, 7);
const plusDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
// сравнение с минимална база (като на таблото): под 50 € не вдигаме „▲ 400 %“
const cmp = (cur, base, txt) => (base != null && base >= 50) ? ` (${cur >= base ? "▲" : "▼"} ${Math.abs(Math.round((cur - base) / base * 100))}% ${txt})` : "";

// последният ден с продажби преди днес и същият ден от седмицата преди това
function lastWork(series, to) {
  const by = {}; for (const x of series || []) by[x.d] = x.v;
  for (let i = 1; i <= 7; i++) { const d = plusDays(to, -i); if ((by[d] || 0) > 0) return { d, v: by[d], prev: by[plusDays(d, -7)] != null ? by[plusDays(d, -7)] : null }; }
  return null;
}

// P = { point, cex, stock, orders } — резултати на partData (някои може да липсват); to = днешната дата в София (YYYY-MM-DD)
function build(P, to) {
  const out = [`☀️ <b>Добро утро! Табло · ${WD[dow(to)]} ${dm(to)}</b>`];
  const wk = (x) => `${WD[dow(x.d)].slice(0, 3)} ${dm(x.d)}`;
  if (P.point && P.point.series) {
    const w = lastWork(P.point.series, to);
    out.push(w ? `🏪 <b>Точка</b> · ${wk(w)}: <b>${eur(w.v)}</b>${cmp(w.v, w.prev, "спрямо миналата седмица")}` : "🏪 Точка: няма продажби последните дни");
  }
  if (P.cex && P.cex.series) {
    const w = lastWork(P.cex.series, to);
    out.push(w ? `🏭 <b>Цех</b> · ${wk(w)}: <b>${eur(w.v)}</b>${cmp(w.v, w.prev, "спрямо миналата седмица")}` : "🏭 Цех: няма продажби последните дни");
  }
  // заявки на магазините (cex_shop_requests) и колко от тях още нямат стокова: днес, по-рано (забравени) и за утре
  let warn = 0;
  if (P.reqs && P.reqs.length) {
    const t = P.reqs.find(x => x.d === to), tm = P.reqs.find(x => x.d === plusDays(to, 1));
    const bits = [`${t ? t.n : 0} за днес · без стокови: <b>${t ? t.noStok : 0}</b>`];
    if (tm && tm.n) bits.push(`за утре: ${tm.n}`);
    out.push("📝 <b>Заявки</b> " + bits.join(" · "));
    const old = P.reqs.filter(x => x.d < to && x.noStok > 0);
    if (old.length) { out.push("⚠️ Без стокова от по-рано: " + old.map(x => `${dm(x.d)} — ${x.noStok}`).join(", ")); warn++; }
  }
  const mp = [];
  if (P.point && P.point.fc) mp.push(`точка ${eur(P.point.fc.mtd)} (прогноза ${eur(P.point.fc.proj)})`);
  if (P.cex && P.cex.fc) mp.push(`цех ${eur(P.cex.fc.mtd)} (прогноза ${eur(P.cex.fc.proj)})`);
  if (mp.length) out.push("📅 Месец до днес: " + mp.join(" · "));
  if (P.stock) {
    if (P.stock.zero_n) { out.push(`⛔ <b>На нула в склада:</b> ${P.stock.zero_n}`); warn++; }
    if (P.stock.risk_n) { out.push(`🛒 <b>За поръчка:</b> ${P.stock.risk_n} арт. — ` + P.stock.groups.slice(0, 4).map(g => `${esc(g.sup)} ${g.n}`).join(", ")); warn++; }
  }
  const facts = ((P.cex && P.cex.facts) || []).filter(f => f.t === "warn" || f.t === "down").slice(0, 3);
  facts.forEach(f => { out.push("⚠️ " + esc(f.text)); warn++; });
  if (P.orders && P.orders.items) {
    const y = plusDays(to, -1), n = P.orders.items.filter(o => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date(o.at)) === y).length;
    if (n) out.push(`📨 Пратени поръчки вчера: ${n}`);
  }
  if (!warn) out.push("✅ Нищо спешно.");
  return out.join("\n");
}

module.exports = { build, lastWork, eur };
