// tools/tc_dry.js — суха проба на lib/timeclock.js: памет вместо Supabase, без пращане в Telegram.
// Пуска се: node tools/tc_dry.js
process.env.TC_MOCK = "1"; process.env.TELEGRAM_BOT_TOKEN = "dry"; process.env.PEEK_TOKEN = "dry";
const TG = require("../lib/telegram.js");
const sent = []; const calls = [];
TG.tgSend = async (text, chat, keep, markup) => { sent.push({ chat, text, markup }); return { ok: true }; };
TG.tgApi = async (m, b) => { calls.push({ m, b }); return { ok: true }; };
const SENT = {}; TG.sentGet = async (k, d) => SENT[k + "|" + d] || null; TG.sentSave = async (k, d, p) => { SENT[k + "|" + d] = p; };
global.fetch = async (url) => ({ ok: true, json: async () => [{ user_id: 111, name: "Мария Тест", role: "sklad" }, { user_id: 222, name: "Иван Тест", role: "tochka" }] });
const TC = require("../lib/timeclock.js");
TC.CFG.autoBreakMin = 0;                      // старите проби са без автоматична почивка; новата част я включва
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("✗", m); } else console.log("✓", m); };
const OWNER = 1153763325; const T = (iso) => new Date(iso);
(async () => {
  // екип: собственикът записва Мария в цеха и Иван в точката
  await TC.handleCallback({ id: "1", data: "ts:111:cex", from: { id: OWNER }, message: { chat: { id: OWNER }, message_id: 5 } }, true, "h");
  await TC.handleCallback({ id: "2", data: "ts:222:shop", from: { id: OWNER }, message: { chat: { id: OWNER }, message_id: 5 } }, true, "h");
  ok(TC.MOCK.staff.length === 2, "двама в екипа");
  await TC.handleCallback({ id: "3", data: "ts:111:cex", from: { id: 999 } }, false, "h");
  ok(TC.MOCK.staff.length === 2, "не-собственик не може да добавя");
  // 19.10.2026 07:00 (EEST, UTC+3) → 04:00Z
  const now = T("2026-10-19T04:00:00Z");
  await TC.handleMessage(111, "▶️ Започнах", { role: "sklad" }, false, "h", now);
  ok(/Започна в <b>07:00/.test(sent.at(-1).text), "започва 07:00");
  await TC.handleMessage(111, "започнах", { role: "sklad" }, false, "h", T("2026-10-19T04:01:00Z"));
  ok(/Вече си започнал/.test(sent.at(-1).text), "двойно започване се отказва");
  await TC.handleMessage(111, "⏹ Приключих", { role: "sklad" }, false, "h", T("2026-10-19T12:35:00Z"));
  ok(/Смяната: <b>8ч 35м/.test(sent.at(-1).text), "смяна 8ч 35м → " + sent.at(-1).text.replace(/\n/g, " "));
  await TC.handleMessage(111, "приключих", { role: "sklad" }, false, "h", T("2026-10-19T12:36:00Z"));
  ok(/Не си започвал/.test(sent.at(-1).text), "край без начало се отказва");
  // пропуснат час: Иван пише „започнах 8:30" в 09:00 местно
  await TC.handleMessage(222, "започнах 8:30", { role: "tochka" }, false, "h", T("2026-10-19T06:00:00Z"));
  ok(/08:30/.test(sent.at(-1).text) && /ръчно/.test(sent.at(-1).text), "ръчен час 08:30");
  await TC.handleMessage(222, "приключих 23:00", { role: "tochka" }, false, "h", T("2026-10-19T06:10:00Z"));
  ok(/бъдещето|Краят трябва/.test(sent.at(-1).text), "час в бъдещето се отказва");
  // отмяна
  const lastRow = TC.MOCK.log.filter(x => x.user_id === 222).at(-1);
  await TC.handleCallback({ id: "4", data: "tc:undo:" + lastRow.id, from: { id: 222 }, message: { chat: { id: 222 }, message_id: 7 } }, false, "h", T("2026-10-19T06:05:00Z"));
  ok(TC.MOCK.log.find(x => x.id === lastRow.id).voided_at, "отмяна маркира реда");
  // не-екип
  const n0 = sent.length;
  ok(!(await TC.handleMessage(333, "край", {}, false, "h", now)), "край от не-екип се игнорира");
  ok(sent.length === n0, "и не праща нищо");
  ok(await TC.handleMessage(333, "⏹ Приключих", {}, false, "h", now) && /Още не си записан/.test(sent.at(-1).text), "бутон от не-екип → обяснение");
  // сесии и край на нощна смяна
  await TC.rpc("tc_add", { p_user: 222, p_kind: "in", p_at: T("2026-10-20T19:00:00Z"), p_source: "t" });
  await TC.rpc("tc_add", { p_user: 222, p_kind: "out", p_at: T("2026-10-21T01:30:00Z"), p_source: "t" });
  const rows = await TC.rpc("tc_rows", { p_from: "2026-10-01", p_to: "2026-10-31" });
  const s = TC.sessions(rows, T("2026-10-22T10:00:00Z")); const tt = TC.totals(s);
  const ivan = tt.find(x => x.user_id === 222), mar = tt.find(x => x.user_id === 111);
  ok(Math.round(ivan.min) === 390, "нощна смяна през полунощ = 6ч 30м (" + Math.round(ivan.min) + ")");
  ok(Math.round(mar.min) === 515, "Мария 8ч 35м = 515 мин");
  // забравен край + отчет
  await TC.rpc("tc_add", { p_user: 111, p_kind: "in", p_at: T("2026-10-20T04:00:00Z"), p_source: "t" });
  const rep = await TC.cronReport(T("2026-10-21T06:00:00Z"));
  ok(rep.ok && rep.forgot === 1, "отчетът вижда забравен край");
  ok(/Забравен край/.test(sent.at(-1).text) && /\/час Мария Тест/.test(sent.at(-1).text) === false && /\/час Име приключи/.test(sent.at(-1).text), "отчетът дава поправка");
  // поправка от собственика
  await TC.handleMessage(OWNER, "/час мария приключи 16:00 20.10", {}, true, "h", T("2026-10-21T06:00:00Z"));
  ok(/Нанесено/.test(sent.at(-1).text), "поправка от собственика");
  const rows2 = await TC.rpc("tc_rows", { p_from: "2026-10-01", p_to: "2026-10-31" });
  const m2 = TC.totals(TC.sessions(rows2, T("2026-10-22T10:00:00Z"))).find(x => x.user_id === 111);
  ok(Math.round(m2.min) === 515 + 540 && m2.flags.length === 0, "след поправката няма флаг (" + Math.round(m2.min) + ")");
  // команди на собственика и страница
  await TC.handleMessage(OWNER, "часове", {}, true, "h", T("2026-10-22T10:00:00Z"));
  ok(/Мария Тест/.test(sent.at(-1).text) && /Иван Тест/.test(sent.at(-1).text), "часове показва и двамата");
  await TC.handleMessage(OWNER, "кой е на работа", {}, true, "h", T("2026-10-22T10:00:00Z"));
  console.log("   " + sent.at(-1).text.replace(/\n/g, " | "));
  const html = await TC.hoursPage("k", "2026-10", T("2026-10-22T10:00:00Z")); ok(/Цех/.test(html) && /Точка/.test(html) && /Мария Тест/.test(html), "уеб таблицата се прави");
  const csv = await TC.hoursCsv("2026-10", T("2026-10-22T10:00:00Z")); ok(csv.split("\n").length >= 4, "CSV има редове");
  ok(TC.parseKind("▶️ Започнах") === "in" && TC.parseKind("⏹ Приключих") === "out" && TC.parseKind("заявка") === null, "разбор на бутоните");
  // ── приложение + почивка (нов запис -5 в точката) ──
  await TC.rpc("tc_staff_set", { p_user: -5, p_name: "Роксана Тест", p_site: "shop", p_active: true });
  const GEO = { lat: TC.SITES.shop.lat + 0.0003, lon: TC.SITES.shop.lon, acc: 20 };   // ~33 м от точката
  const D = (hhmm) => T("2026-11-12T" + hhmm + ":00Z");              // 12.11.2026 — зимно време, София = UTC+2
  ok(TC.clockOk("-5", TC.clockToken(-5)) && !TC.clockOk("-5", "x".repeat(24)) && !TC.clockOk("-6", TC.clockToken(-5)), "лична връзка: вярна минава, чужда не");
  let r = await TC.appAct(-5, "break_start", D("08:00"), GEO); ok(!r.ok && r.error === "state", "почивка преди начало се отказва");
  r = await TC.appAct(-5, "in", D("06:00"), GEO); ok(r.ok, "започва 08:00 местно");
  r = await TC.appAct(-5, "in", D("06:01"), GEO); ok(!r.ok && r.error === "state", "двойно натискане се отказва");
  r = await TC.appAct(-5, "break_start", D("10:00"), GEO); ok(r.ok, "почивка 12:00");
  let st = await TC.appState(-5, D("10:10")); ok(st.state === "brk" && st.brkMin === 10, "състояние: на почивка, 10 мин");
  r = await TC.appAct(-5, "break_end", D("10:30"), GEO); ok(r.ok, "връща се 12:30");
  r = await TC.appAct(-5, "out", D("14:30"), GEO); ok(r.ok && r.min === 480, "приключва 16:30 → 8ч30м − 30 мин почивка = 8ч (" + r.min + ")");
  st = await TC.appState(-5, D("14:31")); ok(st.state === "off" && st.month.min === 480 && st.month.brk === 30, "месец: 480 мин, почивки 30");
  r = await TC.appAct(-5, "in", D("15:00"), GEO); await TC.appAct(-5, "break_start", D("15:30"), GEO);
  r = await TC.appAct(-5, "out", D("16:00"), GEO); ok(r.ok, "приключва направо от почивка");
  const rr = await TC.rpc("tc_rows", { p_from: "2026-11-12", p_to: "2026-11-12" });
  ok(rr.filter(x => x.kind === "break_end").length === 2, "почивката е затворена автоматично");
  const u = await TC.appUndo(-5, rr.at(-1).id, new Date(Date.now() + 60000)); ok(u.ok, "отмяна на последния запис");
  ok(/Роксана Тест/.test(await TC.clockTeamPage("https://h/api/transfer")) && /view=clock/.test(TC.clockPage(-5, "t")), "страниците се правят");
  // ── геозона ──
  let g = await TC.appAct(-5, "in", D("17:00"), { lat: TC.SITES.shop.lat + 0.01, lon: TC.SITES.shop.lon, acc: 10 });
  ok(!g.ok && g.error === "far" && g.dist > 1000, "далеч от точката (" + g.dist + " м) → отказ");
  g = await TC.appAct(-5, "in", D("17:00"), { lat: TC.SITES.cex.lat, lon: TC.SITES.cex.lon, acc: 10 });
  ok(!g.ok && g.error === "far", "човек от точката в цеха → отказ");
  g = await TC.appAct(-5, "in", D("17:00"), { lat: TC.SITES.shop.lat, lon: TC.SITES.shop.lon, acc: 900 });
  ok(!g.ok && g.error === "weak", "слаб GPS сигнал → отказ");
  g = await TC.appAct(-5, "in", D("17:00"));
  ok(!g.ok && g.error === "geo", "без локация → отказ");
  g = await TC.appAct(-5, "in", D("17:00"), { lat: "x", lon: 1 });
  ok(!g.ok && g.error === "geo", "лоши координати → отказ");
  const geoRows = (await TC.rpc("tc_rows", { p_from: "2026-11-12", p_to: "2026-11-12" })).filter(x => x.source === "app");
  ok(geoRows.length && geoRows.every(x => x.lat != null && x.dist_m != null && x.dist_m < 100), "записите пазят локацията и разстоянието");
  // ── пуш напомняния ──
  const REM = require("../lib/clockremind.js"), pushes = [];
  REM.setSender(async (sub, payload) => { pushes.push({ sub, payload }); });
  await TC.rpc("tc_staff_set", { p_user: -6, p_name: "Втори Тест", p_site: "shop", p_active: true });
  ok((await REM.appPush(-6, { endpoint: "http://x", keys: { p256dh: "a", auth: "b" } })).ok === false, "абонамент без https се отказва");
  ok((await REM.appPush(-6, { endpoint: "https://push.example/abc", keys: { p256dh: "a", auth: "b" } })).ok, "абонаментът се записва");
  await REM.appPush(-5, { endpoint: "https://push.example/five", keys: { p256dh: "a", auth: "b" } });
  ok((await TC.rpc("tc_push_list")).length === 2, "два абонамента в базата");
  ok((await REM.cronRemind(T("2026-11-12T07:00:00Z"))).start === 0, "без график — не праща напомняния за начало");
  TC.MOCK.sched.push({ user_id: -5, days: [4], start_t: "09:00", end_t: "17:00" });    // 12.11.2026 е четвъртък (ISO 4)
  TC.MOCK.sched.push({ user_id: -6, days: [4], start_t: "09:00", end_t: "17:00" });
  let rm = await REM.cronRemind(T("2026-11-12T07:05:00Z"));            // 09:05 местно — още рано
  ok(rm.start === 0, "преди начало+10 мин — тихо");
  rm = await REM.cronRemind(T("2026-11-12T07:15:00Z"));                // 09:15
  ok(rm.start === 1 && rm.sent === 1 && /Започнах/.test(pushes.at(-1).payload.body) && /view=clock&u=-6&t=/.test(pushes.at(-1).payload.url), "09:15 — пуш на човека с абонамент: " + JSON.stringify(rm));
  rm = await REM.cronRemind(T("2026-11-12T07:25:00Z"));
  ok(rm.start === 0 && rm.sent === 0, "повторно на 09:25 — не праща втори път");
  rm = await REM.cronRemind(T("2026-11-12T07:35:00Z"));                // 09:35 — вече +35 мин
  ok(rm.owner === 1 && sent.some(x => /Още не са отбелязали начало/.test(x.text) && /Втори Тест/.test(x.text)), "собственикът получава списък на неотбелязалите: " + JSON.stringify(rm));
  // отбелязва се → вечерно напомняне за край
  await TC.appAct(-5, "in", T("2026-11-12T07:30:00Z"), GEO);
  rm = await REM.cronRemind(T("2026-11-12T15:20:00Z"));                // 17:20 местно, още на работа
  ok(rm.end === 1 && /Приключих/.test(pushes.at(-1).payload.body), "17:20 — напомняне за край: " + JSON.stringify(rm));
  rm = await REM.cronRemind(T("2026-11-12T15:30:00Z"));
  ok(rm.end === 0, "краят се напомня само веднъж");
  // таблото и Форма 76
  const CD = require("../lib/clockdash.js");
  const dh = await CD.dashPage("k", T("2026-11-12T15:30:00Z"));
  ok(/Втори Тест/.test(dh) && /leaflet/.test(dh) && /закъсняват/.test(dh), "таблото се прави");
  const dd = await CD.dashData(T("2026-11-12T08:00:00Z"));
  ok(dd.people.find(p => p.id === -6).late === true && dd.points.length >= 1, "закъснелият се вижда; точките за картата са налични");
  const f76 = await CD.form76Page("2026-11", "shop", T("2026-11-12T15:30:00Z"));
  ok(/Форма 76/.test(f76) && /Роксана Тест/.test(f76), "Форма 76 се прави");
  ok(CD.nightMin("2026-11-12T19:00:00Z", "2026-11-13T05:00:00Z") === 480, "нощни: 21:00–07:00 местно → 22–06 = 8 ч");
  // ── автоматична почивка ──
  TC.CFG.autoBreakMin = 30;
  await TC.rpc("tc_staff_set", { p_user: -7, p_name: "Трети Тест", p_site: "shop", p_active: true });
  const add7 = (k, iso) => TC.rpc("tc_add", { p_user: -7, p_kind: k, p_at: T(iso), p_source: "t" });
  await add7("in", "2026-11-13T06:00:00Z"); await add7("out", "2026-11-13T14:00:00Z");                                   // 8 ч без почивка
  await add7("in", "2026-11-14T06:00:00Z"); await add7("break_start", "2026-11-14T09:00:00Z"); await add7("break_end", "2026-11-14T09:20:00Z"); await add7("out", "2026-11-14T14:00:00Z");   // 8 ч със 20 мин почивка
  await add7("in", "2026-11-15T06:00:00Z"); await add7("out", "2026-11-15T10:00:00Z");                                   // 4 ч
  const s7 = TC.sessions((await TC.rpc("tc_rows", { p_from: "2026-11-13", p_to: "2026-11-15" })).filter(x => x.user_id === -7), T("2026-11-16T10:00:00Z"));
  ok(Math.round(s7[0].min) === 450 && s7[0].auto && s7[0].brk === 30, "8 ч без почивка → 7ч 30м (авт. 30 мин): " + Math.round(s7[0].min));
  ok(Math.round(s7[1].min) === 460 && !s7[1].auto, "със 20 мин почивка → не се добавя втора: " + Math.round(s7[1].min));
  ok(Math.round(s7[2].min) === 240 && !s7[2].auto, "4 ч смяна — без автоматична почивка");
  // ── напомняния за почивка по прозорци ──
  TC.MOCK.sched.push({ user_id: -7, days: [1, 2, 3, 4, 5, 6, 7], start_t: "07:00", end_t: "19:00" });
  await REM.appPush(-7, { endpoint: "https://push.example/seven", keys: { p256dh: "a", auth: "b" } });
  await add7("in", "2026-11-16T05:00:00Z");                                  // 07:00 местно, понеделник
  let rb = await REM.cronRemind(T("2026-11-16T09:10:00Z"));                  // 11:10 — точката още не е в прозореца
  ok(rb.brk === 0, "точка: преди 14:00 — няма напомняне за почивка");
  rb = await REM.cronRemind(T("2026-11-16T12:05:00Z"));                      // 14:05
  ok(rb.brk === 1 && /Почивка/.test(pushes.at(-1).payload.body) && !/автоматично|приспад/.test(pushes.at(-1).payload.body) && /14:00–16:30/.test(pushes.at(-1).payload.body), "точка: 14:05 — пуш за почивка");
  rb = await REM.cronRemind(T("2026-11-16T12:20:00Z"));
  ok(rb.brk === 0, "напомнянето в 14:00 е само веднъж");
  rb = await REM.cronRemind(T("2026-11-16T14:05:00Z"));                      // 16:05 — последно
  ok(rb.brk === 1 && /Последен шанс/.test(pushes.at(-1).payload.body), "точка: 16:05 — последно напомняне");
  rb = await REM.cronRemind(T("2026-11-16T14:40:00Z"));                      // 16:40
  ok(rb.brk === 0, "след 16:30 — вече не напомня");
  await TC.rpc("tc_staff_set", { p_user: -8, p_name: "Цехов Тест", p_site: "cex", p_active: true });
  await REM.appPush(-8, { endpoint: "https://push.example/eight", keys: { p256dh: "a", auth: "b" } });
  await TC.rpc("tc_add", { p_user: -8, p_kind: "in", p_at: T("2026-11-17T05:00:00Z"), p_source: "t" });   // 07:00 местно
  rb = await REM.cronRemind(T("2026-11-17T07:50:00Z")); ok(rb.brk === 0, "цех: 09:50 — още не");
  rb = await REM.cronRemind(T("2026-11-17T08:05:00Z")); ok(rb.brk === 1 && /10:00–11:30 и 12:00–14:00/.test(pushes.at(-1).payload.body), "цех: 10:05 — първи прозорец");
  rb = await REM.cronRemind(T("2026-11-17T08:30:00Z")); ok(rb.brk === 0, "цех: в същия прозорец — само веднъж");
  rb = await REM.cronRemind(T("2026-11-17T10:05:00Z")); ok(rb.brk === 1, "цех: 12:05 — втори прозорец");
  rb = await REM.cronRemind(T("2026-11-17T11:35:00Z")); ok(rb.brk === 1 && /Последен шанс/.test(pushes.at(-1).payload.body), "цех: 13:35 — последно напомняне");
  rb = await REM.cronRemind(T("2026-11-17T12:10:00Z")); ok(rb.brk === 0, "цех: след 14:00 — тихо");
  // ── автоматичен запис (Митьо: Пн, Вт, Пт по 8 ч) ──
  await TC.rpc("tc_staff_set", { p_user: -9, p_name: "Митьо Тест", p_site: "cex", p_active: true });
  let ra = await REM.cronRemind(T("2026-11-16T14:20:00Z"));                  // понеделник 16:20 местно — още рано
  ok(!ra.auto, "авто: преди 16:35 — не записва");
  ra = await REM.cronRemind(T("2026-11-16T14:40:00Z"));                      // 16:40
  ok(ra.auto === 1, "авто: понеделник 16:40 — записва");
  const m9 = TC.sessions((await TC.rpc("tc_rows", { p_from: "2026-11-16", p_to: "2026-11-16" })).filter(x => x.user_id === -9), T("2026-11-17T10:00:00Z"));
  ok(m9.length === 1 && Math.round(m9[0].min) === 480 && m9[0].src === "auto" && m9[0].brk === 30 && !m9[0].auto, "авто: 8 ч нетно, със 30 мин почивка, отбелязано „auto“ (" + Math.round(m9[0].min) + ")");
  ra = await REM.cronRemind(T("2026-11-16T15:00:00Z"));
  ok(!ra.auto, "авто: втори път същия ден — не дублира");
  ra = await REM.cronRemind(T("2026-11-18T14:40:00Z"));                      // сряда
  ok(!ra.auto, "авто: сряда — не записва");
  ra = await REM.cronRemind(T("2026-11-20T14:40:00Z"));                      // петък
  ok(ra.auto === 1, "авто: петък — записва");
  TC.MOCK.log.filter(x => x.user_id === -9 && x.for_date === "2026-11-20").forEach(x => { x.voided_at = new Date().toISOString(); });   // отсъствие: собственикът отменя
  ra = await REM.cronRemind(T("2026-11-20T15:00:00Z"));
  ok(!ra.auto && !TC.MOCK.log.some(x => x.user_id === -9 && x.for_date === "2026-11-20" && !x.voided_at), "авто: отменен ден не се връща");
  ra = await REM.cronRemind(T("2026-12-25T14:40:00Z"));                      // 25.12 — празник (петък)
  ok(!ra.auto, "авто: официален празник — не записва");
  console.log(fails ? "\nПРОВАЛИ: " + fails : "\nВСИЧКО МИНА");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
