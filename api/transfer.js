// api/transfer.js — ПРЕХВЪРЛЯНЕ ЦЕХ → ТОЧКА (Фаза 1).
//
// Защо: стоките се заприходяват САМО в цеха (`motamo.barsy.online`). Точката
// (Каравелов, `motamoshop.barsy.online`) е ОТДЕЛЕН Barsy акаунт, който СЛЕДИ
// наличност и вади по рецепта при всяка продажба → без зареждане тя върви на
// минус. За БАБХ всяко движение иска ДОКУМЕНТ.
//
// Потокът (Фаза 1):
//   1. Точката отваря `?view=shop&k=<token>` → 35-те продукта с ТЕКУЩАТА си
//      наличност, въвежда количества → ЗАЯВКА (Supabase `transfer_requests`).
//   2. Цехът отваря `?view=cex&k=<token>` → вижда чакащите заявки, преглежда,
//      натиска „Изпълни" → 2 документа (цех goods-out + шоп goods-in).
//
// Двата документа (цехът и точката са ЕДНА фирма, затова това НЕ е продажба —
// продажбен документ би надул оборота и ДДС):
//   1) ЦЕХ  — прехвърляне Основен(1) → Точка(2), `Storemoves_save`. Документът
//      за БАБХ. Редът иска партида във формат „партида(количество)" (FIFO).
//   2) ТОЧКА — зареждане в `motamoshop` от доставчик „Мотамо - цех",
//      `Storeloads_save`, по мапнатите id-та и по себестойност от цеха.
// „Преглед" сглобява без да пише; „Издай документите" записва (`dry:false`).

const CEX_API = "https://motamo.barsy.online";
const SHOP_API = "https://motamoshop.barsy.online";
const BID = 1;
const TIMEOUT_MS = 9000;

