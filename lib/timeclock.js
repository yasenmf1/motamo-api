// lib/timeclock.js — ЧАСОВЕ ЗА ЗАПЛАТА през Telegram бота (цех + точка).
// Човек пише „Започнах" / „Приключих" (или натиска бутон) → ред в Supabase `time_log`.
// Без местоположение и без снимки — само кой, кога и от кой обект (цех / точка).
//
// Защита на данните: таблиците `time_staff` и `time_log` са със затворен достъп за anon ключа
// (който е публичен в кода). Достъпът е само през SECURITY DEFINER функциите tc_* с таен ключ,
// изведен от токена на бота (`key()`), така че часовете и имената не се четат отвън.
// Записът е само за добавяне; „отмяна" маркира реда (voided_at), не го трие — следа за проверка.
//
// Собственикът: „екип" (кой е в системата за часове), „часове" (месец + връзка),
// „кой е на работа", „/час Име започна|приключи 07:30 [дд.мм]" (поправка), сутрешен отчет (cron tc_report).
const crypto = require("crypto");
const TG = require("./telegram.js");

const SITE_BG = { cex: "Цех", shop: "Точка" };
const MAX_OPEN_H = 16;          // отворена смяна над толкова часа = „забравен край"
const BACKFILL_H = 14;          // колко назад може да се отбележи пропуснат час
const UNDO_MIN = 10;            // „Отмени" е на разположение толкова минути

const key = () => process.env.TELEGRAM_BOT_TOKEN
  ? crypto.createHash("sha256").update("motamo-time:" + process.env.TELEGRAM_BOT_TOKEN).digest("hex").slice(0, 32) : null;
const hoursKey = () => process.env.PEEK_TOKEN
  ? crypto.createHash("sha256").update("motamo-hours:" + process.env.PEEK_TOKEN).digest("hex").slice(0, 24) : null;

