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

const crypto = require("crypto");
const DATA = require("./_cexdata.js");
const ARTS = DATA.articles, NAME2ID = DATA.name2id;
const MENU = Object.values(ARTS).filter(a => a.is_menu)
  .sort((a, b) => (a.is_set - b.is_set) || (a.id - b.id))
  .map(a => ({ id: a.id, name: a.name, is_set: !!a.is_set }));

const CEX_API = "https://motamo.barsy.online", CEX_BID = 1, CEX_DEPOT = 1, TIMEOUT_MS = 9000;
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
// Записът на производство е недокументиран вътрешен метод: праща се на
// /endpoints/json?bid=1 (БЕЗ действие в пътя), а тялото е обвито под ключа
// „Storeproductions_save". Затова обикновените извиквания не хващаха склада —
// depot_id живее в values, вътре в обвивката. (Разбито живо, S12.)
function cexCallRoot(bodyObj, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${CEX_API}/endpoints/json?bid=${CEX_BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(bodyObj || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
// Създава ЕДНО производство (save_and_close → произведеното влиза в наличност).
// rows: [{article_id, amount, lot?, lot_exp?}]. Числата се пращат като низове.
async function createProduction(rows, opts, user, pass) {
  const o = opts || {};
  const body = { Storeproductions_save: {
    id: null, action_type: "save_and_close",
    values: { depot_id: String(o.depot_id || CEX_DEPOT), doc_date: o.doc_date || null, description: o.description || "", notes: o.notes || "" },
    rows: (rows || []).map((r, i) => ({
      row_id: "", article_id: r.article_id, article_name: r.article_name || "",
      amount: String(r.amount), amount_prod: String(r.amount_prod != null ? r.amount_prod : r.amount),
      prod_user: "", lot_value: r.lot != null ? String(r.lot) : (o.lot != null ? String(o.lot) : ""),
      lot_exp_date: r.lot_exp || o.lot_exp || null, notes: "", requested_qty: "",
      item_status: "0", prod_reason_id: "", sort_order: String(i)
    }))
  }};
  const r = await cexCallRoot(body, user, pass);
  // Barsy връща новото id като СТОЙНОСТ на ключа: {"Storeproductions_save": <id>}.
  const id = r.data && (r.data.Storeproductions_save || r.data.store_production_id || r.data.id || (r.data.data && r.data.data.store_production_id)) || null;
  return { ok: !!r.ok && !!id, status: r.status, store_production_id: id, data: r.data, error: r.ok && id ? undefined : String(r.raw || "").slice(0, 300) };
}
// Паралелно с ограничение (за да не надхвърлим лимита при много заявки).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
// Наличности на всички СУРОВИНИ + ЗАГОТОВКИ (за ежедневния репорт „кое е на изчерпване").
async function readStock(user, pass) {
  const arts = Object.values(ARTS).filter(a => a.cat === "Суровини" || a.cat === "Заготовки");
  const rows = await mapLimit(arts, 34, async (a) => {
    let qty = null;
    try {
      const r = await cexCall("Articles_getavailability", { article_id: a.id, depots: [CEX_DEPOT] }, user, pass);
      const d = r.data; qty = d && typeof d === "object" ? Number(d[String(CEX_DEPOT)] ?? Object.values(d)[0]) : null;
    } catch (e) { qty = null; }
    return { id: a.id, name: a.name, cat: a.cat, qty: (qty == null || isNaN(qty)) ? null : Math.round(qty * 1000) / 1000 };
  });
  rows.sort((x, y) => (x.qty == null ? 1 : y.qty == null ? -1 : x.qty - y.qty));
  return rows;
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
    return { account_id: a.account_id, client_id: a.client_id, person_id: a.person_id, client: a.client_name || null, rep: a.person_name || null, order };
  }));
  return { shops, accounts: accts.length };
}
// UUID за идемпотентност — един и същ за (ден+магазин), за да не се дублира сметка.
function uuidFor(date, s) {
  const key = `${date}|${s.client_id || ""}|${s.person_id || ""}|${s.rep || ""}`;
  const h = crypto.createHash("sha1").update(key).digest("hex");
  const v = "5" + h.slice(13, 16), a = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return [h.slice(0, 8), h.slice(8, 12), v, a, h.slice(20, 32)].join("-");
}
// Създава ОТВОРЕНИ сметки-чернови по магазин (без затваряне → без фискален бон, без склад).
async function createAccounts(shops, date, user, pass) {
  const out = [];
  for (const s of shops) {
    const orders = Object.entries(s.order || {})
      .map(([name, qty]) => { const art = resolve(name); return art ? { article_id: art.id, amount: Number(qty) } : null; })
      .filter(o => o && o.amount > 0);   // цена НЕ подаваме → Barsy слага по ценово правило на клиента
    if (!orders.length) { out.push({ client: s.client, rep: s.rep, skipped: "празна" }); continue; }
    const account = {
      uuid: uuidFor(date, s),
      account_alias: [s.client, s.rep].filter(Boolean).join(" · ") || "ОНЛАЙН"
    };
    if (s.client_id) account.client_id = s.client_id;
    if (s.person_id) account.person_id = s.person_id;
    let r;
    try { r = await cexCall("Accounts_place", { account, orders, flag_close_account: 0 }, user, pass); }
    catch (e) { out.push({ client: s.client, rep: s.rep, ok: false, error: String(e && e.message) }); continue; }
    const accId = typeof r.data === "number" ? r.data : (r.data && (r.data.account_id || r.data.id)) || null;
    out.push({ client: s.client, rep: s.rep, ok: !!r.ok, account_id: accId, items: orders.length,
      error: r.ok ? undefined : String(r.raw || "").slice(0, 200) });
  }
  return out;
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
// Партида/срок: партида = L.<деня на производство>, срок = +3 дни (правилото на цеха).
function isoToDDMMYYYY(iso) { const p = String(iso).split("-"); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : iso; }
function isoPlusDays(iso, n) { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function lotFor(prodDateIso) { return { lot: "L." + isoToDDMMYYYY(prodDateIso), lot_exp: isoToDDMMYYYY(isoPlusDays(prodDateIso, 3)) }; }

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

// ── HTML: репорт за наличности (суровини+заготовки) ───────────────────────────
function stockPage(inner) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Цех · наличности</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:16px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#fff;color:#111}
header{background:#b3121b;color:#fff;padding:14px 18px}header h1{margin:0;font-size:22px}header .d{font-size:14px;opacity:.9;margin-top:2px}
.wrap{padding:16px;max-width:760px;margin:0 auto}h2{font-size:18px;margin:20px 0 8px;border-bottom:3px solid #b3121b;padding-bottom:4px}
table{border-collapse:collapse;width:100%}th,td{padding:9px 12px;border-bottom:1px solid #eee;text-align:left;font-size:16px}
th{background:#f0f1f3}td.q,th.q{text-align:right;font-weight:800;white-space:nowrap}td.c{color:#888;font-size:13px;text-align:center}
tr.lo td{background:#fde8e8}tr.lo td.q{color:#9b1c1c}.ok{color:#1b5e20;font-weight:600}.note{color:#666;font-size:13px;margin-top:18px}
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
button.prod{background:#0a7d33}button.acc{background:#7a0c12}
header .grp{display:flex;gap:6px;align-items:center}header label{font-size:12px;opacity:.9}
header .dlab{background:#fff;color:#b3121b;border-radius:5px;padding:3px 8px;font-size:13px;white-space:nowrap}
@media (max-width:760px){
 body{font-size:16px}
 header{gap:8px;padding:10px}header h1{width:100%;margin:0 0 4px;font-size:18px}
 header .grp{flex:1 1 100%;justify-content:flex-start;flex-wrap:wrap}
 header .dlab{flex:0 0 auto}
 header input{font-size:16px;padding:9px 10px;flex:1}
 header button{font-size:16px;padding:11px 12px;flex:1}
 header label{min-width:64px}
 th,td{font-size:14px;padding:6px}td input{width:44px;font-size:16px;padding:6px}
 .plan{gap:12px}.plan table{min-width:100%}
 h2{font-size:17px}
}
.wrap{padding:14px;max-width:1400px;margin:0 auto}.msg{padding:8px 12px;border-radius:6px;margin:8px 0;display:none}.msg.err{background:#fde8e8;color:#9b1c1c;display:block}.msg.ok{background:#e8f5e9;color:#1b5e20;display:block}
table{border-collapse:collapse;background:#fff}
.scroll{overflow:auto;max-height:74vh;border:1px solid #d7dade;border-radius:8px;margin:8px 0}
#grid{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
#grid th,#grid td{border-bottom:1px solid #eef0f2;border-right:1px solid #eef0f2;padding:7px 8px;text-align:center;white-space:nowrap}
#grid th{background:#2b2f36;color:#fff;position:sticky;top:0;z-index:2;font-weight:600;font-size:12px;letter-spacing:.02em}
#grid tr:nth-child(even) td{background:#fafbfc}
#grid th.shop,#grid td.shop{position:sticky;left:0;text-align:left;min-width:210px;max-width:250px;overflow:hidden;text-overflow:ellipsis;background:#fff;box-shadow:1px 0 0 #d7dade}
#grid td.shop{z-index:1;font-weight:500}#grid th.shop{z-index:3;background:#2b2f36}
#grid td input{width:46px;text-align:center;border:1px solid #cfd3d8;border-radius:5px;padding:5px 3px;font-size:14px}
#grid td input:focus{outline:2px solid #0a7d33;border-color:#0a7d33}
#grid td.set input{background:#fff7e6}#grid th.set{background:#4a3d1a;color:#ffe6a3}
h2{font-size:15px;margin:18px 0 6px}.plan{display:flex;gap:24px;flex-wrap:wrap}.plan table{width:auto;min-width:260px}.plan table td,.plan table th{border:1px solid #e2e4e8;padding:7px 12px;text-align:left}.plan table th{background:#f0f1f3}.plan td.q{font-weight:700;color:#b3121b;text-align:right}
@media print{header,.noprint{display:none}.wrap{padding:0}}
</style></head><body>
<header><h1>MOTAMO цех</h1>
<span id="tokwrap"><input id="tok" type="password" placeholder="токен" size="16"></span>
<span class="grp"><label>Зареди</label><input id="date" type="date"><b class="dlab" id="dlab"></b><button onclick="seed()">Зареди</button></span>
<span class="grp"><button class="alt" onclick="calc()">Изчисли</button><button class="alt" onclick="window.print()">Печат</button></span>
<span class="grp"><label>Партида</label><input id="pdate" type="date" title="Партида L.<тази дата>, срок +3 дни"><b class="dlab" id="plab"></b></span>
<span class="grp"><button class="prod" onclick="doProduce()">① Производство</button><button class="acc" onclick="doAccounts()">② Сметки</button></span></header>
<div class="wrap"><div id="msg" class="msg"></div><div class="scroll"><table id="grid"></table></div><div id="planbox"></div></div>
<script>
var MENU=${JSON.stringify(MENU)};var shops=[];var $=function(id){return document.getElementById(id)};
(function(){var urlk='';try{urlk=new URLSearchParams(location.search).get('k')||new URLSearchParams(location.search).get('token')||''}catch(e){}
var saved='';try{saved=localStorage.getItem('cex_tok')||''}catch(e){}
var t=urlk||saved;$('tok').value=t;if(urlk){try{localStorage.setItem('cex_tok',urlk)}catch(e){}}
// щом има токен от линк/памет — крием полето (телефон); иначе го показваме
if(t){$('tokwrap').style.display='none'}})();
$('tok').addEventListener('change',function(){try{localStorage.setItem('cex_tok',$('tok').value)}catch(e){}});
(function(){var t=new Date().toISOString().slice(0,10);$('date').value=t;$('pdate').value=t})();
var BGM=['янв.','февр.','март','апр.','май','юни','юли','авг.','септ.','окт.','ноем.','дек.'];
function fmtBg(iso){if(!iso||iso.split('-').length<3)return '';var p=iso.split('-');return BGM[(+p[1])-1]+' '+p[2]}
function updLabs(){$('dlab').textContent=fmtBg($('date').value);$('plab').textContent=$('pdate').value?('партида L.'+$('pdate').value.split('-').reverse().join('.')):''}
$('date').addEventListener('change',updLabs);$('date').addEventListener('input',updLabs);
$('pdate').addEventListener('change',updLabs);$('pdate').addEventListener('input',updLabs);updLabs();
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
function doProduce(){if(!shops.length){msg('Първо натисни „Зареди", за да заредиш деня.','err');return}collect();var pd=$('pdate').value;var lot='L.'+pd.split('-').reverse().join('.');if(!confirm('Ще СЪЗДАМ производство в Barsy:\\n• заготовки, после роли/поке\\n• партида '+lot+' (срок +3 дни)\\nПродължавам?'))return;msg('Правя производството… (заготовки → роли)');api({action:'produce_plan',shops:shops,prod_date:pd}).then(function(j){if(!j.ok){msg('Грешка при производство: '+((j.rolls&&j.rolls.error)||(j.zagotovki&&j.zagotovki.error)||j.error||j.message||''),'err');return}var zi=j.zagotovki&&j.zagotovki.store_production_id,ri=j.rolls&&j.rolls.store_production_id;msg('✓ Производството е създадено. Партида '+j.lot+' · заготовки №'+(zi||'—')+' · роли/поке №'+(ri||'—')+'. Провери в касата и „Приключи", ако е ок.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function doAccounts(){if(!shops.length){msg('Първо натисни „Зареди", за да заредиш деня.','err');return}collect();if(!confirm('Ще СЪЗДАМ отворени сметки в Barsy по магазин.\\nЦените ги слага Barsy по правилото на клиента (аз не подавам цена).\\nПродължавам?'))return;msg('Създавам сметките…');api({action:'create_accounts',date:($('pdate').value||$('date').value),shops:shops}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}var cr=j.created||[];var ok=cr.filter(function(c){return c.ok}).length,bad=cr.filter(function(c){return c.ok===false}).length;msg('✓ Създадени '+ok+' сметки'+(bad?(', '+bad+' с грешка'):'')+'. Провери в касата.',bad?'err':'ok');renderCreated(cr)}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function renderCreated(cr){var h='<h2>Създадени сметки</h2><table><tr><th class="shop">Магазин</th><th>сметка №</th><th>артикули</th><th>статус</th></tr>';cr.forEach(function(c){h+='<tr><td class="shop">'+esc((c.client||'')+(c.rep?(' · '+c.rep):''))+'</td><td>'+(c.account_id||'—')+'</td><td>'+(c.items||0)+'</td><td>'+(c.ok?'✓':esc(c.skipped||'грешка'))+'</td></tr>'});$('planbox').innerHTML=h+'</table>'}
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

  // 2b) Репорт за наличности (суровини+заготовки), четящ екран за собственика.
  if (req.method === "GET" && view === "stock") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && q.k === t);
    if (!okV) { res.status(403).send(stockPage(`<div class="wrap"><h2>Няма достъп</h2><p>Липсва или грешен ключ.</p></div>`)); return; }
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).send(stockPage(`<div class="wrap">Не е конфигуриран достъп до цеха.</div>`)); return; }
    let rows;
    try { rows = await readStock(user, pass); }
    catch (e) { res.status(200).send(stockPage(`<div class="wrap"><h2>Грешка</h2><p>Не мога да прочета наличностите сега. Опитай пак след минута.</p></div>`)); return; }
    const low = rows.filter(r => r.qty != null && r.qty <= 1);
    const rowHtml = (arr) => arr.map(r => `<tr class="${r.qty != null && r.qty <= 1 ? 'lo' : ''}"><td>${esc(r.name)}</td><td class="c">${esc(r.cat === "Заготовки" ? "заг." : "сур.")}</td><td class="q">${r.qty == null ? "?" : r.qty}</td></tr>`).join("");
    res.status(200).send(stockPage(`
      <header><h1>Цех · наличности</h1><div class="d">${esc(sofiaToday())} · обновено ${esc(sofiaTime())} · ${rows.length} артикула</div></header>
      <div class="wrap">
        ${low.length ? `<h2>⚠️ На изчерпване (≤1)</h2><table>${rowHtml(low)}</table>` : `<p class="ok">Няма критично ниски (всичко над 1).</p>`}
        <h2>Всички (най-малко първо)</h2><table><tr><th>Артикул</th><th>вид</th><th class="q">нал.</th></tr>${rowHtml(rows)}</table>
        <div class="note">Обновява се при отваряне. „?" = липсва отчет за склада.</div></div>`));
    return;
  }

  // 3) JSON изчисление (POST от страницата, или GET със seed_date). Токен-гейт.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};
  const token = body.token != null ? body.token : q.token;
  const okJson = [process.env.RECONCILE_TOKEN, process.env.PAY_HMAC_SECRET, process.env.PREVIEW_TOKEN].some(t => t && token === t);
  if (!okJson) { res.status(403).json({ ok: false, error: "forbidden" }); return; }

  // ── СЪЗДАВАНЕ на отворени сметки-чернови в Barsy (ПИШЕ; зад силен токен) ──
  if (body.action === "create_accounts") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const shopsIn = Array.isArray(body.shops) ? body.shops : [];
    if (!shopsIn.length) { res.status(400).json({ ok: false, error: "no_shops" }); return; }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : sofiaToday();
    const created = await createAccounts(shopsIn, date, user, pass);
    res.status(200).json({ ok: true, created });
    return;
  }

  // ── СЪЗДАВАНЕ на ПРОИЗВОДСТВО в Barsy (ПИШЕ; произведеното влиза в наличност) ──
  // rows: [{article_id, amount}]  или  produce: {"NACHI ORO":12, ...} (по име/ид).
  if (body.action === "create_production") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    let rows = [];
    if (Array.isArray(body.rows)) {
      rows = body.rows.map(r => ({ article_id: r.article_id, amount: r.amount, amount_prod: r.amount_prod, article_name: r.article_name, lot: r.lot, lot_exp: r.lot_exp }))
        .filter(r => r.article_id && Number(r.amount) > 0);
    } else if (body.produce && typeof body.produce === "object") {
      for (const [k, v] of Object.entries(body.produce)) {
        const art = resolve(k); if (art && Number(v) > 0) rows.push({ article_id: art.id, article_name: art.name, amount: Number(v) });
      }
    }
    if (!rows.length) { res.status(400).json({ ok: false, error: "no_rows", hint: "подай rows:[{article_id,amount}] или produce:{име:кол}" }); return; }
    const opts = { doc_date: body.doc_date || null, lot: body.lot != null ? body.lot : "", lot_exp: body.lot_exp || null, description: body.description || "", notes: body.notes || "" };
    let r;
    try { r = await createProduction(rows, opts, user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    res.status(200).json({ ok: r.ok, store_production_id: r.store_production_id, rows: rows.length, error: r.error });
    return;
  }

  // ── ЦЯЛ ПЛАН: произвежда ЗАГОТОВКИ, после РОЛИ/ПОКЕ (2 нива), с вярна партида ──
  if (body.action === "produce_plan") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    const shopsIn = Array.isArray(body.shops) ? body.shops.map(s => ({ order: s.order || {} })) : [];
    if (!shopsIn.length) { res.status(400).json({ ok: false, error: "no_shops" }); return; }
    const { rolls, zag } = compute(shopsIn);
    const prodDate = /^\d{4}-\d{2}-\d{2}$/.test(body.prod_date || "") ? body.prod_date : sofiaToday();
    const auto = body.auto_lot === true; // авто-партида (същия ден) → празна партида
    const { lot, lot_exp } = auto ? { lot: "", lot_exp: null } : lotFor(prodDate);
    const toRows = (map) => Object.entries(map)
      .map(([name, qty]) => { const a = resolve(name); return a ? { article_id: a.id, article_name: a.name, amount: round(Number(qty)) } : null; })
      .filter(r => r && r.amount > 0);
    const zagRows = toRows(zag), rollRows = toRows(rolls);
    const out = { lot: lot || "(авто)", lot_exp, prod_date: prodDate };
    // По подразбиране произвеждаме САМО роли/поке — те дърпат готовите заготовки от
    // наличност. Заготовките се включват само с include_zag (някои нямат рецепта за
    // производство в Barsy, напр. „заг. Марината за ориз", и чупят наведнъж).
    try {
      if (body.include_zag === true && zagRows.length) out.zagotovki = await createProduction(zagRows, { lot, lot_exp }, user, pass);
      if (rollRows.length) out.rolls = await createProduction(rollRows, { lot, lot_exp }, user, pass);
    } catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    out.ok = (!rollRows.length || (out.rolls && out.rolls.ok)) && (body.include_zag !== true || !zagRows.length || (out.zagotovki && out.zagotovki.ok));
    res.status(200).json(out);
    return;
  }

  // ── Наличности суровини+заготовки (JSON) ──
  if (body.action === "stock") {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    let rows;
    try { rows = await readStock(user, pass); }
    catch (e) { res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) }); return; }
    res.status(200).json({ ok: true, rows });
    return;
  }

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
