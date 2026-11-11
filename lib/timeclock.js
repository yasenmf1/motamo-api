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
const UIV2 = require("./ui-v2.js");
const TG = require("./telegram.js");

const SITE_BG = { cex: "Цех", shop: "Точка" };
const MAX_OPEN_H = 16;          // отворена смяна над толкова часа = „забравен край"
const BACKFILL_H = 14;          // колко назад може да се отбележи пропуснат час
const CFG = { autoBreakMin: 30, autoBreakAfterH: 6, breakRemindH: 4, breakWindows: { cex: [["10:00", "11:30"], ["12:00", "14:00"]], shop: [["14:00", "16:30"]] } };   // автоматична почивка: ако смяна над 6 ч няма отбелязана почивка, при край се приспадат 30 мин; почивка по прозорци: цех 10:00–11:30 и 12:00–14:00, точка 14:00–16:30 (напомняне в началото на прозорец и последно 30 мин преди края на последния)
const UNDO_MIN = 10;            // „Отмени" е на разположение толкова минути

const key = () => process.env.TELEGRAM_BOT_TOKEN
  ? crypto.createHash("sha256").update("motamo-time:" + process.env.TELEGRAM_BOT_TOKEN).digest("hex").slice(0, 32) : null;
const hoursKey = () => process.env.PEEK_TOKEN
  ? crypto.createHash("sha256").update("motamo-hours:" + process.env.PEEK_TOKEN).digest("hex").slice(0, 24) : null;

// ── достъп до базата (RPC) + памет за тестове ────────────────────────────────
const MOCK = { staff: [], log: [], seq: 1, push: [], sched: [] };
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
    const row = { id: MOCK.seq++, user_id: a.p_user, name: s.name, site: s.site, kind: a.p_kind, at: new Date(a.p_at).toISOString(), for_date: sofiaDateOf(a.p_at), source: a.p_source || "telegram", note: a.p_note || null, lat: a.p_lat == null ? null : a.p_lat, lon: a.p_lon == null ? null : a.p_lon, acc: a.p_acc == null ? null : a.p_acc, dist_m: a.p_dist == null ? null : a.p_dist, voided_at: null, created_at: new Date().toISOString() };
    MOCK.log.push(row); return row;
  }
  if (fn === "tc_last") { const l = live().filter(x => x.user_id === a.p_user).sort((x, y) => new Date(y.at) - new Date(x.at) || y.id - x.id); return l[0] || null; }
  if (fn === "tc_rows") return live().filter(x => x.for_date >= a.p_from && x.for_date <= a.p_to).sort((x, y) => x.user_id - y.user_id || new Date(x.at) - new Date(y.at) || x.id - y.id);
  if (fn === "tc_open") { const by = {}; live().forEach(x => { if (!by[x.user_id] || x.id > by[x.user_id].id) by[x.user_id] = x; }); return Object.values(by).filter(x => x.kind !== "out"); }
  if (fn === "tc_void") { const x = MOCK.log.find(y => y.id === a.p_id); if (x && !x.voided_at) x.voided_at = new Date().toISOString(); return null; }
  if (fn === "tc_geo_fail") return null;
  if (fn === "tc_push_set") { const i = MOCK.push.findIndex(x => x.endpoint === a.p_endpoint && x.user_id === a.p_user); const row = { user_id: a.p_user, endpoint: a.p_endpoint, p256dh: a.p_p256dh, auth: a.p_auth }; if (i < 0) MOCK.push.push(row); else MOCK.push[i] = row; return null; }
  if (fn === "tc_push_list") return MOCK.push.slice();
  if (fn === "tc_push_del") { MOCK.push = MOCK.push.filter(x => x.endpoint !== a.p_endpoint); return null; }
  if (fn === "tc_sched_list") return MOCK.sched.slice();
  throw new Error("unknown_rpc");
}

