// lib/task-heartbeat.js — пулс на планираните задачи (агент „Поща“ на 10 мин пише ред `poshta` в Supabase `task_heartbeat`).
// (виж CHECKS отдолу) Вика се от GitHub Actions (.github/workflows/heartbeat.yml → /api/transfer?cron=heartbeat) — в облака, не от компютъра.
// Ако пулсът е по-стар от 35 мин в 07–23 ч (София) → ЕДНО съобщение в Telegram; напомняне на 3 ч, докато е така;
// след връщане → ЕДНО „✅ тръгнаха пак“. Състоянието на известията е ред `_alert` в същата таблица. Нищо друго не пише.
const TG = require("./telegram.js");

const STALE_MIN = 35, REMIND_MIN = 180, FROM_H = 7, TO_H = 23;
const sofiaHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(new Date()));
const hm = iso => new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

async function sb(path, opts) {
  const r = await fetch(`${TG.SB_URL}/rest/v1/${path}`, { ...(opts || {}), headers: { ...TG.sbH, ...((opts && opts.headers) || {}) }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("sb " + r.status);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}
async function getRow(name) { const r = await sb(`task_heartbeat?select=name,at,note&name=eq.${encodeURIComponent(name)}&limit=1`); return r && r[0] || null; }
async function putRow(name, at, note) {
  await sb("task_heartbeat?on_conflict=name", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ name, at, note: note || null }]) });
}

// Какво следим: пулс `cloud` (пише го всяко пускане на tasks.yml, на 10 мин; GitHub закъснява → праг 30 мин — верига)
// и `poshta` (агентът Поща на компютъра, на 10 мин → праг 35 мин). Всеки има собствено състояние на известията `_alert_<име>`.
const CHECKS = [
  { name: "cloud", stale: 30, title: "Облачните задачи (GitHub) не тръгват", tip: "Провери GitHub → Actions → tasks (дали е спрян). Докато е така, няма да получаваш оборот, поръчки и цех." },
  // `poshta` (агентът Поща на компютъра) е изключен от следене (04.11, по искане на собственика) — компютърът не е винаги включен, всичко важно върви от облака.
];

async function checkOne(c, o, now, nowIso) {
  const hb = await getRow(c.name);
  const st = await getRow("_alert_" + c.name);
  let state = {}; try { state = JSON.parse((st && st.note) || "{}"); } catch (e) { state = {}; }
  const out = { name: c.name, last: hb && hb.at };
  if (!hb) { out.note = "още няма пулс"; return out; }
  const ageMin = Math.round((now - new Date(hb.at).getTime()) / 60000);
  out.age_min = ageMin;
  // 04.11: облачната верига не е тръгвала повече от 15 мин и има ключ за пускане → рестарт (workflow_dispatch), и през нощта
  if (c.name === "cloud" && (ageMin > 15 || o.restart) && !o.dry && process.env.GH_DISPATCH_TOKEN) {
    try {
      const r = await fetch("https://api.github.com/repos/yasenmf1/motamo-api/actions/workflows/tasks.yml/dispatches", { method: "POST", headers: { authorization: "Bearer " + process.env.GH_DISPATCH_TOKEN, accept: "application/vnd.github+json", "user-agent": "motamo-heartbeat" }, body: JSON.stringify({ ref: "main" }), signal: AbortSignal.timeout(15000) });
      out.restart = r.status;
      if (r.status >= 300) { try { out.restart_msg = (await r.text()).replace(/\s+/g, " ").slice(0, 200) + " | " + (r.headers.get("x-accepted-github-permissions") || r.headers.get("x-oauth-scopes") || ""); } catch (e) { out.restart_msg = "няма тяло"; } }
    } catch (e) { out.restart = "грешка"; }
  }
  const stale = ageMin > c.stale;
  const h = sofiaHour(), inWindow = h >= FROM_H && h < TO_H;
  if (stale) {
    out.stale = true;
    if (!inWindow) { out.skipped = "извън 07–23 ч"; return out; }
    const remind = state.down && state.last_sent && (now - new Date(state.last_sent).getTime()) / 60000 >= REMIND_MIN;
    if (!state.down || remind) {
      const text = "⚠️ <b>" + c.title + "</b> — последно пускане в " + hm(hb.at) + " (преди " + ageMin + " мин).\n" + c.tip + (remind ? "\n(напомняне)" : "");
      out.would_send = text;
      if (!o.dry) {
        await TG.tgSend(text, TG.OWNER_CHAT_ID, TG.sofiaDate()).catch(() => null);
        await putRow("_alert_" + c.name, nowIso, JSON.stringify({ down: true, down_at: state.down ? state.down_at : nowIso, last_sent: nowIso }));
        out.alerted = true;
      }
    } else out.note = "вече съобщено";
    return out;
  }
  if (state.down) {
    const text = "✅ " + c.title.replace(" не тръгват", " тръгнаха пак") + " (последно пускане в " + hm(hb.at) + ").";
    out.would_send = text;
    if (!o.dry) {
      await TG.tgSend(text, TG.OWNER_CHAT_ID, TG.sofiaDate()).catch(() => null);
      await putRow("_alert_" + c.name, nowIso, JSON.stringify({ down: false, recovered_at: nowIso }));
      out.recovered = true;
    }
  }
  return out;
}

async function run(opts) {
  const o = opts || {}, now = Date.now(), nowIso = new Date(now).toISOString();
  const res = [];
  for (const c of CHECKS) { try { res.push(await checkOne(c, o, now, nowIso)); } catch (e) { res.push({ name: c.name, error: String(e && e.message || e).slice(0, 100) }); } }
  return { ok: true, hour: sofiaHour(), checks: res };
}

module.exports = { run };
