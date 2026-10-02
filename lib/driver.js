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

const REASONS = { 1: "Липса на етикет", 2: "Грешна стокова", 3: "Грешно количество" };
const NEAR_M = 150, GEO_FRESH_MS = 10 * 60 * 1000;
// ★ S28 — АВТОМАТИЧНО ПО МЕСТОПОЛОЖЕНИЕ (шофьорът споделя „на живо" веднъж): near (в обсега) → arrived (престоял ≥ 90 с)
// → left (отдалечил се > 250 м: едно съобщение Заредено/Проблем) → ok САМО, ако не натисне нищо 5 мин. Минал транзит = passed.
const LEAVE_M = 250, DWELL_MS = 90 * 1000, AUTO_OK_MS = 5 * 60 * 1000;
const OPEN = new Set(["prompted", "near", "passed", "arrived", "left"]);
const isOpen = st => !st || OPEN.has(st.status);
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
  const rows = await sb(`cex_route_log?for_date=eq.${date}&select=stop_key,status,reason,at`).catch(() => []);
  const m = {}; for (const r of rows || []) m[r.stop_key] = r; return m;
}
const mark = st => !st ? "⬜" : st.status === "ok" ? "✅" : st.status === "problem" ? "⚠️" : (st.status === "arrived" || st.status === "left") ? "📍" : "⬜";

