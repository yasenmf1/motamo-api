// Telegram бот @MOTAMO_BOT (S25) — изпраща в групата на цеха „МОТАМО" и помни
// какво е пратено (Supabase `cex_tg_sent`, ключ kind+for_date), за да праща само
// разликата при допълнение и да не повтаря сигнал в един ден.
// Токенът е във Vercel env TELEGRAM_BOT_TOKEN (и локално в motamo-tokens.env).
const CEX_CHAT_ID = "-1004324575712";     // група „МОТАМО" (supergroup)
const OWNER_CHAT_ID = "1153763325";       // личният чат на собственика с бота

const SB_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0emd4cmVvamZ2ZGx0YmF2bG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjIxNzksImV4cCI6MjEwMTgzODE3OX0.o4i60i2Q9eCEhEOjw8OLmNqAkXVXpnqYYvx9_9BrkPs";
const sbH = { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" };

const escHtml = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// Дата в София (YYYY-MM-DD), вярно и през зимното време.
const sofiaDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(d || new Date());

// keepUntil (YYYY-MM-DD) → съобщението се записва и в полунощ след този ден ботът го трие
// (tgCleanup, Vercel cron). Без keepUntil — остава.
async function tgSend(text, chatId, keepUntil) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return { ok: false, error: "no_bot_token" };
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId || CEX_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const j = await r.json().catch(() => ({}));
  if (j.ok && keepUntil && j.result && j.result.message_id) {
    await fetch(`${SB_URL}/rest/v1/cex_tg_msgs`, { method: "POST", headers: { ...sbH, Prefer: "return=minimal" },
      body: JSON.stringify([{ chat_id: String(chatId || CEX_CHAT_ID), message_id: j.result.message_id, keep_until: keepUntil }]) }).catch(() => {});
  }
  return j.ok ? { ok: true, message_id: j.result && j.result.message_id } : { ok: false, error: String(j.description || r.status) };
}

// Трие съобщенията на бота, чийто ден е минал (keep_until < днес в София).
async function tgCleanup() {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return { ok: false, error: "no_bot_token" };
  const today = sofiaDate();
  const r = await fetch(`${SB_URL}/rest/v1/cex_tg_msgs?deleted=eq.false&keep_until=lt.${today}&select=chat_id,message_id&limit=200`, { headers: sbH });
  const rows = r.ok ? await r.json() : [];
  let deleted = 0, failed = 0;
  for (const m of rows) {
    const d = await fetch(`https://api.telegram.org/bot${tok}/deleteMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: m.chat_id, message_id: m.message_id }) }).then(x => x.json()).catch(() => ({}));
    if (d.ok) deleted++; else failed++;
    // маркираме и неуспешните (напр. вече изтрити ръчно или >48 ч) — да не се опитваме вечно
    await fetch(`${SB_URL}/rest/v1/cex_tg_msgs?chat_id=eq.${encodeURIComponent(m.chat_id)}&message_id=eq.${m.message_id}`, {
      method: "PATCH", headers: { ...sbH, Prefer: "return=minimal" }, body: JSON.stringify({ deleted: true }) }).catch(() => {});
  }
  return { ok: true, today, found: rows.length, deleted, failed };
}

async function sentGet(kind, forDate) {
  const r = await fetch(`${SB_URL}/rest/v1/cex_tg_sent?kind=eq.${encodeURIComponent(kind)}&for_date=eq.${forDate}&limit=1`, { headers: sbH });
  const d = r.ok ? await r.json() : [];
  return (d && d[0]) || null;
}
async function sentSave(kind, forDate, payload) {
  await fetch(`${SB_URL}/rest/v1/cex_tg_sent?on_conflict=kind,for_date`, {
    method: "POST", headers: { ...sbH, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ kind, for_date: forDate, payload, sent_at: new Date().toISOString() }])
  });
}

module.exports = { CEX_CHAT_ID, OWNER_CHAT_ID, tgSend, tgCleanup, sentGet, sentSave, escHtml, sofiaDate };
