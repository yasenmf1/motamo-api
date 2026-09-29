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
const plusDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// keepUntil (YYYY-MM-DD) → съобщението се записва и в полунощ след този ден ботът го трие
// (tgCleanup, Vercel cron). Без keepUntil — остава.
// markup (по избор) = reply_markup, напр. { inline_keyboard: [[{ text, url }]] }.
async function tgSend(text, chatId, keepUntil, markup) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return { ok: false, error: "no_bot_token" };
  const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId || CEX_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) })
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

// ── Ключове по роли (изведени, без нови env променливи) ─────────────────────────
// Всеки отваря САМО своя екран: склад на цеха (заявките от точката + производство на
// заготовка), точката (формата за заявка). Изведени от PEEK_TOKEN; webhook тайната — от
// токена на бота (Telegram я праща в X-Telegram-Bot-Api-Secret-Token).
const hkey = (salt, base) => base ? require("crypto").createHash("sha256").update(salt + base).digest("hex").slice(0, 24) : null;
const skladKey = () => hkey("motamo-sklad:", process.env.PEEK_TOKEN);
const pointKey = () => hkey("motamo-point:", process.env.PEEK_TOKEN);
const hookSecret = () => hkey("motamo-tg-hook:", process.env.TELEGRAM_BOT_TOKEN);

async function tgApi(method, body) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  if (!tok) return { ok: false, description: "no_bot_token" };
  const r = await fetch(`https://api.telegram.org/bot${tok}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  return r.json().catch(() => ({ ok: false }));
}

// ── Хората и ролите (Supabase `cex_tg_users`): tochka | sklad | owner | none; null = чака ──
async function userGet(id) {
  const r = await fetch(`${SB_URL}/rest/v1/cex_tg_users?user_id=eq.${Number(id)}&limit=1`, { headers: sbH });
  const d = r.ok ? await r.json() : []; return (d && d[0]) || null;
}
async function userUpsert(row) {
  await fetch(`${SB_URL}/rest/v1/cex_tg_users?on_conflict=user_id`, { method: "POST", headers: { ...sbH, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ...row, updated_at: new Date().toISOString() }]) });
}
async function usersByRole(role) {
  const r = await fetch(`${SB_URL}/rest/v1/cex_tg_users?role=eq.${encodeURIComponent(role)}&select=user_id,name`, { headers: sbH });
  return r.ok ? await r.json() : [];
}
async function sendToRole(role, text, keepUntil, markup) {
  const us = await usersByRole(role).catch(() => []);
  let n = 0; for (const u of us) { const x = await tgSend(text, String(u.user_id), keepUntil, markup).catch(() => ({})); if (x.ok) n++; }
  return n;
}

module.exports = { CEX_CHAT_ID, OWNER_CHAT_ID, tgSend, tgApi, tgCleanup, sentGet, sentSave, escHtml, sofiaDate, plusDays,
  skladKey, pointKey, hookSecret, userGet, userUpsert, usersByRole, sendToRole };
