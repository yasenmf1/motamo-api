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

async function tgSend(text, chatId) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return { ok: false, error: "no_bot_token" };
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId || CEX_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const j = await r.json().catch(() => ({}));
  return j.ok ? { ok: true } : { ok: false, error: String(j.description || r.status) };
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

module.exports = { CEX_CHAT_ID, OWNER_CHAT_ID, tgSend, sentGet, sentSave, escHtml };
