// api/competitors.js — данни за таблото „Конкуренти“ (страница: motamo.bg/konkurenti/).
// GET ?k=<ключ>  → JSON от таблицата dashboard_data (id=1) в Supabase проекта на motamo-watch.
// Ключът не е в кода — пази се само отпечатъкът му (SHA-256). Supabase ключът е „publishable“
// (публичен по замисъл); RLS позволява четене само на dashboard_data id=1.

const crypto = require("crypto");

const TOKEN_SHA256 = "2df716d020f1247aa3fa3872e0a8e9bcdfcc6c6c4c7c1e3d784620fd7e5714b9"; // secret-scan:ok (отпечатък, не ключ)
const SUPABASE_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SUPABASE_PUBLISHABLE = "sb_publishable_E60WKWGhomxmvX6w43hUog_uAveMfMz";
const ALLOWED = ["https://motamo.bg", "https://www.motamo.bg"];

function tokenOk(k) {
  if (typeof k !== "string" || k.length < 20 || k.length > 200) return false;
  const h = crypto.createHash("sha256").update(k).digest();
  const want = Buffer.from(TOKEN_SHA256, "hex");
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}

module.exports = async function handler(req, res) {
  const o = String((req.headers && req.headers.origin) || "");
  res.setHeader("Access-Control-Allow-Origin", ALLOWED.includes(o) ? o : ALLOWED[0]);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  if (!tokenOk(q.k)) { res.status(403).json({ error: "Няма достъп — липсва или грешен ключ." }); return; }
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_data?id=eq.1&select=built_at,data`, {
      headers: { apikey: SUPABASE_PUBLISHABLE, Authorization: `Bearer ${SUPABASE_PUBLISHABLE}` },
    });
    if (!r.ok) { res.status(502).json({ error: "Базата не отговори (" + r.status + ")." }); return; }
    const rows = await r.json();
    if (!rows.length) { res.status(404).json({ error: "Още няма данни за таблото." }); return; }
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).json(rows[0].data);
  } catch (e) {
    res.status(502).json({ error: "Грешка при четене: " + String(e && e.message || e) });
  }
};
