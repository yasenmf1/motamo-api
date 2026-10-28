// lib/salary.js — калкулатор за заплата по трудов договор (чл. 114 КТ), ставки 2026 в EUR.
// Лична страница с ключ: /api/transfer?view=salary&k=<salaryKey>. Смята и в двете посоки (нето ⇄ бруто)
// и от общ разход за работодателя. Сметката е клиентска (JS в страницата), сървърът само връща страницата.
//
// Ставки (проверени срещу ведомост за октомври 2026, нето 1 200 € → бруто 1 546,43 €):
//   служител 13,78 % (ДОО 8,38 + ДЗПО 2,20 + здравно 3,20); ДДФЛ 10 % върху (бруто − осигуровки на служителя);
//   работодател 18,92 % (ДОО 10,92 + ДЗПО 2,80 + ТЗПБ 0,40 за трета категория труд + здравно 4,80).
// Таван на осигурителния доход: 2 300 €/мес (ориентир — точната сума чака счетоводителя; полето в страницата е редактируемо).
// Всяка осигуровка се закръглява поотделно до цент, както във ведомостта.

const crypto = require("crypto");

const salaryKey = () => process.env.PEEK_TOKEN
  ? crypto.createHash("sha256").update("motamo-salary:" + process.env.PEEK_TOKEN).digest("hex").slice(0, 24) : null;

const RATES = {
  emp: { doo: 0.0838, dzpo: 0.022, health: 0.032 },
  tax: 0.10,
  er: { doo: 0.1092, dzpo: 0.028, tzpb: 0.004, health: 0.048 }
};
const r2 = x => Math.round(x * 100 + 1e-9) / 100;

// Пълна разбивка от бруто. cap = таван на осигурителния доход, tzpb = ставка ТЗПБ (0,4 % за трета категория).
function fromGross(gross, cap, tzpb) {
  const ins = Math.min(gross, cap);
  const emp = { doo: r2(ins * RATES.emp.doo), dzpo: r2(ins * RATES.emp.dzpo), health: r2(ins * RATES.emp.health) };
  const empTotal = r2(emp.doo + emp.dzpo + emp.health);
  const base = r2(gross - empTotal);
  const tax = r2(base * RATES.tax);
  const net = r2(gross - empTotal - tax);
  const er = { doo: r2(ins * RATES.er.doo), dzpo: r2(ins * RATES.er.dzpo), tzpb: r2(ins * tzpb), health: r2(ins * RATES.er.health) };
  const erTotal = r2(er.doo + er.dzpo + er.tzpb + er.health);
  return { gross: r2(gross), insurable: r2(ins), emp, empTotal, base, tax, net, er, erTotal, cost: r2(gross + erTotal), totalContrib: r2(empTotal + tax + erTotal) };
}

// Търси бруто, което дава точно това нето (до цента): приближение + проверка на съседните цент-стойности.
function fromNet(net, cap, tzpb) {
  const k = (1 - RATES.tax) * (1 - (RATES.emp.doo + RATES.emp.dzpo + RATES.emp.health));
  let g = net / k;
  if (g > cap) g = net / (1 - RATES.tax) + cap * (RATES.emp.doo + RATES.emp.dzpo + RATES.emp.health);
  g = r2(g);
  for (let d = 0; d <= 5; d++) for (const s of [0, 1, -1]) {
    const cand = r2(g + s * d * 0.01);
    if (fromGross(cand, cap, tzpb).net === r2(net)) return fromGross(cand, cap, tzpb);
  }
  return fromGross(g, cap, tzpb);
}

// От общ разход за работодателя (бруто + вноски на работодателя) към бруто.
function fromCost(cost, cap, tzpb) {
  const erRate = RATES.er.doo + RATES.er.dzpo + tzpb + RATES.er.health;
  let g = cost / (1 + erRate);
  if (g > cap) g = cost - cap * erRate;
  g = r2(g);
  for (let d = 0; d <= 5; d++) for (const s of [0, 1, -1]) {
    const cand = r2(g + s * d * 0.01);
    if (fromGross(cand, cap, tzpb).cost === r2(cost)) return fromGross(cand, cap, tzpb);
  }
  return fromGross(g, cap, tzpb);
}