// ── Supabase (същият проект като кухненския snapshot) ────────────────────────
const SB_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0emd4cmVvamZ2ZGx0YmF2bG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjIxNzksImV4cCI6MjEwMTgzODE3OX0.o4i60i2Q9eCEhEOjw8OLmNqAkXVXpnqYYvx9_9BrkPs";
const SB_TABLE = "transfer_requests";
const sbHeaders = () => ({ apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" });

// ── ★ ЗАКЛЮЧЕН МАПИНГ ЦЕХ_ID → ТОЧКА_ID (35 артикула) ────────────────────────
// Двата Barsy-а ползват РАЗЛИЧНИ id-та за един и същ продукт → мапингът е
// фиксирана таблица (решение на собственика — по-сигурно от съвпадение по име).
// Ръчни съответствия (имената се разминават): 165 Тон филе→307 „Риба Тон";
// 85 Уасаби прах→319 „Уасаби Кинджируши"; 166 Сладък чили→298 „Сос Дракон"
// (точката прави драгон соса от чили-базата); 167 Сусамо олио-люто→149
// „Сусамово олио" (потвърдено от собственика 24.09.2026).
const MAP = {
  29: 124, 36: 112, 38: 154, 39: 140, 44: 133, 51: 99, 52: 98, 53: 159,
  54: 163, 56: 111, 59: 283, 60: 147, 61: 155, 64: 135, 65: 289, 67: 287,
  68: 288, 85: 319, 86: 104, 87: 156, 91: 103, 94: 115, 97: 122, 98: 148,
  103: 100, 104: 138, 123: 136, 127: 130, 131: 290, 144: 118, 146: 294,
  148: 151, 165: 307, 166: 298, 167: 149,
  // ★ 24.09: точката ползва ДВА вида соев сос — наливен (39→140) И пакетче
  // 10 мл (145 „Соев сос 10 мл" → 141 „Соев сос САШЕ", беше на −1162).
  145: 141
};
// Ред на показване в листа — заготовките първо, както собственикът мисли за тях.
const ZAG = [59, 67, 68, 65, 131];
const ORDERED = ZAG.concat(Object.keys(MAP).map(Number).filter(id => !ZAG.includes(id)));

function withTimeout(run) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  return Promise.resolve(run(c.signal)).finally(() => clearTimeout(t));
}
function barsyCall(base, action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${base}/endpoints/json/${action}?bid=${BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
const cexCall = (a, p) => barsyCall(CEX_API, a, p, process.env.BARSY_CEX_USER, process.env.BARSY_CEX_PASS);
const shopCall = (a, p) => barsyCall(SHOP_API, a, p, process.env.BARSY_USER, process.env.BARSY_PASS);

// Недокументираните записващи методи на Barsy се пращат на /endpoints/json (БЕЗ
// действие в пътя), с тяло обвито под ключа на метода — както Storeproductions_save
// и Invoices_create в `cex-plan.js`. Същият канал зарежда и ФОРМИТЕ (…_edit), от
// които се четат очакваните полета.
function callRoot(base, bodyObj, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${base}/endpoints/json?bid=${BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(bodyObj || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
const cexRoot = (b) => callRoot(CEX_API, b, process.env.BARSY_CEX_USER, process.env.BARSY_CEX_PASS);
const shopRoot = (b) => callRoot(SHOP_API, b, process.env.BARSY_USER, process.env.BARSY_PASS);

// Обхожда формата и събира полетата (name→value); обект-стойност се разгъва.
function formValues(node) {
  const values = {};
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.name === "string" && Object.prototype.hasOwnProperty.call(n, "value")) {
      const v = n.value;
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(values, v);
      else if (!(n.name in values) || values[n.name] == null) values[n.name] = v;
    }
    for (const k in n) if (k !== "data_source" && k !== "elements") walk(n[k]);
  })(node);
  return values;
}

function sofiaToday() {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date());
}
function artList(r) {
  const d = (r && r.data) || {};
  let L = d.list || d.data || d;
  if (!Array.isArray(L)) L = (L && typeof L === "object") ? Object.values(L) : [];
  return L.filter(x => x && typeof x === "object" && x.article_id != null);
}

// ── Артикулите за листа: име/мярка от ЦЕХА (той е източникът), наличност от
// ТОЧКАТА (по мапнатото id) + наличност в цеха (има ли изобщо какво да даде).
async function buildList() {
  const [cr, sr] = await Promise.all([
    cexCall("Articles_getlistobject", { extra_properties: ["store_amount"] }),
    shopCall("Articles_getlistobject", { extra_properties: ["store_amount"] })
  ]);
  const cex = {}, shop = {};
  for (const a of artList(cr)) cex[Number(a.article_id)] = a;
  for (const a of artList(sr)) shop[Number(a.article_id)] = a;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return ORDERED.map(id => {
    const c = cex[id] || {}, sid = MAP[id], s = shop[sid] || {};
    return {
      cex_id: id, shop_id: sid,
      name: c.article_name || s.article_name || ("#" + id),
      shop_name: s.article_name || null,
      unit: c.amount_type_name_short || s.amount_type_name_short || "бр",
      shop_stock: num(s.store_amount),
      cex_stock: num(c.store_amount),
      missing: !cex[id] ? "цех" : (!shop[sid] ? "точка" : null)
    };
  });
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
async function sbInsert(row) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify([row]), signal
    });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, row: Array.isArray(d) ? d[0] : null, raw: r.ok ? "" : t.slice(0, 300) };
  });
}
async function sbSelect(qs) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?${qs}`, { headers: sbHeaders(), signal });
    return r.ok ? await r.json() : [];
  });
}
// Атомичен преход на статус: PATCH … WHERE id=… AND status=<from>. Върне 0 реда
// → някой друг вече е взел заявката (двойно натискане) → не правим нищо.
async function sbClaim(id, from, patch) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?id=eq.${encodeURIComponent(id)}&status=eq.${from}`, {
      method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }), signal
    });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
    return { ok: r.ok && Array.isArray(d) && d.length > 0, row: Array.isArray(d) ? d[0] : null, raw: r.ok ? "" : t.slice(0, 300) };
  });
}
async function sbPatch(id, patch) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }), signal
    });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, row: Array.isArray(d) ? d[0] : null, raw: r.ok ? "" : t.slice(0, 300) };
  });
}

