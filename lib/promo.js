// Промо код за служителите на ИТТ (−30 %). Кодът се сменя САМ всеки месец: HMAC върху месеца (по Europe/Sofia),
// с тайна от PEEK_TOKEN — няма какво да се пази или деплойва; на собственика го казвам/пращам в началото на месеца.
// Старият код важи до 5-о число (да не изненадаме служител, получил кода преди края на месеца).
const crypto = require("crypto");
const PCT = 30;
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // без O/0/I/1 — да не се бърка при писане

function sofiaParts(d) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d || new Date());
  const g = (t) => Number(f.find(p => p.type === t).value);
  return { y: g("year"), m: g("month"), d: g("day") };
}
function ym(y, m) { return y + "-" + (m < 10 ? "0" : "") + m; }
function codeFor(key) {
  const secret = process.env.PEEK_TOKEN || "";
  if (!secret) return "";
  const h = crypto.createHmac("sha256", secret).update("motamo-itt-promo:" + key).digest();
  let s = ""; for (let i = 0; i < 4; i++) s += ALPHA[h[i] % ALPHA.length];
  return "ITT" + s;
}
// Кодове с изрична дата на валидност (напр. отпечатан на флаер): важат до края на посочения ден (Europe/Sofia).
const FIXED = [{ code: "ITTN6HG", until: "2026-11-30" }];
function validCodes(now) {
  const p = sofiaParts(now);
  const out = [codeFor(ym(p.y, p.m))];
  if (p.d <= 5) { const py = p.m === 1 ? p.y - 1 : p.y, pm = p.m === 1 ? 12 : p.m - 1; out.push(codeFor(ym(py, pm))); }
  const today = ym(p.y, p.m) + "-" + (p.d < 10 ? "0" : "") + p.d;
  FIXED.forEach(f => { if (today <= f.until) out.push(f.code); });
  return out.filter(Boolean);
}
const norm = (c) => String(c == null ? "" : c).toUpperCase().replace(/[^A-Z0-9]/g, "");
// процент отстъпка за въведения код (0 = невалиден)
function pctFor(code, now) {
  const c = norm(code);
  if (c.length < 5) return 0;
  return validCodes(now).some(v => v === c) ? PCT : 0;
}
module.exports = { pctFor, codeFor, validCodes, PCT, sofiaParts, ym };