// ── достъп до базата (RPC) + памет за тестове ────────────────────────────────
const MOCK = { staff: [], log: [], seq: 1 };
const sofiaDateOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date(d));
async function rpc(fn, args) {
  if (process.env.TC_MOCK === "1") return mockRpc(fn, args || {});
  const k = key(); if (!k) throw new Error("no_bot_token");
  const r = await fetch(`${TG.SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: TG.sbH, body: JSON.stringify({ p_key: k, ...(args || {}) }) });
  const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { /* празно */ }
  if (!r.ok) { const m = (j && (j.message || j.hint)) || txt; const e = new Error(String(m).slice(0, 120)); e.code = String(m).includes("not_staff") ? "not_staff" : "db"; throw e; }
  return j;
}
function mockRpc(fn, a) {
  const live = () => MOCK.log.filter(x => !x.voided_at);
  if (fn === "tc_staff_list") return MOCK.staff.slice();
  if (fn === "tc_staff_set") { const i = MOCK.staff.findIndex(s => s.user_id === a.p_user); const row = { user_id: a.p_user, name: a.p_name, site: a.p_site, active: a.p_active }; if (i < 0) MOCK.staff.push(row); else MOCK.staff[i] = row; return null; }
  if (fn === "tc_add") {
    const s = MOCK.staff.find(x => x.user_id === a.p_user && x.active); if (!s) { const e = new Error("not_staff"); e.code = "not_staff"; throw e; }
    const row = { id: MOCK.seq++, user_id: a.p_user, name: s.name, site: s.site, kind: a.p_kind, at: new Date(a.p_at).toISOString(), for_date: sofiaDateOf(a.p_at), source: a.p_source || "telegram", note: a.p_note || null, voided_at: null, created_at: new Date().toISOString() };
    MOCK.log.push(row); return row;
  }
  if (fn === "tc_last") { const l = live().filter(x => x.user_id === a.p_user).sort((x, y) => new Date(y.at) - new Date(x.at) || y.id - x.id); return l[0] || null; }
  if (fn === "tc_rows") return live().filter(x => x.for_date >= a.p_from && x.for_date <= a.p_to).sort((x, y) => x.user_id - y.user_id || new Date(x.at) - new Date(y.at) || x.id - y.id);
  if (fn === "tc_open") { const by = {}; live().forEach(x => { if (!by[x.user_id] || x.id > by[x.user_id].id) by[x.user_id] = x; }); return Object.values(by).filter(x => x.kind === "in"); }
  if (fn === "tc_void") { const x = MOCK.log.find(y => y.id === a.p_id); if (x && !x.voided_at) x.voided_at = new Date().toISOString(); return null; }
  throw new Error("unknown_rpc");
}

// ── време ─────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const fmtT = (iso) => new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const fmtDM = (isoDate) => isoDate.slice(8, 10) + "." + isoDate.slice(5, 7);
const hm = (min) => Math.floor(min / 60) + "ч " + pad(Math.round(min % 60)) + "м";
// „ЧЧ:ММ" в София на дадена дата (YYYY-MM-DD) → UTC момент
function sofiaToUtc(dateStr, h, m) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  for (const off of [3, 2]) {
    const t = new Date(Date.UTC(y, mo - 1, d, h - off, m));
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false }).format(t);
    if (p === pad(h) + ":" + pad(m) && sofiaDateOf(t) === dateStr) return t;
  }
  return new Date(Date.UTC(y, mo - 1, d, h - 2, m));
}
const monthRange = (ym) => { const [y, m] = ym.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return [`${ym}-01`, `${ym}-${pad(last)}`]; };

// ── разбор на текста ──────────────────────────────────────────────────────────
const IN_RE = /^(▶️\s*)?(започнах|започвам|започва|започни|на работа|влязох|влизам|старт)(?![а-я])/i;
const OUT_RE = /^(⏹️?\s*)?(приключих|приключвам|приключи|край|свърших|излязох|излизам|стоп)(?![а-я])/i;
function parseKind(text) { const t = String(text || "").trim(); return IN_RE.test(t) ? "in" : OUT_RE.test(t) ? "out" : null; }
// „започнах 7:30" / „приключих 16.05" → { h, m } или null
function parseTime(text) { const m = /(?:^|\s)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/.exec(String(text || "")); return m ? { h: Number(m[1]), m: Number(m[2]) } : null; }
// Избира момента: без час → сега; с час → днес (или вчера след полунощ), не в бъдещето и не по-старо от BACKFILL_H.
function resolveAt(tm, now) {
  if (!tm) return { at: now, retro: false };
  let at = sofiaToUtc(sofiaDateOf(now), tm.h, tm.m);
  if (at - now > 5 * 60000) at = new Date(at.getTime() - 24 * 3600000);
  if (at - now > 5 * 60000) return { error: "Часът е в бъдещето." };
  if (now - at > BACKFILL_H * 3600000) return { error: "Часът е отпреди повече от " + BACKFILL_H + " часа — кажи на Ясен да го нанесе." };
  return { at, retro: now - at > 2 * 60000 };
}

// ── сметка на часовете от редовете ───────────────────────────────────────────
// Двойка „влязъл → излязъл" по човек. Влизане без излизане → непълна (флаг), излизане без влизане → флаг.
function sessions(rows, now) {
  const by = {}; rows.forEach(r => { (by[r.user_id] = by[r.user_id] || []).push(r); });
  const out = [];
  Object.values(by).forEach(list => {
    list.sort((a, b) => new Date(a.at) - new Date(b.at) || a.id - b.id);
    let open = null;
    const base = (r) => ({ user_id: r.user_id, name: r.name, site: r.site });
    list.forEach(r => {
      if (r.kind === "in") {
        if (open) out.push({ ...base(open), date: open.for_date, start: open.at, end: null, min: 0, flag: "no_out" });
        open = r;
      } else if (open) {
        const min = Math.max(0, (new Date(r.at) - new Date(open.at)) / 60000);
        out.push({ ...base(open), date: open.for_date, start: open.at, end: r.at, min, flag: min > MAX_OPEN_H * 60 ? "long" : null });
        open = null;
      } else out.push({ ...base(r), date: r.for_date, start: null, end: r.at, min: 0, flag: "no_in" });
    });
    if (open) {
      const ageH = ((now || new Date()) - new Date(open.at)) / 3600000;
      out.push({ ...base(open), date: open.for_date, start: open.at, end: null, min: 0, flag: ageH > MAX_OPEN_H ? "no_out" : "working" });
    }
  });
  return out;
}
function totals(sess) {
  const by = {};
  sess.forEach(s => {
    const k = s.user_id; const t = by[k] = by[k] || { user_id: k, name: s.name, site: s.site, min: 0, days: new Set(), flags: [] };
    t.min += s.min; if (s.min > 0) t.days.add(s.date);
    if (s.flag && s.flag !== "working") t.flags.push({ date: s.date, flag: s.flag });
  });
  return Object.values(by).map(t => ({ ...t, days: t.days.size })).sort((a, b) => (a.site === b.site ? a.name.localeCompare(b.name, "bg") : a.site.localeCompare(b.site)));
}
const FLAG_BG = { no_out: "без край", no_in: "без начало", long: "над " + MAX_OPEN_H + " ч", working: "в момента на работа" };

// ── хора ──────────────────────────────────────────────────────────────────────
async function getStaff(uid) { const l = await rpc("tc_staff_list"); return (l || []).find(s => Number(s.user_id) === Number(uid) && s.active) || null; }
async function staffAll() { return (await rpc("tc_staff_list")) || []; }
async function allTgUsers() {
  const r = await fetch(`${TG.SB_URL}/rest/v1/cex_tg_users?select=user_id,name,role&order=name`, { headers: TG.sbH });
  return r.ok ? await r.json() : [];
}
const clockKb = (role) => ({ keyboard: [[{ text: "▶️ Започнах" }, { text: "⏹ Приключих" }], ...(role === "shofior" ? [[{ text: "🚚 Тръгвам" }]] : [])], resize_keyboard: true, is_persistent: true });

async function setStaff(ownerSays, uid, site) {
  const users = await allTgUsers(); const u = users.find(x => Number(x.user_id) === Number(uid));
  const name = (u && u.name) || String(uid);
  if (site === "off") { await rpc("tc_staff_set", { p_user: Number(uid), p_name: name, p_site: "cex", p_active: false }); return { name, site: "off" }; }
  await rpc("tc_staff_set", { p_user: Number(uid), p_name: name, p_site: site, p_active: true });
  await TG.tgSend(`⏱ Записан(а) си за <b>часове за заплата</b> — <b>${SITE_BG[site]}</b>.\nКогато започнеш работа, натисни <b>▶️ Започнах</b>, а като свършиш — <b>⏹ Приключих</b>.\nАко си забравил(а), напиши например <b>започнах 07:30</b>.\n„<b>часове</b>“ ти показва твоите часове за месеца.`, String(uid), null, clockKb(u && u.role)).catch(() => {});
  return { name, site };
}

// ── потребителски действия ────────────────────────────────────────────────────
async function punch(uid, kind, text, now) {
  const staff = await getStaff(uid);
  if (!staff) return { ok: false, text: "Още не си записан(а) за часове. Кажи на Ясен.", noStaff: true };
  const res = resolveAt(parseTime(text), now);
  if (res.error) return { ok: false, text: "⚠️ " + res.error };
  const at = res.at;
  const last = await rpc("tc_last", { p_user: Number(uid) });
  const lastAt = last && last.at ? new Date(last.at) : null;
  let note = res.retro ? "ръчен час" : null, warnOwner = null;
  if (kind === "in") {
    if (last && last.kind === "in") {
      const ageH = (now - lastAt) / 3600000;
      if (ageH < MAX_OPEN_H) return { ok: false, text: `Вече си започнал(а) в <b>${fmtT(last.at)}</b>. Като свършиш — <b>⏹ Приключих</b>.` };
      warnOwner = `⚠️ ${TG.escHtml(staff.name)} не е приключил(а) смяната от ${fmtDM(last.for_date)} (започната ${fmtT(last.at)}). Започна нова.`;
    }
  } else {
    if (!last || last.kind === "out") return { ok: false, text: "Не си започвал(а) смяна. Ако си забравил(а), напиши например <b>започнах 07:30</b>." };
    if (at <= lastAt) return { ok: false, text: "⚠️ Краят трябва да е след началото (" + fmtT(last.at) + ")." };
  }
  if (lastAt && at < lastAt && kind === "in") return { ok: false, text: "⚠️ Часът е преди последния запис (" + fmtT(last.at) + ")." };
  const row = await rpc("tc_add", { p_user: Number(uid), p_kind: kind, p_at: at.toISOString(), p_source: "telegram", p_note: note });
  if (warnOwner) TG.tgSend(warnOwner, TG.OWNER_CHAT_ID).catch(() => {});
  let msg;
  if (kind === "in") msg = `✅ Започна в <b>${fmtT(row.at)}</b> (${SITE_BG[staff.site]}). Успешна смяна!`;
  else { const min = (new Date(row.at) - lastAt) / 60000; msg = `✅ Приключи в <b>${fmtT(row.at)}</b>. Смяната: <b>${hm(min)}</b>.`; }
  const markup = { inline_keyboard: [[{ text: "↩️ Отмени (сгреших)", callback_data: "tc:undo:" + row.id }]] };
  return { ok: true, text: msg + (res.retro ? "\n<i>Часът е нанесен ръчно.</i>" : ""), markup, row };
}

async function myMonth(uid, now) {
  const ym = sofiaDateOf(now).slice(0, 7), [a, b] = monthRange(ym);
  const rows = (await rpc("tc_rows", { p_from: a, p_to: b }) || []).filter(r => Number(r.user_id) === Number(uid));
  const s = sessions(rows, now), t = totals(s)[0];
  const cur = s.find(x => x.flag === "working");
  return `📊 <b>Твоите часове · ${fmtDM(a).slice(3)}.${ym.slice(0, 4)}</b>\n${t ? `${hm(t.min)} в ${t.days} дни` : "още няма записани часове"}${cur ? `\n⏳ В момента си на работа от ${fmtT(cur.start)}` : ""}`;
}

// ── отчети за собственика ─────────────────────────────────────────────────────
function summaryText(from, to, sess, title) {
  const T = totals(sess); const lines = [];
  ["cex", "shop"].forEach(site => {
    const g = T.filter(t => t.site === site); if (!g.length) return;
    lines.push(`<b>${SITE_BG[site]}</b>`);
    g.forEach(t => lines.push(`• ${TG.escHtml(t.name)} — ${hm(t.min)} (${t.days} дни)${t.flags.length ? " ⚠️ " + t.flags.map(f => fmtDM(f.date) + " " + FLAG_BG[f.flag]).join(", ") : ""}`));
    lines.push(`Общо: ${hm(g.reduce((s, t) => s + t.min, 0))}`);
  });
  return `${title}\n${lines.length ? lines.join("\n") : "няма записани часове"}`;
}
async function ownerHours(now, base) {
  const ym = sofiaDateOf(now).slice(0, 7), [a, b] = monthRange(ym);
  const rows = await rpc("tc_rows", { p_from: a, p_to: b }) || [];
  const txt = summaryText(a, b, sessions(rows, now), `📊 <b>Часове · ${ym.slice(5)}.${ym.slice(0, 4)}</b> (до днес)`);
  const link = hoursKey() ? { inline_keyboard: [[{ text: "📋 Таблица за месеца", url: `${base}?view=hours&k=${hoursKey()}&m=${ym}` }]] } : null;
  return { text: txt, markup: link };
}
async function whoIsIn(now) {
  const o = await rpc("tc_open") || [];
  const lines = o.map(r => `• ${TG.escHtml(r.name)} (${SITE_BG[r.site]}) от ${fmtT(r.at)}${(now - new Date(r.at)) / 3600000 > MAX_OPEN_H ? " ⚠️ забравен край?" : ""}`);
  return lines.length ? "⏳ <b>Сега на работа:</b>\n" + lines.join("\n") : "Сега никой не е отбелязан на работа.";
}
async function teamMessage() {
  const users = await allTgUsers(); const staff = await staffAll(); const by = {}; staff.forEach(s => { by[Number(s.user_id)] = s; });
  const rows = users.filter(u => u.role !== "none").slice(0, 24).map(u => {
    const s = by[Number(u.user_id)], n = String(u.name || u.user_id).slice(0, 18);
    const on = (site) => s && s.active && s.site === site;
    return [{ text: (on("cex") ? "✅" : "") + "🏭 " + n, callback_data: `ts:${u.user_id}:cex` }, { text: (on("shop") ? "✅" : "") + "🏪 " + n, callback_data: `ts:${u.user_id}:shop` }, { text: "✖", callback_data: `ts:${u.user_id}:off` }];
  });
  return { text: "👥 <b>Кой отбелязва часове?</b>\n🏭 Цех · 🏪 Точка · ✖ махни. Натисни до името.", markup: { inline_keyboard: rows } };
}
// „/час Име започна|приключи 07:30 [дд.мм]" — поправка от собственика
async function ownerEdit(text, now) {
  const m = /^\/?час\s+(.+?)\s+(започна|започнах|приключи|приключих)\s+([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s+(\d{1,2})[.\/](\d{1,2}))?\s*$/i.exec(text);
  if (!m) return null;
  const staff = (await staffAll()).filter(s => s.active);
  const q = m[1].trim().toLowerCase(), hit = staff.filter(s => String(s.name).toLowerCase().includes(q));
  if (hit.length !== 1) return { text: hit.length ? "Повече от един: " + hit.map(h => TG.escHtml(h.name)).join(", ") + ". Напиши по-точно." : "Не намирам такъв в екипа." };
  const kind = /^започ/.test(m[2].toLowerCase()) ? "in" : "out";
  const today = sofiaDateOf(now); let dateStr = today;
  if (m[5]) dateStr = `${today.slice(0, 4)}-${pad(m[6])}-${pad(m[5])}`;
  const at = sofiaToUtc(dateStr, Number(m[3]), Number(m[4]));
  if (at - now > 5 * 60000) return { text: "Часът е в бъдещето." };
  const row = await rpc("tc_add", { p_user: Number(hit[0].user_id), p_kind: kind, p_at: at.toISOString(), p_source: "owner", p_note: "нанесено от собственика" });
  return { text: `✅ Нанесено: ${TG.escHtml(hit[0].name)} — ${kind === "in" ? "започнал" : "приключил"} ${fmtDM(row.for_date)} в ${fmtT(row.at)}.` };
}

// ── входни точки от webhook ───────────────────────────────────────────────────
// Връща true, ако съобщението е за часове. u = запис от cex_tg_users, isOwner = дали е собственикът.
async function handleMessage(uid, text, u, isOwner, host, now) {
  now = now || new Date();
  const base = "https://" + (host || "motamo-api.vercel.app") + "/api/transfer";
  const t = String(text || "").trim();
  const reply = (s, markup) => TG.tgSend(s, String(uid), null, markup);
  if (isOwner) {
    if (/^\/?(екип|екип часове)$/i.test(t)) { const m = await teamMessage(); await reply(m.text, m.markup); return true; }
    if (/^\/?часове$/i.test(t)) { const m = await ownerHours(now, base); await reply(m.text, m.markup); return true; }
    if (/^\/?(кой е на работа|кой е тук)$/i.test(t)) { await reply(await whoIsIn(now)); return true; }
    if (/^\/?час\s/i.test(t)) { const r = await ownerEdit(t, now); if (r) { await reply(r.text); return true; } }
  }
  const kind = parseKind(t);
  const isMine = /^\/?(моите часове|мои часове|часове|статус)$/i.test(t);
  if (!kind && !isMine) return false;
  const staff = await getStaff(uid).catch(() => null);
  if (!staff) { if (kind && /^(▶️|⏹)/.test(t)) { await reply("Още не си записан(а) за часове. Кажи на Ясен."); return true; } return false; }
  if (isMine) { await reply(await myMonth(uid, now)); return true; }
  const r = await punch(uid, kind, t, now);
  await reply(r.text, r.markup);
  return true;
}
async function handleCallback(cq, isOwner, host, now) {
  now = now || new Date();
  const d = String(cq.data || ""), from = cq.from || {}, uid = Number(from.id);
  let m;
  if ((m = /^ts:(\d+):(cex|shop|off)$/.exec(d))) {
    if (!isOwner) { await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Само собственикът." }); return true; }
    const r = await setStaff(true, Number(m[1]), m[2]);
    await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: r.site === "off" ? "Махнат(а): " + r.name : r.name + " → " + SITE_BG[r.site] });
    if (cq.message) { const tm = await teamMessage(); await TG.tgApi("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: "HTML", text: tm.text, reply_markup: tm.markup }); }
    return true;
  }
  if ((m = /^tc:undo:(\d+)$/.exec(d))) {
    const last = await rpc("tc_last", { p_user: uid });
    if (!last || Number(last.id) !== Number(m[1])) { await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Вече не може да се отмени." }); return true; }
    if ((now - new Date(last.created_at || last.at)) / 60000 > UNDO_MIN) { await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Минаха повече от " + UNDO_MIN + " минути — кажи на Ясен." }); return true; }
    await rpc("tc_void", { p_id: Number(m[1]), p_by: "self:" + uid });
    await TG.tgApi("answerCallbackQuery", { callback_query_id: cq.id, text: "Отменено" });
    if (cq.message) await TG.tgApi("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, parse_mode: "HTML", text: "↩️ Отменен запис в " + fmtT(last.at) + "." });
    return true;
  }
  return false;
}

// ── сутрешен отчет (cron) ─────────────────────────────────────────────────────
async function cronReport(now) {
  now = now || new Date();
  const hr = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(now)) % 24;
  if (hr < 8 || hr > 10) return { ok: true, skipped: "not_morning" };
  const today = sofiaDateOf(now);
  if (await TG.sentGet("tc_report", today).catch(() => null)) return { ok: true, skipped: "already" };
  const y = TG.plusDays(today, -1);
  const rows = await rpc("tc_rows", { p_from: y, p_to: y }) || [];
  const open = await rpc("tc_open") || [];
  const sess = sessions(rows, now);
  const forgot = open.filter(r => (now - new Date(r.at)) / 3600000 > MAX_OPEN_H);
  if (!sess.length && !forgot.length) { await TG.sentSave("tc_report", today, { empty: true }).catch(() => {}); return { ok: true, empty: true }; }
  let txt = summaryText(y, y, sess.filter(s => s.flag !== "working"), `⏱ <b>Часове · вчера ${fmtDM(y)}</b>`);
  if (forgot.length) txt += "\n\n⚠️ <b>Забравен край:</b> " + forgot.map(r => `${TG.escHtml(r.name)} (от ${fmtDM(r.for_date)} ${fmtT(r.at)})`).join(", ") + "\nПоправка: <code>/час Име приключи 16:00 " + fmtDM(forgot[0].for_date) + "</code>";
  await TG.tgSend(txt, TG.OWNER_CHAT_ID).catch(() => {});
  await TG.sentSave("tc_report", today, { sess: sess.length, forgot: forgot.length }).catch(() => {});
  return { ok: true, sent: true, sessions: sess.length, forgot: forgot.length };
}

// ── уеб таблица за месеца (за счетоводителя) ─────────────────────────────────
async function monthData(ym, now) {
  const [a, b] = monthRange(ym);
  const rows = await rpc("tc_rows", { p_from: a, p_to: b }) || [];
  const sess = sessions(rows, now || new Date());
  return { a, b, sess, totals: totals(sess) };
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
async function hoursPage(k, ym, now) {
  now = now || new Date();
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) ym = sofiaDateOf(now).slice(0, 7);
  const d = await monthData(ym, now);
  const prev = (() => { const [y, m] = ym.split("-").map(Number); const t = new Date(Date.UTC(y, m - 2, 1)); return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1); })();
  const next = (() => { const [y, m] = ym.split("-").map(Number); const t = new Date(Date.UTC(y, m, 1)); return t.getUTCFullYear() + "-" + pad(t.getUTCMonth() + 1); })();
  const sum = ["cex", "shop"].map(site => {
    const g = d.totals.filter(t => t.site === site); if (!g.length) return "";
    return `<h2>${SITE_BG[site]}</h2><table><tr><th>Служител</th><th>Дни</th><th>Часове</th><th>Десетично</th><th>Бележки</th></tr>`
      + g.map(t => `<tr><td>${esc(t.name)}</td><td>${t.days}</td><td>${hm(t.min)}</td><td>${(t.min / 60).toFixed(2)}</td><td>${t.flags.map(f => esc(fmtDM(f.date) + " " + FLAG_BG[f.flag])).join(", ")}</td></tr>`).join("")
      + `<tr class="tot"><td>Общо</td><td></td><td>${hm(g.reduce((s, t) => s + t.min, 0))}</td><td>${(g.reduce((s, t) => s + t.min, 0) / 60).toFixed(2)}</td><td></td></tr></table>`;
  }).join("");
  const det = d.sess.sort((x, y) => String(x.name).localeCompare(y.name, "bg") || String(x.date).localeCompare(y.date)).map(s =>
    `<tr><td>${esc(s.name)}</td><td>${SITE_BG[s.site]}</td><td>${fmtDM(s.date)}</td><td>${s.start ? fmtT(s.start) : "—"}</td><td>${s.end ? fmtT(s.end) : "—"}</td><td>${s.min ? hm(s.min) : ""}</td><td>${s.flag ? esc(FLAG_BG[s.flag]) : ""}</td></tr>`).join("");
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO · Часове ${esc(ym)}</title><style>
body{margin:0;font:15px system-ui,Segoe UI,Roboto,sans-serif;background:#eef0f3;color:#14171a}.w{max-width:900px;margin:0 auto;padding:14px}
h1{font-size:20px;margin:6px 0}h2{font-size:17px;margin:20px 0 6px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08)}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eee}th{background:#1b2430;color:#fff;font-weight:600}.tot td{font-weight:700;background:#f6f7f9}
.nav a{display:inline-block;margin-right:10px;padding:7px 12px;background:#fff;border-radius:9px;text-decoration:none;color:#14171a;box-shadow:0 1px 4px rgba(0,0,0,.1)}
.note{color:#666;font-size:13px;margin-top:14px}</style></head><body><div class="w">
<h1>⏱ Часове за заплата · ${esc(ym.slice(5))}.${esc(ym.slice(0, 4))}</h1>
<p class="nav"><a href="?view=hours&k=${esc(k)}&m=${prev}">← ${prev}</a><a href="?view=hours&k=${esc(k)}&m=${next}">${next} →</a><a href="?view=hours&k=${esc(k)}&m=${esc(ym)}&fmt=csv">⬇ CSV</a></p>
${sum || "<p>Няма записани часове за месеца.</p>"}
<h2>По дни</h2><table><tr><th>Служител</th><th>Обект</th><th>Дата</th><th>Начало</th><th>Край</th><th>Часове</th><th>Бележка</th></tr>${det}</table>
<p class="note">Часовете са по записите в бота (ръчно нанесените са отбелязани в базата). Смяна без край не се брои, докато не се поправи.</p></div></body></html>`;
}
async function hoursCsv(ym, now) {
  now = now || new Date();
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) ym = sofiaDateOf(now).slice(0, 7);
  const d = await monthData(ym, now);
  const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const head = ["Служител", "Обект", "Дата", "Начало", "Край", "Минути", "Часове", "Бележка"].map(q).join(",");
  return "﻿" + [head].concat(d.sess.map(s => [s.name, SITE_BG[s.site], s.date, s.start ? fmtT(s.start) : "", s.end ? fmtT(s.end) : "", Math.round(s.min), (s.min / 60).toFixed(2), s.flag ? FLAG_BG[s.flag] : ""].map(q).join(","))).join("\n");
}

module.exports = { handleMessage, handleCallback, cronReport, hoursPage, hoursCsv, hoursKey, key, rpc, parseKind, parseTime, resolveAt, sofiaToUtc, sessions, totals, clockKb, MOCK, MAX_OPEN_H };
