// ★ S25 — Шофьорът на буса в Telegram (@MOTAMO_BOT, роля „shofior").
// „маршрут" → спирките за днес (само с СТОКОВА за деня, по реда на собственика) + Google Maps
// навигация (жив трафик) + бутон за всяка спирка → ✅ Заредено / ⚠️ Проблем (причина + снимка/бележка)
// → всичко при собственика. Живо местоположение → при <150 м от спирка ботът пита „Стигна ли X?".
// Мястото на спирката се научава при първото „Заредено" (последната позиция на шофьора ≤ 10 мин).
const TG = require("./telegram.js");
const { ROUTE, stopKey, mapsLinks, distM } = require("./route.js");

const SB_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0emd4cmVvamZ2ZGx0YmF2bG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjIxNzksImV4cCI6MjEwMTgzODE3OX0.o4i60i2Q9eCEhEOjw8OLmNqAkXVXpnqYYvx9_9BrkPs";
const sbH = { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" };
async function sb(path, opts) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...(opts || {}), headers: { ...sbH, ...((opts && opts.headers) || {}) } });
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
const upsert = (table, conflict, row) => sb(`${table}?on_conflict=${conflict}`, { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([row]) });

const REASONS = { 1: "Разминаване със стоковата", 2: "Липса на етикет", 3: "Лош търговски вид", 4: "Друго" };
const NEAR_M = 150, GEO_FRESH_MS = 10 * 60 * 1000;
// Отвореният проблем (за бележка/снимка) важи 30 мин или до следващото „Заредено".
function pendingKey(u) {
  if (!u || !u.pending) return null;
  const [key, ts] = String(u.pending).split("|");
  return Date.now() - Number(ts || 0) < 30 * 60 * 1000 ? key : null;
}
const DOW_BG = ["неделя", "понеделник", "вторник", "сряда", "четвъртък", "петък", "събота"];

// Спирките за деня: ROUTE ∩ обектите със стокова днес (cex-plan driver_stops).
async function todayStops(host) {
  const date = TG.sofiaDate(), dow = new Date(date + "T12:00:00Z").getUTCDay();
  const tok = [process.env.RECONCILE_TOKEN, process.env.PAY_HMAC_SECRET, process.env.PREVIEW_TOKEN, process.env.CEX_VIEW_TOKEN].find(Boolean);
  const r = await fetch(`https://${host || "motamo-api.vercel.app"}/api/cex-plan`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tok, action: "driver_stops", date }) });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) return { ok: false, error: j.error || "няма връзка с цеха", date };
  const have = new Set(j.keys || []);
  const stops = ROUTE.filter(s => (!s.onlyDow || s.onlyDow.includes(dow)) && s.keys.some(k => have.has(k)))
    .map((s, i) => ({ key: stopKey(s), name: s.name, addr: s.addr, n: i + 1 }));
  return { ok: true, date, dow, stops };
}
async function logFor(date) {
  const rows = await sb(`cex_route_log?for_date=eq.${date}&select=stop_key,status,reason`).catch(() => []);
  const m = {}; for (const r of rows || []) m[r.stop_key] = r; return m;
}
const mark = st => !st ? "⬜" : st.status === "ok" ? "✅" : st.status === "problem" ? "⚠️" : "⬜";

