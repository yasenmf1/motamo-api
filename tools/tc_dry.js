// tools/tc_dry.js — суха проба на lib/timeclock.js: памет вместо Supabase, без пращане в Telegram.
// Пуска се: node tools/tc_dry.js
process.env.TC_MOCK = "1"; process.env.TELEGRAM_BOT_TOKEN = "dry"; process.env.PEEK_TOKEN = "dry";
const TG = require("../lib/telegram.js");
const sent = []; const calls = [];
TG.tgSend = async (text, chat, keep, markup) => { sent.push({ chat, text, markup }); return { ok: true }; };
TG.tgApi = async (m, b) => { calls.push({ m, b }); return { ok: true }; };
TG.sentGet = async () => null; TG.sentSave = async () => {};
global.fetch = async (url) => ({ ok: true, json: async () => [{ user_id: 111, name: "Мария Тест", role: "sklad" }, { user_id: 222, name: "Иван Тест", role: "tochka" }] });
const TC = require("../lib/timeclock.js");
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
  console.log(fails ? "\nПРОВАЛИ: " + fails : "\nВСИЧКО МИНА");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