// ── ПАРТИДИ ──────────────────────────────────────────────────────────────────
// Прехвърлянето в цеха иска партида на реда, във формата „партида(количество)"
// (виж ръчното прехвърляне №2). Партидите с наличност се четат от
// `Lots_GetListAvailability` — същия източник, който UI-ят ползва за полето.
// Артикулите БЕЗ следене на партида (заготовките) просто не връщат редове →
// редът минава с празно `lot_value`.
const CEX_DEPOT_FROM = 1;   // Основен
const CEX_DEPOT_TO = 2;     // Точка
const SHOP_DEPOT = 1;       // Основен (точката има само един)
const SHOP_SUPPLIER_ID = 4; // „Мотамо - цех" (вече заведен от собственика)

async function lotsByArticle(ids) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 8) chunks.push(ids.slice(i, i + 8));
  for (const ch of chunks) {
    const rs = await Promise.all(ch.map(id =>
      cexRoot({ Lots_GetListAvailability: { filters: { has_amount_real_or_reserved: 1, article_id: id }, params: { bid: BID, article_id: id } } })
        .then(r => ({ id, rows: (r.data && r.data.Lots_GetListAvailability) || [] }))
        .catch(() => ({ id, rows: [] }))
    ));
    for (const r of rs) {
      // само партидите в склада, от който даваме, и само с реална наличност
      out[r.id] = (Array.isArray(r.rows) ? r.rows : [])
        .filter(x => Number(x.depot_id) === CEX_DEPOT_FROM && Number(x.amount_real) > 0)
        // FIFO: първо изтичащите, после по номер на партида
        .sort((a, b) => String(a.lot_exp_date || "9999").localeCompare(String(b.lot_exp_date || "9999"))
          || String(a.lot_value).localeCompare(String(b.lot_value)));
    }
  }
  return out;
}

// Разпределя исканото количество по партиди (FIFO) → по ЕДИН ред на партида,
// както прави и ръчното прехвърляне. Без партиди → един ред с празно lot_value.
function allocate(qty, lots) {
  if (!lots || !lots.length) return { rows: [{ lot_value: "", amount: qty }], short: 0 };
  const rows = []; let left = qty;
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(l.amount_real));
    if (take <= 0) continue;
    // Barsy иска „партида(количество)" в полето
    rows.push({ lot_value: `${l.lot_value}(${round3(take)})`, amount: round3(take), lot_exp: l.lot_exp_date || null });
    left -= take;
  }
  return { rows, short: round3(Math.max(0, left)) };
}
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;

// ── СТРАНИЦИ ─────────────────────────────────────────────────────────────────
const CSS = `
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--fg:#e8eaf0;--dim:#9aa3b2;--warn:#d97706;--acc:#2563eb}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:#12151b;border-bottom:1px solid var(--line);padding:10px 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:18px;margin:0}h1 small{display:block;font-size:12px;color:var(--dim);font-weight:400}
.wrap{padding:12px 14px 96px;max-width:900px;margin:0 auto}
table{width:100%;border-collapse:collapse}
th,td{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
th{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.04em}
td.num,th.num{text-align:right;white-space:nowrap}
input[type=number]{width:92px;padding:8px;font-size:17px;border-radius:8px;border:1px solid var(--line);background:#0c0e13;color:var(--fg);text-align:right}
input[type=number]:focus{outline:2px solid var(--acc)}
button{padding:10px 16px;border-radius:10px;border:0;font-size:15px;font-weight:600;cursor:pointer;background:var(--acc);color:#fff}
button.ghost{background:#222835;color:var(--fg)}button:disabled{opacity:.5;cursor:default}
.neg{color:#ff6b6b;font-weight:700}.zero{color:var(--dim)}
.msg{padding:10px 12px;border-radius:10px;margin:10px 0;font-size:14px;display:none}
.msg.ok{display:block;background:#0f2e1e;color:#7ee2a8}
.msg.err{display:block;background:#2e1414;color:#ff9b9b}
.msg.info{display:block;background:#15203a;color:#a8c4ff}
.bar{position:fixed;left:0;right:0;bottom:0;background:#12151b;border-top:1px solid var(--line);padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between}
.grp{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em;padding-top:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:10px 0}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700}
.pill.pending{background:#3b2f0b;color:#f5c542}.pill.done{background:#0f2e1e;color:#7ee2a8}
.pill.partial{background:#3a2410;color:#ffb066}.pill.failed{background:#2e1414;color:#ff9b9b}
.pill.processing{background:#15203a;color:#a8c4ff}.pill.cancelled{background:#242833;color:var(--dim)}
`;

