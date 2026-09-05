// api/cex-plan.js — Цех Фаза 1: производствен калкулатор (ЕДНА функция, 3 режима).
// Обединено, за да се спази лимитът от 12 serverless функции на Vercel Hobby.
//
//   GET  /api/cex-plan?view=tool                 → страница за собственика (въвежда/коригира)
//   GET  /api/cex-plan?view=today&k=<токен>      → ЧЕТЯЩ екран за цеха („какво да готвим днес")
//   POST /api/cex-plan  (JSON, токен)            → изчисление: {shops|orders|seed_date} → план
//
// Разбива заявката (меню, вкл. сетове) до РОЛИ/ПОКЕ и ЗАГОТОВКИ за производство.
// Суровините Barsy ги тегли сам при производство. Рецептата е от _cexdata.js
// (генериран от експорта). Само ЧЕТЕ Barsy (сметки/поръчки на цеха). Гейт за JSON:
// RECONCILE_TOKEN / PAY_HMAC_SECRET / PREVIEW_TOKEN. За view=today и CEX_VIEW_TOKEN.

const DATA = require("./_cexdata.js");
const ARTS = DATA.articles, NAME2ID = DATA.name2id;
const MENU = Object.values(ARTS).filter(a => a.is_menu)
  .sort((a, b) => (a.is_set - b.is_set) || (a.id - b.id))
  .map(a => ({ id: a.id, name: a.name, is_set: !!a.is_set }));

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
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
async function seedShops(date, user, pass) {
  const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 400 }, user, pass);
  const accts = (list.data || []).filter(a => String(a.create_date || "").startsWith(date));
  // Паралелно по сметка — иначе ~13 последователни заявки надхвърлят лимита на функцията.
  const shops = await Promise.all(accts.map(async (a) => {
    const rows = await cexCall("Orders_getlist", { filters: { account_id: a.account_id } }, user, pass);
    const order = {};
    for (const o of (rows.data || [])) {
      const art = byId(o.article_id) || resolve(o.article_name);
      if (art && art.is_menu) order[art.name] = (order[art.name] || 0) + (Number(o.amount) || 0);
    }
    return { account_id: a.account_id, client: a.client_name || null, rep: a.person_name || null, order };
  }));
  return { shops, accounts: accts.length };
}
function explodeToRolls(order) {
  const rolls = {};
  const add = (name, qty) => {
    const art = resolve(name);
    if (!art) { rolls[name] = (rolls[name] || 0) + qty; return; }
    if (art.is_set) { for (const c of art.components) { const cart = c.id != null ? byId(c.id) : resolve(c.name); if (cart && cart.is_menu) add(cart.name, qty * c.qty); } }
    else rolls[art.name] = (rolls[art.name] || 0) + qty;
  };
  for (const [k, v] of Object.entries(order || {})) add(k, Number(v) || 0);
  return rolls;
}
function rollsToZag(rolls) {
  const zag = {};
  const walk = (name, qty) => {
    const art = resolve(name); if (!art) return;
    for (const c of art.components) { const cart = c.id != null ? byId(c.id) : resolve(c.name); if (cart && cart.cat === "Заготовки") { zag[cart.name] = (zag[cart.name] || 0) + qty * c.qty; walk(cart.name, qty * c.qty); } }
  };
  for (const [k, v] of Object.entries(rolls || {})) walk(k, Number(v) || 0);
  return zag;
}
const round = n => Math.round(n * 1000) / 1000;
function sortObj(o, d) { const out = {}; Object.keys(o || {}).sort().forEach(k => out[k] = Math.round(o[k] * 10 ** d) / 10 ** d); return out; }
const sofiaToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());
const sofiaTime = () => new Intl.DateTimeFormat("bg-BG", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit" }).format(new Date());
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function compute(shops) {
  const agg = {};
  for (const s of shops) for (const [k, v] of Object.entries(s.order || {})) agg[k] = (agg[k] || 0) + (Number(v) || 0);
  return { agg, rolls: explodeToRolls(agg), zag: rollsToZag(explodeToRolls(agg)) };
}

// ── HTML: екран за цеха (само четене) ────────────────────────────────────────
function todayPage(inner) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="180">
<title>Цех · днес за производство</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:16px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#fff;color:#111}
header{background:#b3121b;color:#fff;padding:14px 18px}header h1{margin:0;font-size:22px}header .d{font-size:15px;opacity:.9;margin-top:2px}
.wrap{padding:16px;max-width:900px;margin:0 auto}h2{font-size:20px;margin:20px 0 8px;border-bottom:3px solid #b3121b;padding-bottom:4px}
table{border-collapse:collapse;width:100%}td{padding:10px 12px;border-bottom:1px solid #eee;font-size:20px}
td.q{text-align:right;font-weight:800;font-size:24px;color:#b3121b;white-space:nowrap}.note{color:#666;font-size:13px;margin-top:18px}
</style></head><body>${inner}</body></html>`;
}

// ── HTML: страница за собственика (въвеждане/коригиране) ──────────────────────
function toolPage() {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOTAMO цех — производствен калкулатор</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:14px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f5f7;color:#1a1a1a}
header{background:#b3121b;color:#fff;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:5}
header h1{font-size:16px;margin:0 12px 0 0}header input{font:13px system-ui;padding:5px 7px;border:0;border-radius:5px}
button{font:13px system-ui;padding:6px 12px;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}button.alt{background:#fff;color:#111;border:1px solid #ccc}
.wrap{padding:14px;max-width:1400px;margin:0 auto}.msg{padding:8px 12px;border-radius:6px;margin:8px 0;display:none}.msg.err{background:#fde8e8;color:#9b1c1c;display:block}.msg.ok{background:#e8f5e9;color:#1b5e20;display:block}
table{border-collapse:collapse;background:#fff;width:100%;margin:6px 0}th,td{border:1px solid #e2e4e8;padding:4px 6px;text-align:center;font-size:13px}th{background:#f0f1f3;position:sticky;top:52px}
th.shop,td.shop{text-align:left;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}td input{width:52px;text-align:center;border:1px solid #d0d3d8;border-radius:4px;padding:3px}.set{background:#fff7e6}
h2{font-size:15px;margin:18px 0 4px}.plan{display:flex;gap:24px;flex-wrap:wrap}.plan table{width:auto;min-width:280px}.plan td.q{font-weight:700;color:#b3121b}.scroll{overflow-x:auto}
@media print{header,.noprint{display:none}.wrap{padding:0}}
</style></head><body>
<header><h1>MOTAMO цех · производство</h1>
<input id="tok" type="password" placeholder="токен" size="20"><input id="date" type="date">
<button onclick="seed()">Зареди от дата</button><button class="alt" onclick="calc()">Изчисли план</button><button class="alt" onclick="window.print()">Печат</button></header>
<div class="wrap"><div id="msg" class="msg"></div><div class="scroll"><table id="grid"></table></div><div id="planbox"></div></div>
<script>
var MENU=${JSON.stringify(MENU)};var shops=[];var $=function(id){return document.getElementById(id)};
try{$('tok').value=localStorage.getItem('cex_tok')||''}catch(e){}
$('tok').addEventListener('change',function(){try{localStorage.setItem('cex_tok',$('tok').value)}catch(e){}});
(function(){$('date').value=new Date().toISOString().slice(0,10)})();
function msg(t,k){var m=$('msg');m.textContent=t;m.className='msg '+(k||'')}
function api(p){return fetch('/api/cex-plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:$('tok').value},p))}).then(function(r){return r.json()})}
function seed(){msg('Зареждам…');api({seed_date:$('date').value}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||'')+' '+(j.hint||''),'err');return}shops=j.shops||[];renderGrid();renderPlan(j);if(j.note){msg(j.note,'err')}else{msg('Заредени '+(j.seeded_accounts||0)+' сметки. Коригирай и „Изчисли план".','ok')}}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function renderGrid(){var h='<tr><th class="shop">Магазин</th>';MENU.forEach(function(m){h+='<th class="'+(m.is_set?'set':'')+'">'+m.name.replace('НACHI','')+'</th>'});h+='</tr>';
shops.forEach(function(s,i){var label=(s.client||'')+(s.rep?(' · '+s.rep):'');h+='<tr><td class="shop" title="'+esc(label)+'">'+esc(label)+'</td>';
MENU.forEach(function(m){var v=(s.order&&s.order[m.name])||0;h+='<td class="'+(m.is_set?'set':'')+'"><input data-i="'+i+'" data-n="'+esc(m.name)+'" value="'+v+'" inputmode="numeric"></td>'});h+='</tr>'});$('grid').innerHTML=h}
function collect(){document.querySelectorAll('#grid input').forEach(function(inp){var i=+inp.getAttribute('data-i'),n=inp.getAttribute('data-n'),v=parseFloat(inp.value)||0;if(!shops[i].order)shops[i].order={};if(v)shops[i].order[n]=v;else delete shops[i].order[n]})}
function calc(){collect();msg('Смятам…');api({shops:shops}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}renderPlan(j);msg('Планът е готов.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function tbl(t,o){var ks=Object.keys(o||{});if(!ks.length)return '';var h='<table><tr><th class="shop">'+t+'</th><th>кол.</th></tr>';ks.forEach(function(k){h+='<tr><td class="shop">'+esc(k)+'</td><td class="q">'+o[k]+'</td></tr>'});return h+'</table>'}
function renderPlan(j){$('planbox').innerHTML='<h2>За производство</h2><div class="plan">'+tbl('Роли / поке',j.produce_rolls)+tbl('Заготовки',j.produce_zagotovki)+'</div>'}
</script></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  const view = q.view;

  // 1) Страница за собственика (само UI shell; данните искат токен през POST).
  if (req.method === "GET" && view === "tool") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(toolPage());
    return;
  }

  // 2) Четящ екран за цеха (сървърно смята днешния план от днешните сметки).
  if (req.method === "GET" && view === "today") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send(todayPage(`<div class="wrap"><h2>Няма достъп</h2><p>Липсва или грешен ключ в линка.</p></div>`)); return; }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).send(todayPage(`<div class="wrap">Не е конфигуриран достъп до цеха.</div>`)); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : sofiaToday();
    let seed;
    try { seed = await seedShops(date, user, pass); }
    catch (e) { res.status(200).send(todayPage(`<div class="wrap"><h2>Грешка</h2><p>Не мога да прочета сметките сега. Опитай пак след минута.</p></div>`)); return; }
    const { rolls, zag } = compute(seed.shops);
    const tbl = (obj) => Object.keys(obj).sort().map(k => `<tr><td>${esc(k)}</td><td class="q">${round(obj[k])}</td></tr>`).join("") || `<tr><td colspan="2" style="color:#999">няма</td></tr>`;
    const empty = !Object.keys(rolls).length;
    res.status(200).send(todayPage(`
      <header><h1>Цех · за производство днес</h1><div class="d">${esc(date)} · ${seed.accounts} магазина · обновено ${esc(sofiaTime())}</div></header>
      <div class="wrap">${empty
        ? `<h2>Още няма заявки за днес</h2><p>Когато влязат сметките, тук ще се появи какво да се произведе. Страницата се обновява сама.</p>`
        : `<h2>Роли / поке</h2><table>${tbl(rolls)}</table><h2>Заготовки</h2><table>${tbl(zag)}</table>`}
        <div class="note">Обновява се автоматично на всеки 3 минути. Числата са общо за всички магазини.</div></div>`));
    return;
  }

  // 3) JSON изчисление (POST от страницата, или GET със seed_date). Токен-гейт.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};
  const token = body.token != null ? body.token : q.token;
  const okJson = [process.env.RECONCILE_TOKEN, process.env.PAY_HMAC_SECRET, process.env.PREVIEW_TOKEN].some(t => t && token === t);
  if (!okJson) { res.status(403).json({ ok: false, error: "forbidden" }); return; }

  let shops = null, seededAccounts = null;
  const seedDate = body.seed_date || q.seed_date;
  const hasInput = (Array.isArray(body.shops) && body.shops.length) || (body.orders && typeof body.orders === "object") || seedDate;
  if (!hasInput) { res.status(400).json({ ok: false, error: "no_input", hint: "подай shops:[] / orders:{} / seed_date:YYYY-MM-DD" }); return; }
  if (Array.isArray(body.shops) && body.shops.length) {
    shops = body.shops.map(s => ({ client: s.client || null, rep: s.rep || null, account_id: s.account_id || null, order: s.order || {} }));
  } else if (body.orders && typeof body.orders === "object") {
    shops = [{ client: null, rep: null, order: body.orders }];
  } else {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    try { const s = await seedShops(String(seedDate), user, pass); shops = s.shops; seededAccounts = s.accounts; }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    // Празна дата (бъдеща/неработна) — връщаме ok с празно, не грешка.
    if (!shops.length) {
      res.status(200).json({ ok: true, seed_date: seedDate, seeded_accounts: 0, empty: true,
        note: "Няма сметки за тази дата (бъдеща или неработна). Избери минала работна дата.",
        shops: [], order_total: {}, produce_rolls: {}, produce_zagotovki: {} });
      return;
    }
  }

  const { agg, rolls, zag } = compute(shops);
  res.status(200).json({
    ok: true, seed_date: seedDate || null, seeded_accounts: seededAccounts,
    shops: shops.map(s => ({ client: s.client, rep: s.rep, account_id: s.account_id, order: sortObj(s.order || {}, 2) })),
    order_total: sortObj(agg, 2), produce_rolls: sortObj(rolls, 2), produce_zagotovki: sortObj(zag, 3)
  });
};
