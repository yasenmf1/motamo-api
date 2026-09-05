// api/cex-tool.js — Фаза 1 UI: цехов производствен калкулатор (вътрешен инструмент).
// Отваря се на https://motamo-api.vercel.app/api/cex-tool
// Зарежда дневната заявка по магазини (от историята на деня), коригираш бройките,
// и показва производствения план (роли + заготовки). Вика api/cex-plan. Токенът се
// въвежда веднъж и се пази в браузъра (localStorage) — не е зашит в кода.

const DATA = require("./_cexdata.js");
const MENU = Object.values(DATA.articles)
  .filter(a => a.is_menu)
  .sort((a, b) => (a.is_set - b.is_set) || (a.id - b.id))   // роли/поке първо, сетове накрая
  .map(a => ({ id: a.id, name: a.name, is_set: !!a.is_set }));

module.exports = function handler(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(`<!doctype html><html lang="bg"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOTAMO цех — производствен калкулатор</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{font:14px system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f5f7;color:#1a1a1a}
  header{background:#b3121b;color:#fff;padding:10px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:5}
  header h1{font-size:16px;margin:0 12px 0 0}
  header input{font:13px system-ui;padding:5px 7px;border:0;border-radius:5px}
  button{font:13px system-ui;padding:6px 12px;border:0;border-radius:6px;background:#111;color:#fff;cursor:pointer}
  button.alt{background:#fff;color:#111;border:1px solid #ccc}
  .wrap{padding:14px;max-width:1400px;margin:0 auto}
  .msg{padding:8px 12px;border-radius:6px;margin:8px 0;display:none}
  .msg.err{background:#fde8e8;color:#9b1c1c;display:block}
  .msg.ok{background:#e8f5e9;color:#1b5e20;display:block}
  table{border-collapse:collapse;background:#fff;width:100%;margin:6px 0}
  th,td{border:1px solid #e2e4e8;padding:4px 6px;text-align:center;font-size:13px}
  th{background:#f0f1f3;position:sticky;top:52px}
  th.shop,td.shop{text-align:left;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
  td input{width:52px;text-align:center;border:1px solid #d0d3d8;border-radius:4px;padding:3px}
  .set{background:#fff7e6}
  h2{font-size:15px;margin:18px 0 4px}
  .plan{display:flex;gap:24px;flex-wrap:wrap}
  .plan table{width:auto;min-width:280px}
  .plan td.q{font-weight:700;color:#b3121b}
  .scroll{overflow-x:auto}
  @media print{header,.noprint{display:none}.wrap{padding:0}}
</style></head><body>
<header>
  <h1>MOTAMO цех · производство</h1>
  <input id="tok" type="password" placeholder="токен" size="20">
  <input id="date" type="date">
  <button onclick="seed()">Зареди от дата</button>
  <button class="alt" onclick="calc()">Изчисли план</button>
  <button class="alt" onclick="window.print()">Печат</button>
</header>
<div class="wrap">
  <div id="msg" class="msg"></div>
  <div class="scroll"><table id="grid"></table></div>
  <div id="planbox"></div>
</div>
<script>
var MENU = ${JSON.stringify(MENU)};
var shops = [];  // [{client,rep,account_id,order:{name:qty}}]
var $=function(id){return document.getElementById(id)};
try{ $('tok').value = localStorage.getItem('cex_tok')||''; }catch(e){}
$('tok').addEventListener('change',function(){try{localStorage.setItem('cex_tok',$('tok').value)}catch(e){}});
(function(){ var d=new Date(); $('date').value=d.toISOString().slice(0,10); })();
function msg(t,kind){var m=$('msg');m.textContent=t;m.className='msg '+(kind||'');}
function api(payload){
  return fetch('/api/cex-plan',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(Object.assign({token:$('tok').value},payload))})
    .then(function(r){return r.json()});
}
function seed(){
  msg('Зареждам…');
  api({seed_date:$('date').value}).then(function(j){
    if(!j.ok){msg('Грешка: '+(j.error||'')+' '+(j.hint||''),'err');return;}
    shops = j.shops||[];
    renderGrid(); renderPlan(j);
    msg('Заредени '+(j.seeded_accounts||0)+' сметки. Коригирай и „Изчисли план".','ok');
  }).catch(function(e){msg('Мрежова грешка: '+e,'err')});
}
function renderGrid(){
  var h='<tr><th class="shop">Магазин</th>';
  MENU.forEach(function(m){h+='<th class="'+(m.is_set?'set':'')+'">'+m.name.replace('НACHI','')+'</th>'});
  h+='</tr>';
  shops.forEach(function(s,i){
    var label=(s.client||'')+(s.rep?(' · '+s.rep):'');
    h+='<tr><td class="shop" title="'+esc(label)+'">'+esc(label)+'</td>';
    MENU.forEach(function(m){
      var v=(s.order&&s.order[m.name])||0;
      h+='<td class="'+(m.is_set?'set':'')+'"><input data-i="'+i+'" data-n="'+esc(m.name)+'" value="'+v+'" inputmode="numeric"></td>';
    });
    h+='</tr>';
  });
  $('grid').innerHTML=h;
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function collect(){
  document.querySelectorAll('#grid input').forEach(function(inp){
    var i=+inp.getAttribute('data-i'),n=inp.getAttribute('data-n'),v=parseFloat(inp.value)||0;
    if(!shops[i].order)shops[i].order={};
    if(v)shops[i].order[n]=v; else delete shops[i].order[n];
  });
}
function calc(){
  collect();
  msg('Смятам…');
  api({shops:shops}).then(function(j){
    if(!j.ok){msg('Грешка: '+(j.error||''),'err');return;}
    renderPlan(j); msg('Планът е готов.','ok');
  }).catch(function(e){msg('Мрежова грешка: '+e,'err')});
}
function tbl(title,obj){
  var keys=Object.keys(obj||{});
  if(!keys.length)return '';
  var h='<table><tr><th class="shop">'+title+'</th><th>кол.</th></tr>';
  keys.forEach(function(k){h+='<tr><td class="shop">'+esc(k)+'</td><td class="q">'+obj[k]+'</td></tr>'});
  return h+'</table>';
}
function renderPlan(j){
  $('planbox').innerHTML='<h2>За производство</h2><div class="plan">'+
    tbl('Роли / поке',j.produce_rolls)+tbl('Заготовки',j.produce_zagotovki)+'</div>';
}
</script></body></html>`);
};
