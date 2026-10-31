// lib/barsy-watch.js — на час проверява дали Barsy отговаря (публичният хост и резервният вход) и пише в Telegram САМО при проблем.
// Вика се от GitHub Actions (.github/workflows/barsywatch.yml → /api/transfer?cron=barsywatch), не от Vercel cron (там е най-много 1×/ден).
// Само четене: Categories_getalltree. Нищо не се записва в Barsy.
const TG = require("./telegram.js");
const T = require("./barsy-tree.js");

const sofiaHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(new Date()));

async function timed(fn) {
  const t0 = Date.now();
  try { const tree = await fn(); return { ok: true, ms: Date.now() - t0, articles: (tree.articles || []).length }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e && e.message).slice(0, 120) }; }
}

async function run(opts) {
  const o = opts || {};
  const pub = await timed(() => T.post(T.PUBLIC.point));
  const auth = await timed(async () => (await T.fetchTree("point", { skipPublic: true })).tree);
  const out = { ok: pub.ok && auth.ok, public: pub, auth: auth, hour: sofiaHour() };
  if (out.ok && !o.force) return out;
  const h = out.hour;
  if (!o.force && (h < 8 || h > 21)) { out.skipped = "извън работно време"; return out; } // нощем не будим
  let text;
  if (!pub.ok && !auth.ok) text = "🚨 <b>Barsy не отговаря</b> (и двата входа). Клиентите НЕ могат да поръчват от сайта.\n" + TG.escHtml(pub.error || "") + " / " + TG.escHtml(auth.error || "");
  else if (!pub.ok) text = "⚠️ Публичният хост на Barsy не отговаря. Сайтът работи през резервния вход (менюто може да е без описания).\n" + TG.escHtml(pub.error || "");
  else text = "⚠️ Резервният вход към Barsy не работи (публичният е наред). Ако публичният падне, поръчките ще спрат.\n" + TG.escHtml(auth.error || "");
  if (o.force) text = "🧪 Проба: " + text;
  const r = await TG.tgSend(text, TG.OWNER_CHAT_ID, TG.sofiaDate()).catch(() => ({}));
  out.alerted = !!r;
  return out;
}

module.exports = { run };
