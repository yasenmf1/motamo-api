// api/cex-today.js — ЧЕТЯЩ екран за цеха („какво да готвим днес").
// Момичетата отварят линка → виждат производствения план за деня, изчислен от
// ДНЕШНИТЕ сметки на цеха (които собственикът оформя/коригира сутринта). Без
// въвеждане на токен, без редактиране; обновява се сам на всеки 3 минути.
//
// Линк: /api/cex-today?k=<токен>  (по избор &date=YYYY-MM-DD за друг ден)
// Токенът е в самия линк (момичетата го отварят веднъж/забодат го), за да не е
// напълно публичен — показва само производствени количества, не клиенти/цени.

const DATA = require("./_cexdata.js");
const ARTS = DATA.articles, NAME2ID = DATA.name2id;
const CEX_API = "https://motamo.barsy.online", CEX_BID = 1, TIMEOUT_MS = 9000;

const byId = id => ARTS[String(id)] || null;
const resolve = k => ARTS[String(k)] || (NAME2ID[k] != null ? ARTS[String(NAME2ID[k])] : null);

function withTimeout(run) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  return Promise.resolve(run(c.signal)).finally(() => clearTimeout(t));
}
function cexCall(action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${CEX_API}/endpoints/json/${action}?bid=${CEX_BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, data: d };
  });
}
async function seedOrder(date, user, pass) {
  const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 400 }, user, pass);
  const accts = (list.data || []).filter(a => String(a.create_date || "").startsWith(date));
  const order = {};
  for (const a of accts) {
    const rows = await cexCall("Orders_getlist", { filters: { account_id: a.account_id } }, user, pass);
    for (const o of (rows.data || [])) {
      const art = byId(o.article_id) || resolve(o.article_name);
      if (art && art.is_menu) order[art.name] = (order[art.name] || 0) + (Number(o.amount) || 0);
    }
  }
  return { order, shops: accts.length };
}
function explodeToRolls(order) {
  const rolls = {};
  const add = (name, qty) => {
    const art = resolve(name);
    if (!art) { rolls[name] = (rolls[name] || 0) + qty; return; }
    if (art.is_set) { for (const c of art.components) { const cart = c.id != null ? byId(c.id) : resolve(c.name); if (cart && cart.is_menu) add(cart.name, qty * c.qty); } }
    else rolls[art.name] = (rolls[art.name] || 0) + qty;
  };
  for (const [k, v] of Object.entries(order)) add(k, Number(v) || 0);
  return rolls;
}
function rollsToZag(rolls) {
  const zag = {};
  const walk = (name, qty) => {
    const art = resolve(name); if (!art) return;
    for (const c of art.components) { const cart = c.id != null ? byId(c.id) : resolve(c.name); if (cart && cart.cat === "Заготовки") { zag[cart.name] = (zag[cart.name] || 0) + qty * c.qty; walk(cart.name, qty * c.qty); } }
  };
  for (const [k, v] of Object.entries(rolls)) walk(k, Number(v) || 0);
  return zag;
}
const round = (n) => Math.round(n * 1000) / 1000;
function sofiaToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());
}
function sofiaTime() {
  return new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit" }).format(new Date());
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const k = q.k;
  const okTokens = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET];
  const page = (inner) => `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="180">
<title>Цех · днес за производство</title><style>
:root{color-scheme:light}*{box-sizing:border-box}
body{font:16px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#fff;color:#111}
header{background:#b3121b;color:#fff;padding:14px 18px}
header h1{margin:0;font-size:22px}header .d{font-size:15px;opacity:.9;margin-top:2px}
.wrap{padding:16px;max-width:900px;margin:0 auto}
h2{font-size:20px;margin:20px 0 8px;border-bottom:3px solid #b3121b;padding-bottom:4px}
table{border-collapse:collapse;width:100%}
td{padding:10px 12px;border-bottom:1px solid #eee;font-size:20px}
td.q{text-align:right;font-weight:800;font-size:24px;color:#b3121b;white-space:nowrap}
.big td{font-size:22px}.note{color:#666;font-size:13px;margin-top:18px}
</style></head><body>${inner}</body></html>`;

  if (!okTokens.some(t => t && k === t)) {
    res.status(403).send(page(`<div class="wrap"><h2>Няма достъп</h2><p>Липсва или грешен ключ в линка.</p></div>`));
    return;
  }
  const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
  if (!user || !pass) { res.status(500).send(page(`<div class="wrap">Не е конфигуриран достъп до цеха.</div>`)); return; }

  const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : sofiaToday();
  let order, shops;
  try { const s = await seedOrder(date, user, pass); order = s.order; shops = s.shops; }
  catch (e) { res.status(200).send(page(`<div class="wrap"><h2>Грешка</h2><p>Не мога да прочета сметките сега. Опитай пак след минута.</p></div>`)); return; }

  const rolls = explodeToRolls(order);
  const zag = rollsToZag(rolls);
  const tbl = (obj) => Object.keys(obj).sort().map(kk => `<tr><td>${esc(kk)}</td><td class="q">${round(obj[kk])}</td></tr>`).join("") || `<tr><td colspan="2" style="color:#999">няма</td></tr>`;
  const empty = !Object.keys(rolls).length;

  res.status(200).send(page(`
  <header><h1>Цех · за производство днес</h1>
    <div class="d">${esc(date)} · ${shops} магазина · обновено ${esc(sofiaTime())}</div></header>
  <div class="wrap">
    ${empty ? `<h2>Още няма заявки за днес</h2><p>Когато влязат сметките, тук ще се появи какво да се произведе. Страницата се обновява сама.</p>` : `
    <h2>Роли / поке</h2><table class="big">${tbl(rolls)}</table>
    <h2>Заготовки</h2><table>${tbl(zag)}</table>`}
    <div class="note">Обновява се автоматично на всеки 3 минути. Числата са общо за всички магазини.</div>
  </div>`));
};
