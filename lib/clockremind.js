// lib/clockremind.js — пуш напомняния за часовника + абонаменти. Праща се само към лични абонаменти (time_push).
//  • начало: 10 мин след началото по график, ако човекът още не е отбелязал „Започнах“;
//  • край: 15 мин след края по график, ако още е „на работа“;
//  • към собственика (Telegram): 30 мин след началото — кой още не е отбелязан.
// Графикът е в таблица time_sched (дни ISO 1=Пн…7=Нд, начало/край „ЧЧ:ММ“, София). Без график — не праща нищо.
// Вика се от GitHub Actions на всеки 10 мин: motamo-api `?cron=clock_remind` (api/transfer.js).
const TC = require("./timeclock.js");
const TG = require("./telegram.js");
const PUSH = require("./push.js");
const I = TC._i;

let SENDER = null;                       // за тестове
const setSender = (f) => { SENDER = f; };
async function sendPush(sub, payload) {
  if (SENDER) return SENDER(sub, payload);
  const webpush = require("web-push"); const v = PUSH.vapid();
  webpush.setVapidDetails("mailto:office@motamo.bg", v.pub, v.priv);
  return webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
}

async function appPush(uid, sub) {
  const s = sub || {}, k = s.keys || {};
  if (!/^https:\/\//.test(String(s.endpoint || "")) || String(s.endpoint).length > 700 || !k.p256dh || !k.auth) return { ok: false, error: "bad_sub" };
  await I.rpc("tc_push_set", { p_user: Number(uid), p_endpoint: s.endpoint, p_p256dh: String(k.p256dh).slice(0, 200), p_auth: String(k.auth).slice(0, 100) });
  return { ok: true };
}

const isoDow = (dateStr) => { const d = new Date(dateStr + "T12:00:00Z").getUTCDay(); return d === 0 ? 7 : d; };
const hhmm = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function sofiaMin(now) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false }).format(now).split(":");
  return (Number(p[0]) % 24) * 60 + Number(p[1]);
}
const linkOf = (uid) => `/api/transfer?view=clock&u=${uid}&t=${I.clockToken(uid)}`;

async function notify(uid, subs, payload, out) {
  for (const s of subs.filter(x => Number(x.user_id) === Number(uid))) {
    try { await sendPush(s, payload); out.sent++; }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) { out.dropped++; await I.rpc("tc_push_del", { p_endpoint: s.endpoint }).catch(() => {}); } else out.failed++; }
  }
}

async function cronRemind(now) {
  now = now || new Date();
  const sched = await I.rpc("tc_sched_list") || [];
  if (!sched.length) return { ok: true, skipped: "no_schedule" };
  const today = I.sofiaDateOf(now), dow = isoDow(today), nowMin = sofiaMin(now);
  const staff = ((await I.staffAll()) || []).filter(s => s.active);
  const subs = await I.rpc("tc_push_list") || [];
  const open = await I.rpc("tc_open") || [];
  const rows = await I.rpc("tc_rows", { p_from: today, p_to: today }) || [];
  const hasIn = new Set(rows.filter(r => r.kind === "in").map(r => Number(r.user_id)));
  const working = new Set(open.filter(r => I.stateOf(r, now) !== "off").map(r => Number(r.user_id)));
  const out = { ok: true, sent: 0, dropped: 0, failed: 0, start: 0, end: 0, owner: 0 };
  const lateNames = [];
  for (const sc of sched) {
    const uid = Number(sc.user_id), st = staff.find(x => Number(x.user_id) === uid);
    if (!st || !(sc.days || []).includes(dow)) continue;
    const a = hhmm(sc.start_t), b = hhmm(sc.end_t); if (a == null || b == null || b <= a) continue;
    const done = async (kind) => !!(await TG.sentGet(kind, today).catch(() => null));
    const mark = (kind, o) => TG.sentSave(kind, today, o || { u: uid }).catch(() => {});
    if (!hasIn.has(uid) && !working.has(uid) && nowMin >= a + 10 && nowMin < b) {
      const k1 = "tc_rm_start_" + uid;
      if (!(await done(k1))) {
        await notify(uid, subs, { title: "MOTAMO · Часове", body: "Не си отбелязал(а), че си започнал(а) работа. Натисни „Започнах“.", tag: "clock-start", url: linkOf(uid) }, out);
        await mark(k1); out.start++;
      }
      if (nowMin >= a + 30 && !(await done("tc_rm_owner_" + uid))) { lateNames.push({ uid, name: st.name, from: sc.start_t }); }
    }
    if (working.has(uid) && nowMin >= b + 15) {
      const k2 = "tc_rm_end_" + uid;
      if (!(await done(k2))) {
        await notify(uid, subs, { title: "MOTAMO · Часове", body: "Смяната ти по график свърши. Ако си приключил(а), натисни „Приключих“.", tag: "clock-end", url: linkOf(uid) }, out);
        await mark(k2); out.end++;
      }
    }
  }
  if (lateNames.length) {
    await TG.tgSend("⏰ <b>Още не са отбелязали начало:</b>\n" + lateNames.map(x => `• ${TG.escHtml(x.name)} (по график от ${x.from})`).join("\n"), TG.OWNER_CHAT_ID).catch(() => {});
    for (const x of lateNames) await TG.sentSave("tc_rm_owner_" + x.uid, today, { u: x.uid }).catch(() => {});
    out.owner = lateNames.length;
  }
  return out;
}

module.exports = { appPush, cronRemind, setSender, isoDow, sofiaMin };