const page = () => `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Калкулатор за заплата</title>
<style>
:root{--ink:#111;--mut:#666;--line:#e5e5e5;--red:#cc0000;--bg:#fafafa;--card:#fff}
@media(prefers-color-scheme:dark){:root{--ink:#f2f2f2;--mut:#a0a0a0;--line:#333;--bg:#121212;--card:#1c1c1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:4px 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.modes{display:flex;gap:6px;margin-bottom:12px}.modes button{flex:1;padding:10px 6px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;font:inherit;font-weight:600;cursor:pointer}
.modes button[aria-pressed=true]{background:var(--red);border-color:var(--red);color:#fff}
label{display:block;font-size:13px;color:var(--mut);margin:10px 0 4px}
input,select{width:100%;padding:12px;font:inherit;font-size:18px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line)}.row:last-child{border:0}
.row b{font-variant-numeric:tabular-nums;white-space:nowrap}.row span small{display:block;color:var(--mut);font-size:12px}
.big{font-size:20px}.big b{color:var(--red)}h2{font-size:14px;color:var(--mut);margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em}
.note{font-size:12px;color:var(--mut)}
.tm{width:100%;border-collapse:collapse;font-size:14px}.tm th{font-size:11px;color:var(--mut);text-align:right;font-weight:600;padding:4px 2px}.tm th:first-child{text-align:left}
.tm td{padding:4px 2px;border-bottom:1px dashed var(--line);text-align:right;font-variant-numeric:tabular-nums}.tm td:first-child{text-align:left}
.tm input{font-size:14px;padding:6px;width:100%}.tm .nm{min-width:90px}.tm .nt{width:78px;text-align:right}.tm tr.tot td{font-weight:700;border-top:2px solid var(--line);border-bottom:0}
.tm button{border:0;background:none;color:var(--mut);font-size:16px;cursor:pointer}
</style></head><body><main>
<h1>Калкулатор за заплата</h1>
<div class="card">
<div class="modes" role="group" aria-label="Какво въвеждаш">
<button type="button" data-m="net" aria-pressed="true">Нето</button>
<button type="button" data-m="gross" aria-pressed="false">Бруто</button>
<button type="button" data-m="cost" aria-pressed="false">Общ разход</button></div>
<label for="amt" id="amtl">Нетна заплата (€)</label><input id="amt" type="number" inputmode="decimal" step="0.01" min="0" value="1200">
<label for="cap">Таван на осигурителния доход (€/мес)</label><input id="cap" type="number" inputmode="decimal" step="1" min="0" value="2300">
<label for="tz">ТЗПБ (% — трета категория труд 0,4)</label><input id="tz" type="number" inputmode="decimal" step="0.1" min="0" value="0.4">
</div>
<div class="card"><div id="out"></div></div>
<div class="card"><h2>Екип (нето заплати)</h2><div id="team"></div>
<button type="button" id="addrow" style="margin-top:10px;padding:10px 14px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;font:inherit;cursor:pointer">+ Добави човек</button></div>
<p class="note">Ставки 2026 по чл. 114 КТ: служител 13,78 % + ДДФЛ 10 %, работодател 18,92 %. Проверено с ведомост (нето 1 200 € → бруто 1 546,43 €, общ разход 1 839,02 €). Таванът е ориентир — точната сума е от счетоводителя. Без доплащане за стаж.</p>
</main>
<script>
var r2=${r2.toString()};
var RATES=${JSON.stringify(RATES)};
${fromGross.toString()}
${fromNet.toString()}
${fromCost.toString()}
var mode="net";
var fmt=function(x){return x.toLocaleString("bg-BG",{minimumFractionDigits:2,maximumFractionDigits:2})+" €"};
var row=function(t,v,s,c){return '<div class="row'+(c?' '+c:'')+'"><span>'+t+(s?'<small>'+s+'</small>':'')+'</span><b>'+fmt(v)+'</b></div>'};
function run(){
  var a=parseFloat(document.getElementById("amt").value)||0, cap=parseFloat(document.getElementById("cap").value)||0, tz=(parseFloat(document.getElementById("tz").value)||0)/100;
  var r=mode==="net"?fromNet(a,cap,tz):mode==="gross"?fromGross(a,cap,tz):fromCost(a,cap,tz);
  var e=r.emp, w=r.er;
  document.getElementById("out").innerHTML=
   '<h2>Заплата</h2>'+row("Брутна сума",r.gross,"",mode==="gross"?"big":"")+row("Нетна заплата (за получаване)",r.net,"",mode==="net"?"big":"big")+
   '<h2 style="margin-top:14px">Удръжки от служителя</h2>'+
   row("ДОО (пенсии, ОЗМ, безработица) 8,38 %",e.doo)+row("ДЗПО в УПФ 2,20 %",e.dzpo)+row("Здравно осигуряване 3,20 %",e.health)+row("Общо осигуровки на служителя",r.empTotal)+
   row("Данъчна основа",r.base)+row("ДДФЛ 10 %",r.tax)+
   '<h2 style="margin-top:14px">Вноски от работодателя</h2>'+
   row("ДОО 10,92 %",w.doo)+row("ДЗПО в УПФ 2,80 %",w.dzpo)+row("ТЗПБ "+(tz*100).toFixed(2).replace(".",",")+" %",w.tzpb)+row("Здравно осигуряване 4,80 %",w.health)+row("Общо вноски на работодателя",r.erTotal)+
   '<div style="margin-top:10px"></div>'+row("Общ разход за работодателя",r.cost,"бруто + вноски на работодателя",mode==="cost"?"big":"big")+row("Общо вноски и данък към държавата",r.totalContrib,"служител + ДДФЛ + работодател");
}
var TEAM_KEY="motamo-salary-team";
var TEAM0=[["Румена",1200],["Йорданка",1050],["Роксана",1000],["Мария",950],["Станислав",900],["Лидия",850],["Амбър",750],["Христина",750],["Вера",750],["Митьо",850]];
var team=TEAM0;
try{var sv=JSON.parse(localStorage.getItem(TEAM_KEY)||"null");if(Array.isArray(sv)&&sv.length)team=sv;}catch(e){}
function saveTeam(){try{localStorage.setItem(TEAM_KEY,JSON.stringify(team));}catch(e){}}
function renderTeam(){
  var cap=parseFloat(document.getElementById("cap").value)||0, tz=(parseFloat(document.getElementById("tz").value)||0)/100;
  var tn=0,tg=0,tc=0,h='<table class="tm"><tr><th>Име</th><th>Нето</th><th>Бруто</th><th>Разход</th><th></th></tr>';
  team.forEach(function(p,i){
    var n=parseFloat(p[1])||0, r=fromNet(n,cap,tz); tn+=n; tg+=r.gross; tc+=r.cost;
    h+='<tr><td><input class="nm" data-i="'+i+'" data-f="0" value="'+String(p[0]).replace(/"/g,"&quot;")+'"></td><td><input class="nt" data-i="'+i+'" data-f="1" type="number" inputmode="decimal" step="1" value="'+n+'"></td><td>'+fmt(r.gross)+'</td><td>'+fmt(r.cost)+'</td><td><button type="button" data-del="'+i+'" aria-label="Махни">×</button></td></tr>';
  });
  h+='<tr class="tot"><td>Общо ('+team.length+')</td><td>'+fmt(tn)+'</td><td>'+fmt(tg)+'</td><td>'+fmt(tc)+'</td><td></td></tr></table>';
  var host=document.getElementById("team"); var act=document.activeElement, ai=act&&act.getAttribute&&act.getAttribute("data-i"), af=act&&act.getAttribute&&act.getAttribute("data-f");
  host.innerHTML=h;
  if(ai!=null){var el=host.querySelector('input[data-i="'+ai+'"][data-f="'+af+'"]'); if(el){el.focus(); try{el.setSelectionRange(el.value.length,el.value.length);}catch(e){}}}
}
document.getElementById("team").addEventListener("input",function(e){var t=e.target;if(t.getAttribute("data-i")==null)return;var i=+t.getAttribute("data-i"),f=+t.getAttribute("data-f");team[i][f]=f===1?(parseFloat(t.value)||0):t.value;saveTeam();renderTeam();});
document.getElementById("team").addEventListener("click",function(e){var d=e.target.getAttribute&&e.target.getAttribute("data-del");if(d==null)return;team.splice(+d,1);saveTeam();renderTeam();});
document.getElementById("addrow").addEventListener("click",function(){team.push(["Нов",800]);saveTeam();renderTeam();});
document.querySelectorAll(".modes button").forEach(function(b){b.addEventListener("click",function(){
  mode=b.getAttribute("data-m");
  document.querySelectorAll(".modes button").forEach(function(x){x.setAttribute("aria-pressed",String(x===b))});
  document.getElementById("amtl").textContent=mode==="net"?"Нетна заплата (€)":mode==="gross"?"Брутна заплата (€)":"Общ разход за работодателя (€)";
  run();});});
["amt","cap","tz"].forEach(function(i){document.getElementById(i).addEventListener("input",function(){run();renderTeam();})});
run();renderTeam();
</script></body></html>`;

module.exports = { salaryKey, salaryPage: page, fromGross, fromNet, fromCost, RATES };