function shopPage(k) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Заявка към цеха</title>
<style>${CSS}</style></head><body>
<header><h1>Заявка към цеха<small>точка Каравелов · какво да донесат</small></h1></header>
<div class="wrap">
  <div id="msg" class="msg info">Зареждам наличностите…</div>
  <table id="tbl"></table>
</div>
<div class="bar">
  <span id="cnt" style="color:var(--dim);font-size:14px">—</span>
  <span><button class="ghost" onclick="reload()">↻ Наличности</button>
  <button id="send" onclick="send()" disabled>Изпрати заявката</button></span>
</div>
<script>
var K=${JSON.stringify(k)},items=[],DRAFT='motamo-transfer-draft';
function $(i){return document.getElementById(i)}
function msg(t,c){var m=$('msg');m.className='msg '+(c||'info');m.textContent=t}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(b){return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:K},b))}).then(function(r){return r.json()})}
function draft(){try{return JSON.parse(localStorage.getItem(DRAFT)||'{}')}catch(e){return{}}}
function saveDraft(){var d={};document.querySelectorAll('input.q').forEach(function(i){if(i.value)d[i.dataset.id]=i.value});try{localStorage.setItem(DRAFT,JSON.stringify(d))}catch(e){}count()}
function count(){var n=0;document.querySelectorAll('input.q').forEach(function(i){if(Number(i.value)>0)n++});$('cnt').textContent=n?(n+' продукта в заявката'):'нищо не е въведено';$('send').disabled=!n}
function render(){var d=draft(),h='<tr><th>Продукт</th><th class="num">Имам</th><th class="num">Искам</th></tr>',lastZ=null;
items.forEach(function(it){var z=it.zag?'Заготовки':'Суровини и други';if(z!==lastZ){lastZ=z;h+='<tr><td colspan="3" class="grp">'+z+'</td></tr>'}
var st=it.shop_stock,cls=st<0?'neg':(st===0?'zero':'');
h+='<tr><td>'+esc(it.name)+(it.missing?' <span style="color:var(--warn)">\\u26a0 липсва в '+esc(it.missing)+'</span>':'')+'</td>'+
'<td class="num '+cls+'">'+(Math.round(st*1000)/1000)+' '+esc(it.unit)+'</td>'+
'<td class="num"><input class="q" type="number" min="0" step="any" inputmode="decimal" data-id="'+it.cex_id+'" value="'+(d[it.cex_id]||'')+'" oninput="saveDraft()"></td></tr>'});
$('tbl').innerHTML=h;count()}
function reload(){msg('Зареждам наличностите…','info');api({action:'list'}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}items=j.items||[];render();msg('Наличности от точката \\u00b7 '+j.for_date+'. Червено = на минус. Въведи колко искаш и натисни „Изпрати".','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function send(){var rows=[];document.querySelectorAll('input.q').forEach(function(i){var v=Number(i.value);if(v>0)rows.push({cex_id:Number(i.dataset.id),qty:v})});
if(!rows.length){msg('Нищо не е въведено.','err');return}
if(!confirm('Изпращам заявка с '+rows.length+' продукта към цеха. Продължавам?'))return;
$('send').disabled=true;msg('Изпращам…','info');
api({action:'create_request',items:rows,note:null}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');$('send').disabled=false;return}
try{localStorage.removeItem(DRAFT)}catch(e){}
document.querySelectorAll('input.q').forEach(function(i){i.value=''});count();
msg('\\u2713 Заявката е изпратена ('+(j.items_count||rows.length)+' продукта). Цехът я вижда.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err');$('send').disabled=false})}
reload();
</script></body></html>`;
}

function cexPage(k) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Заявки от точката</title>
<style>${CSS}</style></head><body>
<header><h1>Заявки от точката<small>цех · прехвърляне към Каравелов</small></h1>
<button class="ghost" onclick="load()">↻ Опресни</button></header>
<div class="wrap"><div id="msg" class="msg info">Зареждам…</div><div id="list"></div></div>
<script>
var K=${JSON.stringify(k)};
function $(i){return document.getElementById(i)}
function msg(t,c){var m=$('msg');m.className='msg '+(c||'info');m.textContent=t}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(b){return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:K},b))}).then(function(r){return r.json()})}
function load(){msg('Зареждам…','info');api({action:'list_requests'}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}
var rs=j.requests||[];if(!rs.length){$('list').innerHTML='';msg('Няма заявки.','info');return}
var h='';rs.forEach(function(r){var it=r.items||[];
h+='<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">'+
'<b>'+esc(r.for_date)+' \\u00b7 '+it.length+' продукта</b><span class="pill '+esc(r.status)+'">'+esc(r.status)+'</span></div>'+
'<table style="margin-top:8px"><tr><th>Продукт</th><th class="num">Искат</th><th class="num">В цеха</th></tr>';
it.forEach(function(x){var short=(x.cex_stock!=null&&x.cex_stock<x.qty);
h+='<tr><td>'+esc(x.name)+'</td><td class="num">'+x.qty+' '+esc(x.unit||'')+'</td><td class="num'+(short?' neg':'')+'">'+(x.cex_stock==null?'\\u2014':Math.round(x.cex_stock*1000)/1000)+'</td></tr>'});
h+='</table>';
if(r.error)h+='<div class="msg err" style="display:block">'+esc(r.error)+'</div>';
if(r.status==='pending')h+='<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="ghost" onclick="run(&quot;'+esc(r.id)+'&quot;,false)">Преглед</button><button onclick="run(&quot;'+esc(r.id)+'&quot;,true)">Издай документите</button><button class="ghost" onclick="cancelReq(&quot;'+esc(r.id)+'&quot;)">Откажи</button></div>';
if(r.status==='done')h+='<div style="margin-top:8px;color:var(--dim);font-size:13px">цех прехвърляне №'+esc(r.cex_doc_id||'?')+' \\u00b7 точка зареждане №'+esc(r.shop_doc_id||'?')+'</div>';
if(r.status==='partial')h+='<div style="margin-top:8px;display:flex;gap:8px"><button onclick="run(&quot;'+esc(r.id)+'&quot;,true)">Опитай пак точката</button></div>';
h+='</div>'});
$('list').innerHTML=h;msg(rs.length+' заявки.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function run(id,write){
if(write){if(!confirm('ИЗДАВАМ двата документа:\\n1) цех прехвърляне Основен → Точка\\n2) зареждане в точката\\n\\nПродължавам?'))return}
document.querySelectorAll('button').forEach(function(b){b.disabled=true});
msg(write?'Издавам документите…':'Сглобявам (преглед)…','info');
api({action:'process_request',id:id,dry:write?false:true}).then(function(j){
if(!j.ok){msg('Грешка: '+(j.error||''),'err');load();return}
msg(j.message||'Готово.',j.dry?'info':'ok');load()}).catch(function(e){msg('Мрежова грешка: '+e,'err');load()})}
function cancelReq(id){if(!confirm('Отказвам тази заявка?'))return;api({action:'cancel_request',id:id}).then(function(){load()})}
load();
</script></body></html>`;
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  // `TRANSFER_TOKEN` е собственият ключ на този инструмент (точката го ползва от
  // телефона си); старите ключове също се приемат, за да работи един и същ линк.
  const viewTokens = [process.env.TRANSFER_TOKEN, process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].filter(Boolean);

  if (req.method === "GET" && (q.view === "shop" || q.view === "cex")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!viewTokens.some(t => q.k === t)) {
      res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:24px'>Няма достъп — липсва или грешен ключ (?k=).</body>");
      return;
    }
    res.status(200).send(q.view === "shop" ? shopPage(q.k) : cexPage(q.k));
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};
  const token = body.token != null ? body.token : q.token;
  // Четящите/диагностичните действия приемат и PEEK_TOKEN (read-only прозорецът за
  // разработка); всичко, което пише, иска пълния токен.
  const readOnly = ["list", "list_requests", "inspect"].includes(body.action);
  const allowed = readOnly ? viewTokens.concat([process.env.PEEK_TOKEN].filter(Boolean)) : viewTokens;
  if (!allowed.some(t => token === t)) { res.status(403).json({ ok: false, error: "forbidden" }); return; }
  if (!process.env.BARSY_CEX_USER || !process.env.BARSY_USER) { res.status(500).json({ ok: false, error: "not_configured" }); return; }

  try {
    // ── списъкът с 35-те продукта + наличности (за формата на точката) ──
    if (body.action === "list") {
      const items = await buildList();
      res.status(200).json({ ok: true, for_date: sofiaToday(), items: items.map(x => ({ ...x, zag: ZAG.includes(x.cex_id) })) });
      return;
    }

    // ── ДИАГНОСТИКА (само четене): зарежда формата на записващ метод, за да се
    // видят полетата, които Barsy очаква. `what`: "move" = прехвърляне в цеха
    // (Основен→Точка), "load" = зареждане в точката. Нищо не се записва.
    if (body.action === "inspect") {
      const what = body.what || "move";
      const call = what === "load" ? shopRoot : cexRoot;
      const payload = body.payload || (what === "load"
        ? { Storeloads_edit: { params: { bid: BID } } }
        : { Storemoves_edit: { params: { bid: BID } } });
      const r = await call(payload);
      const inner = r.data && (r.data.Storemoves_edit || r.data.Storeloads_edit || r.data);
      const actions = [];
      (function w(n) {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(w);
        if (n.type === "action" && n.target) actions.push({ title: n.title || null, target: n.target });
        for (const k in n) w(n[k]);
      })(inner);
      res.status(200).json({
        ok: r.ok, what, status: r.status,
        values: inner ? formValues(inner) : null,
        actions: actions.slice(0, 20),
        raw: String(r.raw || "").slice(0, Number(body.raw_chars) || 1500)
      });
      return;
    }

    // ── точката праща заявка ──
    if (body.action === "create_request") {
      const raw = Array.isArray(body.items) ? body.items : [];
      const want = new Map();
      for (const r of raw) {
        const id = Number(r && r.cex_id), qty = Number(r && r.qty);
        if (!MAP[id] || !(qty > 0)) continue;
        want.set(id, (want.get(id) || 0) + qty); // един ред на артикул
      }
      if (!want.size) { res.status(200).json({ ok: false, error: "празна заявка — няма нито едно количество > 0" }); return; }
      const list = await buildList();
      const byId = {}; for (const x of list) byId[x.cex_id] = x;
      const items = [...want.entries()].map(([id, qty]) => ({
        cex_id: id, shop_id: MAP[id], name: (byId[id] || {}).name || ("#" + id),
        unit: (byId[id] || {}).unit || "бр", qty,
        shop_stock: (byId[id] || {}).shop_stock, cex_stock: (byId[id] || {}).cex_stock
      }));
      const ins = await sbInsert({ for_date: sofiaToday(), status: "pending", items, note: body.note || null });
      if (!ins.ok) { res.status(200).json({ ok: false, error: "не се записа: " + ins.raw }); return; }
      res.status(200).json({ ok: true, id: ins.row && ins.row.id, items_count: items.length });
      return;
    }

    // ── цехът вижда заявките ──
    if (body.action === "list_requests") {
      const lim = Math.min(Number(body.limit) || 20, 100);
      const rows = await sbSelect(`order=created_at.desc&limit=${lim}`);
      res.status(200).json({ ok: true, requests: rows });
      return;
    }

    if (body.action === "cancel_request") {
      const id = String(body.id || ""); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
      const c = await sbClaim(id, "pending", { status: "cancelled" });
      res.status(200).json({ ok: c.ok, error: c.ok ? undefined : "заявката вече не е чакаща" });
      return;
    }

    // ── цехът изпълнява: 2 документа ──
    // ⚠ ЗАСЕГА DRY: взема заявката атомично (pending→processing) — така двойно
    // натискане НЕ прави втори комплект документи — проверява наличността в цеха,
    // сглобява редовете за двата документа и ВРЪЩА статуса обратно на pending.
    // НИЩО не се пише в Barsy, докато не се избере документният модел
    // (вътрешен трансфер vs продажба на вътрешен клиент).
    if (body.action === "process_request") {
      const id = String(body.id || ""); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
      const write = body.dry === false;
      const claim = await sbClaim(id, "pending", { status: write ? "processing" : "pending" });
      if (!claim.ok) { res.status(200).json({ ok: false, error: "заявката вече се изпълнява или е изпълнена (двойно натискане)" }); return; }
      const reqRow = claim.row || {};
      const items = (Array.isArray(reqRow.items) ? reqRow.items : []).filter(it => MAP[it.cex_id] && Number(it.qty) > 0);
      if (!items.length) {
        await sbPatch(id, { status: "failed", error: "празна заявка" });
        res.status(200).json({ ok: false, error: "празна заявка" }); return;
      }

      // пресни данни: наличност + себестойност (цех) и партидите по артикул
      const [cr, lots] = await Promise.all([
        cexCall("Articles_getlistobject", { extra_properties: ["store_amount", "avg_delivery_price"] }),
        lotsByArticle(items.map(it => it.cex_id))
      ]);
      const cexA = {}; for (const a of artList(cr)) cexA[Number(a.article_id)] = a;
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

      // редовете на двата документа
      const moveRows = [], loadRows = [], short = [];
      for (const it of items) {
        const a = cexA[it.cex_id] || {};
        const have = num(a.store_amount);
        const qty = round3(Math.min(Number(it.qty), Math.max(0, have))); // не даваме повече, отколкото има
        if (qty < Number(it.qty)) short.push(`${it.name}: искат ${it.qty}, в цеха ${round3(have)}`);
        if (qty <= 0) continue;
        const alloc = allocate(qty, lots[it.cex_id]);
        if (alloc.short > 0) short.push(`${it.name}: ${alloc.short} ${it.unit || ""} без партида в склада`);
        for (const r of alloc.rows) {
          moveRows.push({
            row_id: "", article_id: String(it.cex_id), ref_num: null,
            article_name: it.name, current_price: null,
            amount: String(r.amount), notes: "",
            lot_value: r.lot_value, lot_type_id: r.lot_value ? "4" : "1"
          });
        }
        const cost = num(a.avg_delivery_price);
        loadRows.push({
          store_load_row_id: "", article_id: String(MAP[it.cex_id]),
          original_article_name: it.name, amount: String(qty),
          current_price: String(cost), delivery_price: String(cost),
          delivery_total: String(Math.round(cost * qty * 100) / 100),
          delivery_tax_id: "100", actual_tax_id: "100", tax: "0", tax_sum: "0",
          discount: "0", lot_value: null, lot_exp_date: null, lot_type_id: "1",
          notes: null, amount_unit: "1", is_group_art: 0
        });
      }

      if (!moveRows.length) {
        await sbPatch(id, { status: "pending", error: "няма нито един ред с наличност в цеха" });
        res.status(200).json({ ok: false, error: "няма нито един ред с наличност в цеха: " + short.join(" · ") }); return;
      }

      const today = sofiaToday();
      const movePayload = { Storemoves_save: {
        id: null, action_type: "confirm_move",
        values: {
          store_move_id: null, doc_date: today + " 00:00:00",
          description: "Прехвърляне към точка Каравелов (заявка " + id.slice(0, 8) + ")",
          from_depot_id: String(CEX_DEPOT_FROM), to_depot_id: String(CEX_DEPOT_TO),
          from_barsy_id: String(BID), to_barsy_id: String(BID),
          depot_left: { barsy_id: BID, depot_id: CEX_DEPOT_FROM },
          depot_right: { barsy_id: BID, depot_id: CEX_DEPOT_TO },
          deal_id: null, deal_title: "", status: 0
        }, rows: moveRows } };
      const loadPayload = { Storeloads_save: {
        id: null, action_type: "confirm_storeload_close",
        values: {
          store_load_id: null, depot_id: String(SHOP_DEPOT), doc_type_id: "1",
          doc_date: today + " 00:00:00", doc_num: null,
          supplier_id: String(SHOP_SUPPLIER_ID), has_tax: 0, price_mode: 0, fill_delivery_price: 0,
          currency_id: "1", currency_rate: "1", store_load_cat_id: "1", discount: "0",
          total_costs: 0, description: "Прехвърляне от цеха (заявка " + id.slice(0, 8) + ")"
        }, rows: loadRows } };

      if (write) {
        // ── 1) ЦЕХ: прехвърляне Основен → Точка (документът за БАБХ) ──
        const mv = await cexRoot(movePayload);
        const mvSave = mv.data && mv.data.Storemoves_save;
        const mvId = (mvSave && (mvSave.id || mvSave.store_move_id)) || null;
        if (!mv.ok || (mv.data && mv.data.error)) {
          await sbPatch(id, { status: "failed", error: "цех прехвърляне падна: " + String(mv.raw || "").slice(0, 300) });
          res.status(200).json({ ok: false, step: "cex", error: String(mv.raw || "").slice(0, 400) }); return;
        }
        // ── 2) ТОЧКА: зареждане от „Мотамо - цех" ──
        // Цех документът вече е издаден; при провал тук заявката остава „partial"
        // и НЕ се трие автоматично — за БАБХ следата е по-важна от чистотата.
        const ld = await shopRoot(loadPayload);
        const ldSave = ld.data && ld.data.Storeloads_save;
        const ldId = (ldSave && (ldSave.id || ldSave.store_load_id)) || null;
        if (!ld.ok || (ld.data && ld.data.error)) {
          await sbPatch(id, { status: "partial", cex_doc_id: mvId ? String(mvId) : "?", processed_at: new Date().toISOString(), error: "цехът е изписан, точката НЕ е заредена: " + String(ld.raw || "").slice(0, 300) });
          res.status(200).json({ ok: false, step: "shop", cex_doc_id: mvId, error: "Цехът е изписан (прехвърляне " + (mvId || "?") + "), но зареждането в точката падна: " + String(ld.raw || "").slice(0, 300) }); return;
        }
        await sbPatch(id, { status: "done", cex_doc_id: mvId ? String(mvId) : null, shop_doc_id: ldId ? String(ldId) : null, processed_at: new Date().toISOString(), error: null });
        res.status(200).json({
          ok: true, dry: false, id, cex_doc_id: mvId, shop_doc_id: ldId, short,
          message: "✓ Готово: цех прехвърляне " + (mvId || "") + " (" + moveRows.length + " реда) → точка зареждане " + (ldId || "") + " (" + loadRows.length + " реда)."
            + (short.length ? " ⚠ " + short.join(" · ") : "")
        });
        return;
      }

      res.status(200).json({
        ok: true, dry: true, id, move_rows: moveRows.length, load_rows: loadRows.length, short,
        message: "ПРЕГЛЕД: цех прехвърляне " + moveRows.length + " реда, точка зареждане " + loadRows.length + " реда."
          + (short.length ? " \u26a0 НЕДОСТИГ в цеха: " + short.join(" · ") : "")
          + " Натисни пак с Издай документите, за да се запише.",
        payloads: { move: movePayload, load: loadPayload }
      });
      return;
    }

    res.status(400).json({ ok: false, error: "unknown_action" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
};
