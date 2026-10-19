// ★ S25 — Шофьорът на буса в Telegram (@MOTAMO_BOT, роля „shofior").
// „маршрут" → спирките за днес (само с СТОКОВА за деня, по реда на собственика) + Google Maps
// навигация (жив трафик) + бутон за всяка спирка → ✅ Заредено / ⚠️ Проблем (причина + снимка/бележка)
// → всичко при собственика. Живо местоположение → при <150 м от спирка ботът пита „Стигна ли X?".
// Мястото на спирката се научава при първото „Заредено" (последната позиция на шофьора ≤ 10 мин).
const TG = require("./telegram.js");
const { ROUTE, stopKey, mapsLinks, distM, wazeLink, googleLink, splitRoutes, NOT_BUS } = require("./route.js");

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
  const raw = ROUTE.filter(s => (!s.onlyDow || s.onlyDow.includes(dow)) && s.keys.some(k => have.has(k)))
    .map(s => ({ key: stopKey(s), name: s.name, addr: s.addr, zone: s.zone }));
  // ★ Стокова от предишен ден (до 3 дни): влиза САМО ако собственикът я е сложил в записания план (уеб „Маршрути").
  const carryKeys = new Set((j.carry || []).map(c => c.key));
  const carryStops = {};
  for (const s of ROUTE) if (s.keys.some(k => carryKeys.has(k))) carryStops[stopKey(s)] = { key: stopKey(s), name: s.name, addr: s.addr, zone: s.zone };
  // ★ S31 — записан план от собственика (уеб „Маршрути") има предимство; иначе автоматичното делене.
  // Обект със стокова, който не е в плана, отива в последния маршрут (да не се загуби).
  let fixed = false, stops;
  const plan = await sb(`cex_route_plan?for_date=eq.${date}&select=routes&limit=1`).catch(() => null);
  const routes = plan && plan[0] && Array.isArray(plan[0].routes) ? plan[0].routes.filter(r => r && Array.isArray(r.keys) && r.keys.length) : [];
  if (routes.length) {
    const byKey = {}; for (const k in carryStops) byKey[k] = carryStops[k]; for (const s of raw) byKey[s.key] = s;
    const used = new Set(); const ordered = [];
    routes.forEach((r, i) => { for (const k of r.keys) {
      if (used.has(k) || !(have.has(k) || carryStops[k])) continue;   // обекти със стокова днес (или от последните 3 дни, ако са в плана)
      used.add(k);
      const s = byKey[k] || { key: k, name: (r.labels && r.labels[k]) || ("Обект " + k), addr: null, isNew: true };   // нов обект без адрес
      ordered.push({ ...s, zone: String(r.name || `Маршрут ${i + 1}`) });
    } });
    // обект извън плана на собственика НЕ се добавя — той решава кой пътува
    stops = ordered.map((s, i) => ({ ...s, n: i + 1 })); fixed = true;
  } else {
    // непознати обекти със стокова (нов магазин, който го няма в route.js) → група „Без адрес" накрая
    for (const k of have) if (!NOT_BUS.has(k) && !ROUTE.some(s => s.keys.includes(k))) raw.push({ key: k, name: "Обект " + k, addr: null, zone: "Без адрес", isNew: true });
    // номерацията следва маршрутите (зоните), за да върви 1,2,3… в списъка
    stops = splitRoutes(raw).flatMap(g => g.stops).map((s, i) => ({ ...s, n: i + 1 }));
  }
  return { ok: true, date, dow, stops, fixed };
}
async function logFor(date) {
  const rows = await sb(`cex_route_log?for_date=eq.${date}&select=stop_key,status,reason,at`).catch(() => []);
  const m = {}; for (const r of rows || []) m[r.stop_key] = r; return m;
}
const mark = st => !st ? "⬜" : st.status === "ok" ? "✅" : st.status === "problem" ? "⚠️" : (st.status === "arrived" || st.status === "left") ? "📍" : "⬜";