function routeKeyboard(stops, log) {
  const kb = mapsLinks(stops).map(l => [{ text: `🗺 Навигация ${l.from}–${l.to}`, url: l.url }]);
  for (const s of stops) kb.push([{ text: `${mark(log[s.key])} ${s.n}. ${s.name}`, callback_data: `st:${s.key}` }]);
  return { inline_keyboard: kb };
}
async function sendRoute(chatId, host) {
  const t = await todayStops(host);
  if (!t.ok) { await TG.tgSend("⚠️ Не мога да взема маршрута: " + TG.escHtml(t.error), chatId); return; }
  if (!t.stops.length) { await TG.tgSend("Днес няма издадени стокови — няма спирки. Ако сега се издават, напиши пак <b>маршрут</b> след малко.", chatId); return; }
  const log = await logFor(t.date);
  const done = t.stops.filter(s => log[s.key] && log[s.key].status !== "prompted").length;
  await TG.tgSend(`🚚 <b>Маршрут за ${DOW_BG[t.dow]}</b> — ${t.stops.length} спирки` + (done ? ` (готови ${done})` : "")
    + "\n\nНавигацията е в Google Maps с живия трафик. Натисни спирката, когато стигнеш.\n💡 Сподели <b>живо местоположение</b> тук (📎 → Местоположение → На живо) и ботът сам ще пита на всяка спирка.",
    chatId, t.date, routeKeyboard(t.stops, log));
  if (!done) await TG.tgSend(`🚚 Шофьорът тръгна — <b>${t.stops.length} спирки</b> днес.`, TG.OWNER_CHAT_ID, t.date);
}
async function stopMenu(chatId, key, prompt) {
  const s = ROUTE.find(x => stopKey(x) === key); if (!s) return;
  await TG.tgSend((prompt ? "📍 Стигна ли <b>" : "📍 <b>") + TG.escHtml(s.name) + (prompt ? "</b>?" : "</b>"), chatId, TG.sofiaDate(),
    { inline_keyboard: [[{ text: "✅ Заредено", callback_data: `ok:${key}` }, { text: "⚠️ Проблем", callback_data: `pb:${key}` }],
      [{ text: "🗺 Навигация дотук", url: "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + encodeURIComponent(s.addr) }]] });
}
async function progress(date, host) {
  const t = await todayStops(host).catch(() => null); const log = await logFor(date);
  const total = t && t.ok ? t.stops.length : 0;
  const ok = Object.values(log).filter(r => r.status === "ok").length, pb = Object.values(log).filter(r => r.status === "problem").length;
  return { total, ok, pb, next: t && t.ok ? t.stops.find(s => !log[s.key] || log[s.key].status === "prompted") : null };
}
async function onDone(uid, key, host) {
  const date = TG.sofiaDate(), s = ROUTE.find(x => stopKey(x) === key); if (!s) return;
  const u = await TG.userGet(uid);
  if (u && u.pending) await TG.userUpsert({ user_id: uid, pending: null });
  const fresh = u && u.last_at && (Date.now() - Date.parse(u.last_at) < GEO_FRESH_MS) && u.last_lat != null;
  await upsert("cex_route_log", "for_date,stop_key", { for_date: date, stop_key: key, status: "ok", reason: null, lat: fresh ? u.last_lat : null, lng: fresh ? u.last_lng : null, at: new Date().toISOString() });
  if (fresh) { const g = await sb(`cex_stop_geo?stop_key=eq.${encodeURIComponent(key)}&limit=1`).catch(() => []); if (!g || !g.length) await upsert("cex_stop_geo", "stop_key", { stop_key: key, lat: u.last_lat, lng: u.last_lng }); }
  const p = await progress(date, host);
  await TG.tgSend(`✅ <b>${TG.escHtml(s.name)}</b> — заредено (${p.ok + p.pb}/${p.total})`, TG.OWNER_CHAT_ID, date);
  if (p.next) { await TG.tgSend(`👍 Записано. Следваща: <b>${p.next.n}. ${TG.escHtml(p.next.name)}</b>`, String(uid), date,
    { inline_keyboard: [[{ text: "🗺 Навигация до следващата", url: "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + encodeURIComponent(p.next.addr) }], [{ text: "📍 Стигнах там", callback_data: `st:${p.next.key}` }]] }); }
  else if (p.total) { await TG.tgSend("🏁 Това беше последната спирка. Благодаря!", String(uid), date);
    await TG.tgSend(`🏁 <b>Разносът приключи</b>: ${p.ok} заредени` + (p.pb ? `, <b>${p.pb} с проблем</b>` : ""), TG.OWNER_CHAT_ID, date); }
}

// Връща true, ако съобщението е обработено тук.
async function handleText(uid, text, host) {
  if (/маршрут|^\/route|^\/start/i.test(text)) { await sendRoute(String(uid), host); return true; }
  const u = await TG.userGet(uid);
  const pend = pendingKey(u);
  if (pend && text) { // бележка към проблем (остава отворен за снимка)
    const key = pend; const s = ROUTE.find(x => stopKey(x) === key);
    await sb(`cex_route_log?for_date=eq.${TG.sofiaDate()}&stop_key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ note: text.slice(0, 500) }) });
    await TG.tgSend(`📝 <b>${TG.escHtml(s ? s.name : key)}</b> — бележка от шофьора:\n${TG.escHtml(text.slice(0, 500))}`, TG.OWNER_CHAT_ID, TG.sofiaDate());
    await TG.tgSend("👍 Записах бележката.", String(uid)); return true;
  }
  await TG.tgSend("Напиши <b>маршрут</b>, за да видиш спирките за днес.", String(uid)); return true;
}
async function handlePhoto(uid, msg) {
  const u = await TG.userGet(uid);
  const key = pendingKey(u); const s = key && ROUTE.find(x => stopKey(x) === key);
  const ph = (msg.photo || []).slice(-1)[0];
  if (ph) await TG.tgApi("sendPhoto", { chat_id: TG.OWNER_CHAT_ID, photo: ph.file_id, parse_mode: "HTML",
    caption: `📷 ${s ? "<b>" + TG.escHtml(s.name) + "</b> — снимка към проблема" : "Снимка от шофьора"}` + (msg.caption ? "\n" + TG.escHtml(msg.caption) : "") });
  await TG.tgSend("📷 Снимката е пратена на Ясен.", String(uid)); return true;
}
async function handleLocation(uid, loc, host) {
  const lat = Number(loc.latitude), lng = Number(loc.longitude); if (!Number.isFinite(lat)) return true;
  await TG.userUpsert({ user_id: uid, last_lat: lat, last_lng: lng, last_at: new Date().toISOString() });
  const date = TG.sofiaDate();
  const geo = await sb(`cex_stop_geo?select=stop_key,lat,lng`).catch(() => []);
  const near = (geo || []).map(g => ({ key: g.stop_key, d: distM({ lat, lng }, g) })).filter(x => x.d <= NEAR_M).sort((a, b) => a.d - b.d)[0];
  if (!near) return true;
  const log = await logFor(date); if (log[near.key]) return true;           // вече е питан/готов
  const t = await todayStops(host).catch(() => null);
  if (!t || !t.ok || !t.stops.some(s => s.key === near.key)) return true;    // няма стокова днес
  await upsert("cex_route_log", "for_date,stop_key", { for_date: date, stop_key: near.key, status: "prompted", at: new Date().toISOString() });
  await stopMenu(String(uid), near.key, true); return true;
}
async function handleCallback(cq, host) {
  const uid = Number(cq.from && cq.from.id), data = String(cq.data || "");
  let m;
  if ((m = /^st:(.+)$/.exec(data))) { await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id }); await stopMenu(String(uid), m[1], false); return true; }
  if ((m = /^ok:(.+)$/.exec(data))) { await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Записано ✅" }); await onDone(uid, m[1], host); return true; }
  if ((m = /^pb:(.+)$/.exec(data))) {
    await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id });
    await TG.tgSend("⚠️ Какъв е проблемът?", String(uid), TG.sofiaDate(), { inline_keyboard: Object.entries(REASONS).map(([n, t]) => [{ text: t, callback_data: `pr:${n}:${m[1]}` }]) });
    return true;
  }
  if ((m = /^pr:(\d):(.+)$/.exec(data))) {
    const reason = REASONS[m[1]] || "Друго", key = m[2], date = TG.sofiaDate(), s = ROUTE.find(x => stopKey(x) === key);
    await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Записано" });
    await upsert("cex_route_log", "for_date,stop_key", { for_date: date, stop_key: key, status: "problem", reason, at: new Date().toISOString() });
    await TG.userUpsert({ user_id: uid, pending: key + "|" + Date.now() });
    const p = await progress(date, host);
    await TG.tgSend(`⚠️ <b>${TG.escHtml(s ? s.name : key)}</b> — ПРОБЛЕМ: <b>${TG.escHtml(reason)}</b> (${p.ok + p.pb}/${p.total})`, TG.OWNER_CHAT_ID, date);
    await TG.tgSend("📷 Прати <b>снимка</b> или напиши <b>бележка</b> — отиват при Ясен. После продължи с маршрута.", String(uid), date,
      p.next ? { inline_keyboard: [[{ text: `➡️ Следваща: ${p.next.n}. ${p.next.name}`, callback_data: `st:${p.next.key}` }]] } : null);
    if (!p.next && p.total) await TG.tgSend(`🏁 <b>Разносът приключи</b>: ${p.ok} заредени, <b>${p.pb} с проблем</b>`, TG.OWNER_CHAT_ID, date);
    return true;
  }
  return false;
}
module.exports = { handleText, handlePhoto, handleLocation, handleCallback, sendRoute };