// tc_last връща празен ред (всички полета null), когато няма записи — нормализираме до null.
async function lastRow(uid) { const r = await rpc("tc_last", { p_user: Number(uid) }); return r && r.id != null ? r : null; }

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
    // open = започната смяна; bs = начало на текуща почивка; brk = минути почивка в смяната.
    // Почивката се приспада (не се плаща): min = от начало до край минус почивките.
    let open = null, bs = null, brk = 0;
    const base = (r) => ({ user_id: r.user_id, name: r.name, site: r.site });
    const endBreak = (at) => { if (bs) { brk += Math.max(0, (new Date(at) - new Date(bs.at)) / 60000); bs = null; } };
    list.forEach(r => {
      if (r.kind === "in") {
        if (open) out.push({ ...base(open), date: open.for_date, start: open.at, end: null, min: 0, brk: 0, flag: "no_out" });
        open = r; bs = null; brk = 0;
      } else if (r.kind === "break_start") {
        if (open && !bs) bs = r;
      } else if (r.kind === "break_end") {
        if (open) endBreak(r.at);
      } else if (open) {
        endBreak(r.at);
        const gross = Math.max(0, (new Date(r.at) - new Date(open.at)) / 60000);
        let auto = false;
        if (CFG.autoBreakMin > 0 && brk === 0 && gross > CFG.autoBreakAfterH * 60 && gross <= MAX_OPEN_H * 60) { brk = CFG.autoBreakMin; auto = true; }
        const min = Math.max(0, gross - brk);
        out.push({ ...base(open), date: open.for_date, start: open.at, end: r.at, min, brk, auto, flag: gross > MAX_OPEN_H * 60 ? "long" : null });
        open = null; bs = null; brk = 0;
      } else out.push({ ...base(r), date: r.for_date, start: null, end: r.at, min: 0, brk: 0, flag: "no_in" });
    });
    if (open) {
      const ageH = ((now || new Date()) - new Date(open.at)) / 3600000;
      out.push({ ...base(open), date: open.for_date, start: open.at, end: null, min: 0, brk: brk + (bs ? Math.max(0, ((now || new Date()) - new Date(bs.at)) / 60000) : 0), onBreak: !!bs, flag: ageH > MAX_OPEN_H ? "no_out" : "working" });
    }
  });
  return out;
}
function totals(sess) {
  const by = {};
  sess.forEach(s => {
    const k = s.user_id; const t = by[k] = by[k] || { user_id: k, name: s.name, site: s.site, min: 0, brk: 0, days: new Set(), flags: [] };
    t.min += s.min; t.brk += s.flag === "working" ? 0 : (s.brk || 0); if (s.min > 0) t.days.add(s.date);
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
  const last = await lastRow(uid);
  const lastAt = last && last.at ? new Date(last.at) : null;
  let note = res.retro ? "ръчен час" : null, warnOwner = null;
  if (kind === "in") {
    if (last && last.kind !== "out") {
      const ageH = (now - lastAt) / 3600000;
      if (ageH < MAX_OPEN_H) return { ok: false, text: `Вече си започнал(а) в <b>${fmtT(last.at)}</b>. Като свършиш — <b>⏹ Приключих</b>.` };
      warnOwner = `⚠️ ${TG.escHtml(staff.name)} не е приключил(а) смяната от ${fmtDM(last.for_date)} (започната ${fmtT(last.at)}). Започна нова.`;
    }
  } else {
    if (!last || last.kind === "out") return { ok: false, text: "Не си започвал(а) смяна. Ако си забравил(а), напиши например <b>започнах 07:30</b>." };
    if (at <= lastAt) return { ok: false, text: "⚠️ Краят трябва да е след началото (" + fmtT(last.at) + ")." };
  }
  if (lastAt && at < lastAt && kind === "in") return { ok: false, text: "⚠️ Часът е преди последния запис (" + fmtT(last.at) + ")." };
  if (kind === "out" && last.kind === "break_start") await rpc("tc_add", { p_user: Number(uid), p_kind: "break_end", p_at: at.toISOString(), p_source: "telegram", p_note: "край на почивка при приключване" });
  const row = await rpc("tc_add", { p_user: Number(uid), p_kind: kind, p_at: at.toISOString(), p_source: "telegram", p_note: note });
  if (warnOwner) TG.tgSend(warnOwner, TG.OWNER_CHAT_ID).catch(() => {});
  let msg;
  if (kind === "in") msg = `✅ Започна в <b>${fmtT(row.at)}</b> (${SITE_BG[staff.site]}). Успешна смяна!`;
  else { const min = await lastShiftMin(uid, now); msg = `✅ Приключи в <b>${fmtT(row.at)}</b>. Смяната: <b>${hm(min)}</b>.`; }
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
  const lines = o.map(r => `• ${TG.escHtml(r.name)} (${SITE_BG[r.site]}) ${r.kind === "break_start" ? "☕ на почивка от" : "от"} ${fmtT(r.at)}${(now - new Date(r.at)) / 3600000 > MAX_OPEN_H ? " ⚠️ забравен край?" : ""}`);
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
    const last = await lastRow(uid);
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

// ── ПРИЛОЖЕНИЕ ЗА ТЕЛЕФОНА (лична връзка на всеки служител) ───────────────────
// Всеки има своя връзка ?view=clock&u=<id>&t=<токен>; токенът е sha256(PEEK_TOKEN + id), така че само
// собственикът може да го изготви. Без пароли и без Telegram. Бутоните: Започнах → Почивка → Върнах се → Приключих.
// Почивката се приспада от часовете (неплатена). Приложението не пипа Barsy.
const clockToken = (uid) => process.env.PEEK_TOKEN
  ? crypto.createHash("sha256").update("motamo-clk:" + process.env.PEEK_TOKEN + ":" + Number(uid)).digest("hex").slice(0, 24) : null;
function clockOk(uid, t) {
  const exp = clockToken(uid);
  if (!exp || !/^-?\d{1,15}$/.test(String(uid)) || typeof t !== "string" || t.length !== exp.length) return false;
  return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(exp));
}
// off = не е на работа · work = на работа · brk = на почивка. Отворена над MAX_OPEN_H = забравен край → off.
function stateOf(last, now) {
  if (!last || last.kind === "out") return "off";
  if ((now - new Date(last.at)) / 3600000 > MAX_OPEN_H) return "off";
  return last.kind === "break_start" ? "brk" : "work";
}
async function lastShiftMin(uid, now) {
  const to = sofiaDateOf(now), from = TG.plusDays(to, -2);
  const rows = (await rpc("tc_rows", { p_from: from, p_to: to }) || []).filter(r => Number(r.user_id) === Number(uid));
  const s = sessions(rows, now).filter(x => x.end).sort((a, b) => new Date(a.end) - new Date(b.end));
  return s.length ? s[s.length - 1].min : 0;
}
async function appState(uid, now) {
  now = now || new Date();
  const staff = await getStaff(uid); if (!staff) return { ok: false, error: "not_staff" };
  const last = await lastRow(uid);
  const ym = sofiaDateOf(now).slice(0, 7), [a, b] = monthRange(ym);
  const rows = (await rpc("tc_rows", { p_from: a, p_to: b }) || []).filter(r => Number(r.user_id) === Number(uid));
  const s = sessions(rows, now), t = totals(s.filter(x => x.flag !== "working"))[0];
  const cur = s.find(x => x.flag === "working");
  const st = stateOf(last, now), today = sofiaDateOf(now);
  return {
    ok: true, name: staff.name, site: SITE_BG[staff.site], place: SITES[staff.site], state: st,
    since: last && st !== "off" ? last.at : null, shiftStart: cur && st !== "off" ? cur.start : null,
    brkMin: cur && st !== "off" ? Math.round(cur.brk) : 0, lastId: last ? Number(last.id) : null,
    stale: !!(last && last.kind !== "out" && st === "off"),
    month: { min: Math.round(t ? t.min : 0), days: t ? t.days : 0, brk: Math.round(t ? t.brk : 0) },
    today: rows.filter(r => r.for_date === today).map(r => ({ kind: r.kind, at: r.at })), now: now.toISOString()
  };
}
// Геозона: натискането се приема само до SITES[site].r метра от обекта на човека. Координатите идват от телефона
// (може да се подправят с програма за фалшив GPS — това е защита от небрежност, не от злоумишление).
const SITES = {
  cex:  { lat: 42.44887871646455, lon: 25.68772070005308, r: 150, name: "цеха" },      // координати от собственика (Google Maps), 11.11
  shop: { lat: 42.4296494, lon: 25.6365316, r: 150, name: "точката" }    // ул. Любен Каравелов 101
};
const GEO_MAX_ACC = 200;   // по-слаб сигнал (метри грешка) → не се приема
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = (x) => x * Math.PI / 180, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function geoCheck(site, geo) {
  const S = SITES[site];
  const lat = geo && Number(geo.lat), lon = geo && Number(geo.lon);
  if (!S || !geo || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: "geo" };
  const acc = Number(geo.acc), d = Math.round(distM(lat, lon, S.lat, S.lon));
  if (isFinite(acc) && acc > GEO_MAX_ACC) return { ok: false, error: "weak", acc: Math.round(acc) };
  if (d > S.r) return { ok: false, error: "far", dist: d, place: S.name, r: S.r };
  return { ok: true, dist: d, lat, lon, acc: isFinite(acc) ? Math.round(acc) : null };
}
async function appAct(uid, kind, now, geo) {
  now = now || new Date();
  const staff = await getStaff(uid); if (!staff) return { ok: false, error: "not_staff" };
  if (!["in", "out", "break_start", "break_end"].includes(kind)) return { ok: false, error: "bad_kind" };
  const g = geoCheck(staff.site, geo);
  if (!g.ok) {   // пазим неуспешните опити (координати) — за калибриране на геозоната
    const gl = geo || {};
    rpc("tc_geo_fail", { p_user: Number(uid), p_site: staff.site, p_lat: isFinite(Number(gl.lat)) ? Number(gl.lat) : null, p_lon: isFinite(Number(gl.lon)) ? Number(gl.lon) : null, p_acc: isFinite(Number(gl.acc)) ? Number(gl.acc) : null, p_dist: g.dist == null ? null : g.dist, p_reason: g.error }).catch(() => {});
    return g;
  }
  const last = await lastRow(uid);
  const st = stateOf(last, now);
  if ((kind === "in" && st !== "off") || (kind === "break_start" && st !== "work") || (kind === "break_end" && st !== "brk") || (kind === "out" && st === "off")) return { ok: false, error: "state", state: st };
  if (kind === "in" && last && last.kind !== "out") TG.tgSend(`⚠️ ${TG.escHtml(staff.name)} не е приключил(а) смяната от ${fmtDM(last.for_date)} (започната ${fmtT(last.at)}). Започна нова.`, TG.OWNER_CHAT_ID).catch(() => {});
  const where = { p_lat: g.lat, p_lon: g.lon, p_acc: g.acc, p_dist: g.dist };
  if (kind === "out" && st === "brk") await rpc("tc_add", { p_user: Number(uid), p_kind: "break_end", p_at: now.toISOString(), p_source: "app", p_note: "край на почивка при приключване", ...where });
  const row = await rpc("tc_add", { p_user: Number(uid), p_kind: kind, p_at: now.toISOString(), p_source: "app", p_note: null, ...where });
  return { ok: true, row: { id: Number(row.id), kind: row.kind, at: row.at }, dist: g.dist, min: kind === "out" ? Math.round(await lastShiftMin(uid, now)) : null };
}
async function appUndo(uid, id, now) {
  now = now || new Date();
  const last = await lastRow(uid);
  if (!last || Number(last.id) !== Number(id)) return { ok: false, error: "late" };
  if ((now - new Date(last.created_at || last.at)) / 60000 > UNDO_MIN) return { ok: false, error: "late" };
  await rpc("tc_void", { p_id: Number(id), p_by: "self-app:" + uid });
  return { ok: true };
}
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
function clockManifest(uid, t) {
  return {
    name: "MOTAMO Часове", short_name: "Часове", description: "Започнах, почивка, приключих — часове за заплата.",
    start_url: `/api/transfer?view=clock&u=${uid}&t=${t}`, scope: "/api/", display: "standalone", orientation: "portrait",
    background_color: "#FBF8F3", theme_color: "#FF0000", lang: "bg",
    icons: [{ src: "https://motamo.bg/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }, { src: "https://motamo.bg/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }]
  };
}
function clockPage(uid, t, vapidPub) {
  const cfg = jsonSafe({ u: String(uid), t, vapid: vapidPub || "" });
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>MOTAMO · Часове</title>
<link rel="manifest" href="?view=clockmanifest&u=${encodeURIComponent(uid)}&t=${encodeURIComponent(t)}"><link rel="apple-touch-icon" href="https://motamo.bg/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Часове"><meta name="theme-color" content="#FF0000">
<style>
*{box-sizing:border-box}body{margin:0;font:17px system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#FBF8F3;color:#1b1b1b;min-height:100vh;display:flex;justify-content:center}
.w{width:100%;max-width:460px;padding:18px 16px calc(24px + env(safe-area-inset-bottom))}
.hi{font-size:15px;color:#666;margin:4px 0 14px}.hi b{color:#1b1b1b;font-size:20px;display:block}
.card{background:#fff;border-radius:18px;padding:20px;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;margin-bottom:14px}
.st{font-size:15px;color:#666}.big{font-size:44px;font-weight:700;letter-spacing:.5px;margin:6px 0;font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:5px 12px;border-radius:99px;font-size:14px;font-weight:600}
.p-off{background:#eee;color:#555}.p-work{background:#dff5e3;color:#14692b}.p-brk{background:#fff0cf;color:#8a5a00}
button{width:100%;border:0;border-radius:16px;padding:22px 12px;font-size:22px;font-weight:700;color:#fff;margin-bottom:12px;touch-action:manipulation}
button:disabled{opacity:.5}.go{background:#1f9d44}.pause{background:#e39a0b}.back{background:#1f9d44}.stop{background:#c9302c}
.row{display:flex;gap:10px}.row button{flex:1}
.mini{font-size:15px;color:#444;background:#fff;border-radius:14px;padding:12px 14px;margin-bottom:12px}
.mini b{display:block;font-size:13px;color:#888;font-weight:600;margin-bottom:4px}.ev{display:flex;justify-content:space-between;padding:3px 0}
.undo{background:#fff;border:2px solid #ccc;color:#333;font-size:16px;padding:12px}.msg{text-align:center;color:#c9302c;min-height:22px;font-size:15px}
.tip{font-size:13px;color:#888;text-align:center;margin-top:10px}
.loc{text-align:center;font-size:14px;font-weight:600;border-radius:12px;padding:9px;margin-bottom:12px;background:#eee;color:#555}.loc.ok{background:#dff5e3;color:#14692b}.loc.bad{background:#fde3e1;color:#a3231f}
</style></head><body><div class="w">
<div class="hi" id="hi">Зареждам…</div>
<div class="card"><span class="pill p-off" id="pill">…</span><div class="big" id="big">--:--</div><div class="st" id="st"></div></div>
<div class="loc" id="loc">📍 Проверявам къде си…</div>
<div id="btns"></div><div class="msg" id="msg"></div><div id="undo"></div><div id="pushbox"></div>
<div class="mini" id="today" style="display:none"><b>ДНЕС</b><div id="evs"></div></div>
<div class="mini" id="mon" style="display:none"></div>
<div class="tip">Съвет: „Добави към началния екран“ от менюто на браузъра — и ще се отваря като приложение.</div>
</div><script>
var C=${cfg},S=null,off=0,undoT=null;
var API="/api/transfer?view=clockapi&u="+encodeURIComponent(C.u)+"&t="+encodeURIComponent(C.t);
function $(i){return document.getElementById(i)}
function hm(m){m=Math.max(0,Math.round(m));return Math.floor(m/60)+"ч "+("0"+(m%60)).slice(-2)+"м"}
function tm(iso){return new Intl.DateTimeFormat("bg-BG",{timeZone:"Europe/Sofia",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso))}
function now(){return Date.now()+off}
function call(op,extra){var b=Object.assign({op:op},extra||{});return fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json()})}
var KN={in:"Започна",out:"Приключи",break_start:"Почивка",break_end:"Върна се"};
function draw(){
  if(!S)return;
  $("hi").innerHTML="Здравей,<b></b>";$("hi").querySelector("b").textContent=S.name+" · "+S.site;
  var p=$("pill"),b=$("btns");
  if(S.state==="off"){p.className="pill p-off";p.textContent="Не си на работа";}
  else if(S.state==="work"){p.className="pill p-work";p.textContent="На работа";}
  else{p.className="pill p-brk";p.textContent="На почивка";}
  b.innerHTML="";
  function btn(cls,txt,kind){var e=document.createElement("button");e.className=cls;e.textContent=txt;e.onclick=function(){act(kind,e)};b.appendChild(e)}
  if(S.state==="off")btn("go","▶️ Започнах","in");
  else if(S.state==="work"){btn("pause","☕ Почивка","break_start");btn("stop","⏹ Приключих","out");}
  else{btn("back","▶️ Върнах се","break_end");btn("stop","⏹ Приключих","out");}
  var ev=$("evs");ev.innerHTML="";
  (S.today||[]).forEach(function(e){var d=document.createElement("div");d.className="ev";d.innerHTML="<span></span><span></span>";d.children[0].textContent=KN[e.kind]||e.kind;d.children[1].textContent=tm(e.at);ev.appendChild(d)});
  $("today").style.display=(S.today&&S.today.length)?"block":"none";
  var m=$("mon");m.style.display="block";m.innerHTML="<b>ТОЗИ МЕСЕЦ</b>";m.appendChild(document.createTextNode(hm(S.month.min)+" в "+S.month.days+" дни"+(S.month.brk?" · почивки "+S.month.brk+" мин":"")));
  tick();
}
function tick(){
  if(!S)return;var big=$("big"),st=$("st");
  if(S.state==="off"){big.textContent="--:--";st.textContent=S.stale?"Предишната смяна няма край — кажи на Ясен.":"Натисни „Започнах“, когато почнеш.";return}
  var since=new Date(S.since).getTime(),shift=new Date(S.shiftStart||S.since).getTime();
  if(S.state==="work"){var min=(now()-shift)/60000-S.brkMin;big.textContent=hm(min);st.textContent="Започна в "+tm(S.shiftStart||S.since)+(S.brkMin?" · почивки "+S.brkMin+" мин":"")}
  else{big.textContent=hm((now()-since)/60000);st.textContent="Почивка от "+tm(S.since)}
}
function load(){return call("state").then(function(r){if(!r.ok){$("hi").textContent="Тази връзка не е активна. Кажи на Ясен.";$("pill").style.display="none";return}S=r;off=new Date(r.now).getTime()-Date.now();draw();if(!window._init){window._init=1;checkLoc();pushInit()}}).catch(function(){$("msg").textContent="Няма връзка. Опитай пак."})}
function hav(a,b,c,d){var R=6371000,r=function(x){return x*Math.PI/180},dl=r(c-a),dn=r(d-b),h=Math.sin(dl/2)*Math.sin(dl/2)+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dn/2)*Math.sin(dn/2);return 2*R*Math.asin(Math.sqrt(h))}
function getPos(){return new Promise(function(res,rej){if(!navigator.geolocation)return rej({code:0});navigator.geolocation.getCurrentPosition(function(p){res({lat:p.coords.latitude,lon:p.coords.longitude,acc:p.coords.accuracy})},function(e){rej(e)},{enableHighAccuracy:true,timeout:15000,maximumAge:0})})}
function geoMsg(e){if(e&&e.code===1)return "Локацията е забранена. Включи я: настройки на браузъра → Разрешения → Местоположение → „Разреши“ (най-добре „Винаги“), после опитай пак.";if(e&&e.code===0)return "Този телефон не дава локация.";return "Не хванах локацията. Включи GPS и опитай пак (по-добре на открито)."}
function checkLoc(){
  var el=$("loc");if(!S||!S.place)return;
  getPos().then(function(g){var d=Math.round(hav(g.lat,g.lon,S.place.lat,S.place.lon));
    if(g.acc>200){el.className="loc bad";el.textContent="📍 Слаб GPS сигнал (±"+Math.round(g.acc)+" м)";return}
    if(d<=S.place.r){el.className="loc ok";el.textContent="📍 На мястото си ("+S.place.name+")"}else{el.className="loc bad";el.textContent="📍 Далеч от "+S.place.name+" — "+(d>=1000?(d/1000).toFixed(1)+" км":d+" м")}
  },function(e){el.className="loc bad";el.textContent="📍 "+geoMsg(e)})
}
function enable(){var all=document.querySelectorAll("button");for(var i=0;i<all.length;i++)all[i].disabled=false}
function act(kind,el){
  if(kind==="out"&&!confirm("Приключваш ли работа?"))return;
  var all=document.querySelectorAll("button");for(var i=0;i<all.length;i++)all[i].disabled=true;$("msg").style.color="#c9302c";$("msg").textContent="Проверявам къде си…";
  getPos().then(function(g){return call("act",{kind:kind,geo:g}).then(function(r){
    if(!r.ok&&r.error==="far"){$("msg").textContent="Не си в "+r.place+" ("+r.dist+" м). Отбелязването става само на работното място.";enable();checkLoc();return}
    if(!r.ok&&r.error==="weak"){$("msg").textContent="Слаб GPS сигнал (±"+r.acc+" м). Опитай на открито.";enable();return}
    if(!r.ok&&r.error==="geo"){$("msg").textContent="Липсва локация. Разреши я и опитай пак.";enable();return}
    if(!r.ok&&r.error!=="state"){$("msg").textContent="Не се записа. Опитай пак.";return load()}
    if(!r.ok){$("msg").textContent="Вече е отбелязано.";return load()}
    $("msg").textContent="";
    return load().then(function(){if(kind==="out"&&r.min!=null)$("msg").style.color="#14692b",$("msg").textContent="Смяната: "+hm(r.min);showUndo(r.row.id)})
  })},function(e){$("msg").textContent=geoMsg(e);enable()}).catch(function(){$("msg").textContent="Няма връзка. Провери дали се е записало.";load()});
}
function b64(s){var p="=".repeat((4-s.length%4)%4),b=(s+p).replace(/-/g,"+").replace(/_/g,"/"),r=atob(b),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
function subscribe(reg){
  return reg.pushManager.getSubscription().then(function(s){return s||reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(C.vapid)})}).then(function(s){
    return call("push",{sub:s.toJSON()}).then(function(){$("pushbox").innerHTML='<div class="tip">🔔 Напомнянията са включени.</div>'})
  }).catch(function(){})
}
function pushInit(){
  var box=$("pushbox");
  if(!C.vapid)return;
  if(!("serviceWorker" in navigator)||!("PushManager" in window)||!("Notification" in window)){box.innerHTML='<div class="mini">🔔 За напомняния добави приложението към началния екран (меню → „Добави към началния екран“) и го отвори оттам.</div>';return}
  navigator.serviceWorker.register("/api/transfer?view=clocksw",{scope:"/api/"}).then(function(reg){
    if(Notification.permission==="granted")return subscribe(reg);
    if(Notification.permission==="denied"){box.innerHTML='<div class="mini">🔕 Известията са изключени. Включи ги от настройките на браузъра.</div>';return}
    box.innerHTML="";var b=document.createElement("button");b.className="undo";b.textContent="🔔 Включи напомняния";
    b.onclick=function(){Notification.requestPermission().then(function(p){if(p==="granted")subscribe(reg);else pushInit()})};box.appendChild(b)
  }).catch(function(){})
}
function showUndo(id){
  var u=$("undo");u.innerHTML="";var e=document.createElement("button");e.className="undo";e.textContent="↩️ Отмени (сгреших)";
  e.onclick=function(){e.disabled=true;call("undo",{id:id}).then(function(r){u.innerHTML="";$("msg").style.color="#c9302c";$("msg").textContent=r.ok?"Отменено.":"Вече не може — кажи на Ясен.";load()})};
  u.appendChild(e);clearTimeout(undoT);undoT=setTimeout(function(){u.innerHTML=""},600000)
}
load();setInterval(tick,15000);document.addEventListener("visibilitychange",function(){if(!document.hidden)load()});
</script></body></html>`;
}
// страница за собственика: личните връзки на всички служители
async function clockTeamPage(base) {
  const staff = (await staffAll()).filter(s => s.active);
  const row = (s) => { const link = `${base}?view=clock&u=${s.user_id}&t=${clockToken(s.user_id)}`; return `<tr><td>${esc(s.name)}</td><td>${SITE_BG[s.site]}</td><td><input readonly value="${esc(link)}" onclick="this.select()" style="width:100%;font-size:12px"></td><td><a href="${esc(link)}">Отвори</a></td></tr>`; };
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO · Връзки за часове</title><style>
body{margin:0;font:15px system-ui,sans-serif;background:#eef0f3;color:#14171a}.w{max-width:900px;margin:0 auto;padding:14px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eee}th{background:#1b2430;color:#fff}</style></head><body><div class="w"><h1>⏱ Връзки за часове</h1>
<p>Всеки служител получава САМО своята връзка (Вайбър/съобщение) и я „добавя към началния екран“. Връзките са лични — не ги препращай на други.</p>
<table><tr><th>Служител</th><th>Обект</th><th>Връзка</th><th></th></tr>${staff.map(row).join("") || "<tr><td colspan=4>Екипът е празен.</td></tr>"}</table></div></body></html>`;
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
    return `<h2>${SITE_BG[site]}</h2><table><tr><th>Служител</th><th>Дни</th><th>Часове</th><th>Десетично</th><th>Почивки</th><th>Бележки</th></tr>`
      + g.map(t => `<tr><td>${esc(t.name)}</td><td>${t.days}</td><td>${hm(t.min)}</td><td>${(t.min / 60).toFixed(2)}</td><td>${t.brk ? Math.round(t.brk) + " мин" : ""}</td><td>${t.flags.map(f => esc(fmtDM(f.date) + " " + FLAG_BG[f.flag])).join(", ")}</td></tr>`).join("")
      + `<tr class="tot"><td>Общо</td><td></td><td>${hm(g.reduce((s, t) => s + t.min, 0))}</td><td>${(g.reduce((s, t) => s + t.min, 0) / 60).toFixed(2)}</td><td></td><td></td></tr></table>`;
  }).join("");
  const det = d.sess.sort((x, y) => String(x.name).localeCompare(y.name, "bg") || String(x.date).localeCompare(y.date)).map(s =>
    `<tr><td>${esc(s.name)}</td><td>${SITE_BG[s.site]}</td><td>${fmtDM(s.date)}</td><td>${s.start ? fmtT(s.start) : "—"}</td><td>${s.end ? fmtT(s.end) : "—"}</td><td>${s.min ? hm(s.min) : ""}</td><td>${s.brk ? Math.round(s.brk) + " мин" + (s.auto ? " (авт.)" : "") : ""}</td><td>${s.flag ? esc(FLAG_BG[s.flag]) : ""}</td></tr>`).join("");
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">${UIV2.fonts}<meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO · Часове ${esc(ym)}</title><style>
body{margin:0;font:15px system-ui,Segoe UI,Roboto,sans-serif;background:#eef0f3;color:#14171a}.w{max-width:900px;margin:0 auto;padding:14px}
h1{font-size:20px;margin:6px 0}h2{font-size:17px;margin:20px 0 6px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08)}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #eee}th{background:#1b2430;color:#fff;font-weight:600}.tot td{font-weight:700;background:#f6f7f9}
.nav a{display:inline-block;margin-right:10px;padding:7px 12px;background:#fff;border-radius:9px;text-decoration:none;color:#14171a;box-shadow:0 1px 4px rgba(0,0,0,.1)}
.note{color:#666;font-size:13px;margin-top:14px}${UIV2.css}</style></head><body><div class="w">
<h1>⏱ Часове за заплата · ${esc(ym.slice(5))}.${esc(ym.slice(0, 4))}</h1>
<p class="nav"><a href="?view=hours&k=${esc(k)}&m=${prev}">← ${prev}</a><a href="?view=hours&k=${esc(k)}&m=${next}">${next} →</a><a href="?view=hours&k=${esc(k)}&m=${esc(ym)}&fmt=csv">⬇ CSV</a></p>
${sum || "<p>Няма записани часове за месеца.</p>"}
<h2>По дни</h2><table><tr><th>Служител</th><th>Обект</th><th>Дата</th><th>Начало</th><th>Край</th><th>Часове</th><th>Почивка</th><th>Бележка</th></tr>${det}</table>
<p class="note">Часовете са по записите в приложението и бота (ръчно нанесените са отбелязани в базата). Почивките са неплатени и вече са приспаднати; ако няма отбелязана почивка при смяна над 6 ч, се приспадат 30 мин автоматично („авт.“). Смяна без край не се брои, докато не се поправи.</p></div></body></html>`;
}
async function hoursCsv(ym, now) {
  now = now || new Date();
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) ym = sofiaDateOf(now).slice(0, 7);
  const d = await monthData(ym, now);
  const q = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const head = ["Служител", "Обект", "Дата", "Начало", "Край", "Минути", "Часове", "Почивка (мин)", "Бележка"].map(q).join(",");
  return "﻿" + [head].concat(d.sess.map(s => [s.name, SITE_BG[s.site], s.date, s.start ? fmtT(s.start) : "", s.end ? fmtT(s.end) : "", Math.round(s.min), (s.min / 60).toFixed(2), Math.round(s.brk || 0), s.flag ? FLAG_BG[s.flag] : ""].map(q).join(","))).join("\n");
}

module.exports = { CFG, _i: { rpc, sessions, totals, staffAll, sofiaDateOf, sofiaToUtc, fmtT, fmtDM, hm, pad, monthRange, esc, SITE_BG, MAX_OPEN_H, stateOf, lastRow, clockToken, monthData }, SITES, geoCheck, distM, appState, appAct, appUndo, clockPage, clockTeamPage, clockManifest, clockOk, clockToken, stateOf, monthData, handleMessage, handleCallback, cronReport, hoursPage, hoursCsv, hoursKey, key, rpc, parseKind, parseTime, resolveAt, sofiaToUtc, sessions, totals, clockKb, MOCK, MAX_OPEN_H };