// ★ S31 — клавиатурата е по МАРШРУТИ (зони): за всеки — Google (целия) + Waze (първата спирка), после спирките.
function routeKeyboard(stops, log, fixed) {
  const kb = [];
  const groups = splitRoutes(stops, fixed);
  groups.forEach((g, gi) => {
    const first = g.stops.find(s => s.addr && isOpen(log[s.key])) || g.stops.find(s => s.addr);
    const tag = groups.length > 1 ? `${gi + 1}. ${g.zone}` : "";
    mapsLinks(g.stops).forEach((l, li) => kb.push([
      { text: `🗺 Google ${tag}${g.stops.length > 10 ? ` (${l.from}–${l.to})` : ""}`.trim(), url: l.url },
      ...(li === 0 && first ? [{ text: `🚗 Waze ${tag}`.trim() + ` → ${first.n}`, url: wazeLink(first) }] : [])
    ]));
    // ★ S31 — заредените/с проблем спирки се скриват от бутоните (името им остава в текста със ✅/⚠️)
    for (const s of g.stops) if (isOpen(log[s.key])) kb.push([{ text: `${mark(log[s.key])} ${s.n}. ${s.name}`, callback_data: `st:${s.key}` }]);
  });
  return { inline_keyboard: kb };
}
async function sendRoute(chatId, host) {
  const t = await todayStops(host);
  if (!t.ok) { await TG.tgSend("⚠️ Не мога да взема маршрута: " + TG.escHtml(t.error), chatId); return; }
  if (!t.stops.length) { await TG.tgSend("Днес няма издадени стокови — няма обекти. Ако сега се издават, напиши пак <b>тръгвам</b> след малко.", chatId); return; }
  const log = await logFor(t.date);
  const done = t.stops.filter(s => !isOpen(log[s.key])).length;
  const groups = splitRoutes(t.stops, t.fixed);
  const list = groups.map((g, gi) => (groups.length > 1 ? `<b>Маршрут ${gi + 1} — ${TG.escHtml(g.zone)} (${g.stops.length})</b>\n` : "")
    + g.stops.map(s => `${mark(log[s.key])} ${s.n}. ${TG.escHtml(s.name)}`).join("\n")).join("\n\n");
  await TG.tgSend(`🚚 <b>За зареждане днес (${DOW_BG[t.dow]}): ${t.stops.length} обекта</b> — по стоковите` + (done ? ` (готови ${done})` : "")
    + (groups.length > 1 ? `, в <b>${groups.length} маршрута</b>` : "") + (t.fixed ? " (подредени от Ясен)" : "")
    + "\n\n" + list
    + "\n\n🗺 Google = целият маршрут (жив трафик). 🚗 Waze = до следващата спирка (Waze не прави маршрут с много спирки). Сподели <b>живо местоположение</b> (📎 → Местоположение → На живо → 8 часа) — ботът сам вижда къде си и записва обектите. Натискаш само при <b>проблем</b>.\nПри обект, който ботът още не познава, натисни го в списъка, като стигнеш.",
    chatId, t.date, routeKeyboard(t.stops, log, t.fixed));
  if (!done) await TG.tgSend(`🚚 Шофьорът тръгна — <b>${t.stops.length} обекта</b> днес.`, TG.OWNER_CHAT_ID, t.date);
}
// Спирка по ключ: от маршрута на буса, иначе от днешния план (нов обект без адрес).
async function stopByKey(key, host) {
  const s = ROUTE.find(x => stopKey(x) === key); if (s) return { key, name: s.name, addr: s.addr };
  const t = await todayStops(host).catch(() => null); const p = t && t.ok && t.stops.find(x => x.key === key);
  return p ? { key, name: p.name, addr: p.addr || null } : { key, name: "Обект " + key, addr: null };
}
async function stopMenu(chatId, key, prompt, host) {
  const s = await stopByKey(key, host);
  const nav = s.addr ? [[{ text: "🚗 Waze дотук", url: wazeLink(s) }, { text: "🗺 Google дотук", url: googleLink(s) }]] : [];
  await TG.tgSend((prompt ? "📍 Стигна ли <b>" : "📍 <b>") + TG.escHtml(s.name) + (prompt ? "</b>?" : "</b>") + (s.addr ? "" : "\n<i>Нов обект — няма адрес за навигация.</i>"), chatId, TG.sofiaDate(),
    { inline_keyboard: [[{ text: "✅ Заредено", callback_data: `ok:${key}` }, { text: "⚠️ Проблем", callback_data: `pb:${key}` }], ...nav] });
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
  const date = TG.sofiaDate(), s = await stopByKey(key, host);
  const u = await TG.userGet(uid);
  if (u && u.pending) await TG.userUpsert({ user_id: uid, pending: null });
  const fresh = u && u.last_at && (Date.now() - Date.parse(u.last_at) < GEO_FRESH_MS) && u.last_lat != null;
  await upsert("cex_route_log", "for_date,stop_key", { for_date: date, stop_key: key, status: "ok", reason: null, lat: fresh ? u.last_lat : null, lng: fresh ? u.last_lng : null, at: new Date().toISOString() });
  if (fresh) { const g = await sb(`cex_stop_geo?stop_key=eq.${encodeURIComponent(key)}&limit=1`).catch(() => []); if (!g || !g.length) await upsert("cex_stop_geo", "stop_key", { stop_key: key, lat: u.last_lat, lng: u.last_lng }); }
  const p = await progress(date, host);
  await TG.tgSend(`✅ <b>${TG.escHtml(s.name)}</b> — заредено${auto ? " (авто)" : ""} (${p.ok + p.pb}/${p.total})`, TG.OWNER_CHAT_ID, date);
  if (p.next) { await TG.tgSend(`${auto ? "✅ " + TG.escHtml(s.name) + " — записах „Заредено“." : "👍 Записано."} Следваща: <b>${p.next.n}. ${TG.escHtml(p.next.name)}</b>`, String(uid), date,
    { inline_keyboard: [...(p.next.addr ? [[{ text: "🚗 Waze до следващата", url: wazeLink(p.next) }, { text: "🗺 Google", url: googleLink(p.next) }]] : []), [{ text: "📍 Стигнах там", callback_data: `st:${p.next.key}` }]] }); }
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
    const key = pend; const s = await stopByKey(key, host);
    await sb(`cex_route_log?for_date=eq.${TG.sofiaDate()}&stop_key=eq.${encodeURIComponent(key)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ note: text.slice(0, 500) }) });
    await TG.tgSend(`📝 <b>${TG.escHtml(s ? s.name : key)}</b> — бележка от шофьора:\n${TG.escHtml(text.slice(0, 500))}`, TG.OWNER_CHAT_ID, TG.sofiaDate());
    await TG.tgSend("👍 Записах бележката.", String(uid)); return true;
  }
  await TG.tgSend("Натисни <b>🚚 Тръгвам</b> (или напиши думата тръгвам), за да видиш обектите за днес.", String(uid), null, { keyboard: [[{ text: "🚚 Тръгвам" }]], resize_keyboard: true, is_persistent: true }); return true;
}
async function handlePhoto(uid, msg) {
  const u = await TG.userGet(uid);
  const key = pendingKey(u); const s = key && await stopByKey(key);
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
  const s = await stopByKey(key, host);
  const first = !Object.entries(log).some(([k, st]) => k !== key && ["arrived", "left", "ok", "problem"].includes(st.status));
  await setSt(date, key, "arrived");
  await TG.tgSend(`📍 Шофьорът е в <b>${TG.escHtml(s.name)}</b>`, TG.OWNER_CHAT_ID, date);
  // ★ S31 — и на шофьора: „Стигна ли в X?" с бутоните веднага (иначе не вижда нищо до тръгването)
  await stopMenu(String(uid), key, true, host).catch(() => {});
  if (!first) return;
  // първият обект за деня → маршрутът за ОСТАНАЛИТЕ (по стоковите), от мястото, където е
  const t = await todayStops(host).catch(() => null); if (!t || !t.ok) return;
  const rest = t.stops.filter(x => x.key !== key && isOpen(log[x.key])); if (!rest.length) return;
  await TG.tgSend(`📍 Започваш от <b>${TG.escHtml(s.name)}</b>. Остават <b>${rest.length}</b>:\n` + rest.map(x => `• ${TG.escHtml(x.name)}`).join("\n"), String(uid), date,
    { inline_keyboard: [...(rest.find(x => x.addr) ? [[{ text: `🚗 Waze → ${rest.find(x => x.addr).n}. ${rest.find(x => x.addr).name}`.slice(0, 60), url: wazeLink(rest.find(x => x.addr)) }]] : []),
      ...mapsLinks(rest).map(l => [{ text: rest.length > 10 ? `🗺 Google (${l.from}–${l.to})` : "🗺 Google за останалите", url: l.url }])] });
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
    const s = await stopByKey(key, host);
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
  if ((m = /^st:(.+)$/.exec(data))) { await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id }); await stopMenu(String(uid), m[1], false, host); return true; }
  if ((m = /^ok:(.+)$/.exec(data))) { await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Записано ✅" }); await onDone(uid, m[1], host); return true; }
  if ((m = /^pb:(.+)$/.exec(data))) {
    await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id });
    await TG.tgSend("⚠️ Какъв е проблемът?", String(uid), TG.sofiaDate(), { inline_keyboard: Object.entries(REASONS).map(([n, t]) => [{ text: t, callback_data: `pr:${n}:${m[1]}` }]) });
    return true;
  }
  if ((m = /^pr:(\d):(.+)$/.exec(data))) {
    const reason = REASONS[m[1]] || "Друго", key = m[2], date = TG.sofiaDate(), s = await stopByKey(key, host);
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
