// lib/task-heartbeat.js — пулс на планираните задачи (агент „Поща“ на 10 мин пише ред `poshta` в Supabase `task_heartbeat`).
// Вика се от GitHub Actions (.github/workflows/heartbeat.yml → /api/transfer?cron=heartbeat) — в облака, не от компютъра.
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

async function run(opts) {
  const o = opts || {}, now = Date.now(), nowIso = new Date(now).toISOString();
  const hb = await getRow("poshta");
  const st = await getRow("_alert");
  let state = {}; try { state = JSON.parse((st && st.note) || "{}"); } catch (e) { state = {}; }
  const out = { ok: true, last: hb && hb.at, hour: sofiaHour() };
  if (!hb) { out.note = "още няма пулс"; return out; }
  const ageMin = Math.round((now - new Date(hb.at).getTime()) / 60000);
  out.age_min = ageMin;
  const stale = ageMin > STALE_MIN;
  const h = out.hour, inWindow = h >= FROM_H && h < TO_H;
  if (stale) {
    out.stale = true;
    if (!inWindow) { out.skipped = "извън 07–23 ч"; return out; }
    const sentAgo = state.down_at ? (now - new Date(state.down_at).getTime()) / 60000 : null;
    const remind = state.down && state.last_sent && (now - new Date(state.last_sent).getTime()) / 60000 >= REMIND_MIN;
    if (!state.down || remind) {
      const text = "⚠️ <b>Планираните задачи не тръгват</b> — последно пускане в " + hm(hb.at) + " (преди " + ageMin + " мин).\n"
        + "Провери компютъра: включен ли е, не е ли заспал и отворено ли е приложението Claude.\n"
        + "Докато е така, няма да получаваш сутрешните и вечерните съобщения." + (remind ? "\n(напомняне)" : "");
      out.would_send = text;
      if (!o.dry) {
        await TG.tgSend(text, TG.OWNER_CHAT_ID, TG.sofiaDate()).catch(() => null);
        await putRow("_alert", nowIso, JSON.stringify({ down: true, down_at: state.down ? state.down_at : nowIso, last_sent: nowIso }));
        out.alerted = true;
      }
    } else out.note = "вече съобщено (" + Math.round(sentAgo || 0) + " мин)";
    return out;
  }
  if (state.down) {
    const text = "✅ Планираните задачи тръгнаха пак (последно пускане в " + hm(hb.at) + ").";
    out.would_send = text;
    if (!o.dry) {
      await TG.tgSend(text, TG.OWNER_CHAT_ID, TG.sofiaDate()).catch(() => null);
      await putRow("_alert", nowIso, JSON.stringify({ down: false, recovered_at: nowIso }));
      out.recovered = true;
    }
  }
  return out;
}

module.exports = { run };