function routeKeyboard(stops, log) {
  const kb = mapsLinks(stops).map(l => [{ text: stops.length > 10 ? `🗺 Маршрут в Google Maps (${l.from}–${l.to})` : "🗺 Маршрут в Google Maps", url: l.url }]);
  for (const s of stops) kb.push([{ text: `${mark(log[s.key])} ${s.n}. ${s.name}`, callback_data: `st:${s.key}` }]);
  return { inline_keyboard: kb };
}
async function sendRoute(chatId, host) {
  const t = await todayStops(host);
  if (!t.ok) { await TG.tgSend("⚠️ Не мога да взема маршрута: " + TG.escHtml(t.error), chatId); return; }
  if (!t.stops.length) { await TG.tgSend("Днес няма издадени стокови — няма обекти. Ако сега се издават, напиши пак <b>тръгвам</b> след малко.", chatId); return; }
  const log = await logFor(t.date);
  const done = t.stops.filter(s => !isOpen(log[s.key])).length;
  const list = t.stops.map(s => `${s.n}. ${TG.escHtml(s.name)}`).join("\n");
  await TG.tgSend(`🚚 <b>За зареждане днес (${DOW_BG[t.dow]}): ${t.stops.length} обекта</b> — по стоковите` + (done ? ` (готови ${done})` : "")
    + "\n\n" + list
    + "\n\n🗺 Маршрутът е долу в Google Maps (жив трафик). Сподели <b>живо местоположение</b> (📎 → Местоположение → На живо → 8 часа) — ботът сам вижда къде си и записва обектите. Натискаш само при <b>проблем</b>.\nПри обект, който ботът още не познава, натисни го в списъка, като стигнеш.",
    chatId, t.date, routeKeyboard(t.stops, log));
  if (!done) await TG.tgSend(`🚚 Шофьорът тръгна — <b>${t.stops.length} обекта</b> днес.`, TG.OWNER_CHAT_ID, t.date);
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
  return { total, ok, pb, next: t && t.ok ? t.stops.find(s => isOpen(log[s.key])) : null };
}
// Обобщен репорт за собственика в края на разноса: всички обекти със статус + проблеми.
async function finalReport(date, host) {
  const t = await todayStops(host).catch(() => null); const log = await logFor(date);
  const stops = (t && t.ok) ? t.stops : [];
  const ok = stops.filter(s => log[s.key] && log[s.key].status === "ok").length;
  const pb = stops.filter(s => log[s.key] && log[s.key].status === "problem").length;
  const lines = stops.map(s => { const st = log[s.key]; const mk = st && st.status === "ok" ? "✅" : st && st.status === "problem" ? "⚠️" : "⬜";
    return `${mk} ${s.n}. ${TG.escHtml(s.name)}` + (st && st.status === "problem" && st.reason ? ` — <i>${TG.escHtml(st.reason)}</i>` : ""); }).join("\n");
  return `🏁 <b>Разносът приключи</b> — заредени ${ok}/${stops.length}` + (pb ? `, <b>${pb} с проблем</b>` : "") + (lines ? "\n\n" + lines : "");
}
async function onDone(uid, key, host, auto) {
  const date = TG.sofiaDate(), s = ROUTE.find(x => stopKey(x) === key); if (!s) return;
  const u = await TG.userGet(uid);
  if (u && u.pending) await TG.userUpsert({ user_id: uid, pending: null });
  const fresh = u && u.last_at && (Date.now() - Date.parse(u.last_at) < GEO_FRESH_MS) && u.last_lat != null;
  await upsert("cex_route_log", "for_date,stop_key", { for_date: date, stop_key: key, status: "ok", reason: null, lat: fresh ? u.last_lat : null, lng: fresh ? u.last_lng : null, at: new Date().toISOString() });
  if (fresh) { const g = await sb(`cex_stop_geo?stop_key=eq.${encodeURIComponent(key)}&limit=1`).catch(() => []); if (!g || !g.length) await upsert("cex_stop_geo", "stop_key", { stop_key: key, lat: u.last_lat, lng: u.last_lng }); }
  const p = await progress(date, host);
  await TG.tgSend(`✅ <b>${TG.escHtml(s.name)}</b> — заредено${auto ? " (авто)" : ""} (${p.ok + p.pb}/${p.total})`, TG.OWNER_CHAT_ID, date);
  if (p.next) { await TG.tgSend(`${auto ? "✅ " + TG.escHtml(s.name) + " — записах „Заредено“." : "👍 Записано."} Следваща: <b>${p.next.n}. ${TG.escHtml(p.next.name)}</b>`, String(uid), date,
    { inline_keyboard: [[{ text: "🗺 Навигация до следващата", url: "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + encodeURIComponent(p.next.addr) }], [{ text: "📍 Стигнах там", callback_data: `st:${p.next.key}` }]] }); }
  else if (p.total) { await TG.tgSend("🏁 Това беше последният обект. Благодаря!", String(uid), date);
    await TG.tgSend(await finalReport(date, host), TG.OWNER_CHAT_ID, date); }
}

// Връща true, ако съобщението е обработено тук.
async function handleText(uid, text, host) {
  await sweep(uid, host).catch(() => {});
  if (/тръгвам|маршрут|^\/route|^\/start/i.test(text)) { await sendRoute(String(uid), host); return true; }
  const u = await TG.userGet(uid);
  const pend = pendingKey(u);
  if (pend && text) { // бележка към проблем (остава отворен за снимка)
    const key = pend; const s = ROUTE.find(x => stopKey(x) === key);
    await sb(`cex_route_log?for_date=eq.${TG.sofiaDate()}&stop_key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ note: text.slice(0, 500) }) });
    await TG.tgSend(`📝 <b>${TG.escHtml(s ? s.name : key)}</b> — бележка от шофьора:\n${TG.escHtml(text.slice(0, 500))}`, TG.OWNER_CHAT_ID, TG.sofiaDate());
    await TG.tgSend("👍 Записах бележката.", String(uid)); return true;
  }
  await TG.tgSend("Натисни <b>🚚 Тръгвам</b> (или напиши думата тръгвам), за да видиш обектите за днес.", String(uid), null, { keyboard: [[{ text: "🚚 Тръгвам" }]], resize_keyboard: true, is_persistent: true }); return true;
}
async function handlePhoto(uid, msg) {
  const u = await TG.userGet(uid);
  const key = pendingKey(u); const s = key && ROUTE.find(x => stopKey(x) === key);
  const ph = (msg.photo || []).slice(-1)[0];
  if (ph) await TG.tgApi("sendPhoto", { chat_id: TG.OWNER_CHAT_ID, photo: ph.file_id, parse_mode: "HTML",
    caption: `📷 ${s ? "<b>" + TG.escHtml(s.name) + "</b> — снимка към проблема" : "Снимка от шофьора"}` + (msg.caption ? "\n" + TG.escHtml(msg.caption) : "") });
  await TG.tgSend("📷 Снимката е пратена на Ясен.", String(uid)); return true;
}
const setSt = (date, key, status) => upsert("cex_route_log", "for_date,stop_key", { for_date: date, stop_key: key, status, at: new Date().toISOString() });
// Изтеклите „left" (5 мин без натискане) → Заредено. Вика се при всяко движение и при всяко съобщение/бутон.
async function sweep(uid, host, log) {
  const date = TG.sofiaDate(); log = log || await logFor(date);
  for (const [key, st] of Object.entries(log)) if (st.status === "left" && Date.now() - Date.parse(st.at) >= AUTO_OK_MS) await onDone(uid, key, host, true);
}
async function arrive(uid, key, date, log, host) {
  const s = ROUTE.find(x => stopKey(x) === key); if (!s) return;
  const first = !Object.entries(log).some(([k, st]) => k !== key && ["arrived", "left", "ok", "problem"].includes(st.status));
  await setSt(date, key, "arrived");
  await TG.tgSend(`📍 Шофьорът е в <b>${TG.escHtml(s.name)}</b>`, TG.OWNER_CHAT_ID, date);
  if (!first) return;
  // първият обект за деня → маршрутът за ОСТАНАЛИТЕ (по стоковите), от мястото, където е
  const t = await todayStops(host).catch(() => null); if (!t || !t.ok) return;
  const rest = t.stops.filter(x => x.key !== key && isOpen(log[x.key])); if (!rest.length) return;
  await TG.tgSend(`📍 Започваш от <b>${TG.escHtml(s.name)}</b>. Остават <b>${rest.length}</b>:\n` + rest.map(x => `• ${TG.escHtml(x.name)}`).join("\n"), String(uid), date,
    { inline_keyboard: mapsLinks(rest).map(l => [{ text: rest.length > 10 ? `🗺 Маршрут (${l.from}–${l.to})` : "🗺 Маршрут за останалите", url: l.url }]) });
}
async function handleLocation(uid, loc, host) {
  const lat = Number(loc.latitude), lng = Number(loc.longitude); if (!Number.isFinite(lat)) return true;
  await TG.userUpsert({ user_id: uid, last_lat: lat, last_lng: lng, last_at: new Date().toISOString() });
  const date = TG.sofiaDate(), now = Date.now(), pos = { lat, lng };
  const learned = await sb(`cex_stop_geo?select=stop_key,lat,lng`).catch(() => []);
  const G = {}; for (const g of learned || []) G[g.stop_key] = g;
  for (const s of ROUTE) if (s.geo) G[stopKey(s)] = { stop_key: stopKey(s), lat: s.geo[0], lng: s.geo[1] }; // точките от собственика имат предимство
  const geo = Object.values(G);
  const log = await logFor(date);
  // 1) напускане на обект, в който е бил
  for (const [key, st] of Object.entries(log)) {
    if (!["near", "arrived", "prompted"].includes(st.status) || !G[key]) continue;
    const dwell = now - Date.parse(st.at);
    if (distM(pos, G[key]) <= LEAVE_M) { if (st.status === "near" && dwell >= DWELL_MS) await arrive(uid, key, date, log, host); continue; }
    if (st.status === "near" && dwell < DWELL_MS) { await setSt(date, key, "passed"); continue; }   // минал е транзит
    if (st.status === "near") await arrive(uid, key, date, log, host);
    await setSt(date, key, "left");
    const s = ROUTE.find(x => stopKey(x) === key);
    await TG.tgSend(`<b>${TG.escHtml(s ? s.name : key)}</b> — как мина?\n<i>Ако не натиснеш нищо, след 5 мин записвам „Заредено“.</i>`, String(uid), date,
      { inline_keyboard: [[{ text: "✅ Заредено", callback_data: `ok:${key}` }, { text: "⚠️ Проблем", callback_data: `pb:${key}` }]] });
  }
  // 2) изтекли 5 мин без натискане → Заредено
  await sweep(uid, host, log);
  // 3) влизане в обсега на обект със стокова днес
  const near = (geo || []).filter(g => distM(pos, g) <= NEAR_M && (!log[g.stop_key] || log[g.stop_key].status === "passed"));
  if (!near.length) return true;
  const t = await todayStops(host).catch(() => null); if (!t || !t.ok) return true;
  for (const g of near) if (t.stops.some(s => s.key === g.stop_key)) await setSt(date, g.stop_key, "near");
  return true;
}
async function handleCallback(cq, host) {
  const uid = Number(cq.from && cq.from.id), data = String(cq.data || "");
  if (!/^ok:/.test(data)) await sweep(uid, host).catch(() => {});
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
    if (!p.next && p.total) await TG.tgSend(await finalReport(date, host), TG.OWNER_CHAT_ID, date);
    return true;
  }
  return false;
}
module.exports = { handleText, handlePhoto, handleLocation, handleCallback, sendRoute };
