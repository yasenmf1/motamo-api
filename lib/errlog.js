// ★ 19.11 — записва грешка в Supabase `api_errors` (функция log_api_error, пази 30 дни), за да се виждат и след 1 час
// (Vercel Hobby пази логовете само ~1 час). Никога не хвърля и не бави (макс. 3 с).
const TG = require("./telegram.js");
async function logError(src, msg, ctx) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 3000);
    await fetch(`${TG.SB_URL}/rest/v1/rpc/log_api_error`, { method: "POST", headers: TG.sbH, signal: c.signal,
      body: JSON.stringify({ p_src: String(src || "?"), p_msg: String(msg || "?"), p_ctx: ctx == null ? null : ctx }) }).catch(() => {});
    clearTimeout(t);
  } catch (e) { /* не пречи на работата */ }
}
module.exports = { logError };
