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

// ── Автоматично записване на сървъра (Supabase). Таблиците/функциите са в docs/sql/salary_state.sql; без тях страницата
//    продължава да записва на устройството. Достъпът е през SECURITY DEFINER функции с таен ключ (само сървърът го знае).
const TG = require("./telegram.js");
const dbSecret = () => process.env.PEEK_TOKEN
  ? crypto.createHash("sha256").update("motamo-salary-db:" + process.env.PEEK_TOKEN).digest("hex").slice(0, 32) : null;
async function rpc(fn, args) {
  const r = await fetch(`${TG.SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: TG.sbH, body: JSON.stringify(args), signal: AbortSignal.timeout(7000) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { ok: r.ok, status: r.status, data, raw: text };
}
async function dbReady() {
  const sec = dbSecret(); if (!sec) return { ok: false, error: "no_secret" };
  const r = await rpc("sal_init", { p_secret: sec });
  if (!r.ok) return { ok: false, error: "no_db", status: r.status };
  return r.data === true ? { ok: true, sec } : { ok: false, error: "forbidden" };
}
async function dbLoad() {
  const rd = await dbReady(); if (!rd.ok) return rd;
  const r = await rpc("sal_get_all", { p_secret: rd.sec });
  return r.ok ? { ok: true, data: r.data || {} } : { ok: false, error: "db", status: r.status };
}
async function dbSave(key, payload) {
  if (!/^motamo-salary-[0-9A-Za-z-]{1,20}$/.test(String(key || ""))) return { ok: false, error: "bad_key" };
  if (!payload || typeof payload !== "object" || JSON.stringify(payload).length > 200000) return { ok: false, error: "bad_payload" };
  const rd = await dbReady(); if (!rd.ok) return rd;
  const r = await rpc("sal_put", { p_secret: rd.sec, p_key: key, p_payload: payload });
  return r.ok ? { ok: true } : { ok: false, error: "db", status: r.status };
}

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
<meta name="robots" content="noindex,nofollow"><title>Заплати и график</title>
<style>
:root{--ink:#111;--mut:#666;--line:#e5e5e5;--red:#cc0000;--bg:#fafafa;--card:#fff;--off:#ececec;--hol:#ffe3e3}
@media(prefers-color-scheme:dark){:root{--ink:#f2f2f2;--mut:#a0a0a0;--line:#333;--bg:#121212;--card:#1c1c1c;--off:#262626;--hol:#3a1f1f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:820px;margin:0 auto;padding:20px 16px 48px}h1{font-size:22px;margin:4px 0 14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.modes{display:flex;gap:6px;margin-bottom:12px}.modes button{flex:1;padding:10px 6px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;font:inherit;font-weight:600;cursor:pointer}
.modes button[aria-pressed=true]{background:var(--red);border-color:var(--red);color:#fff}
label{display:block;font-size:13px;color:var(--mut);margin:10px 0 4px}
input,select{width:100%;padding:12px;font:inherit;font-size:18px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line)}.row:last-child{border:0}
.row b{font-variant-numeric:tabular-nums;white-space:nowrap}.row span small{display:block;color:var(--mut);font-size:12px}
.big{font-size:20px}.big b{color:var(--red)}h2{font-size:14px;color:var(--mut);margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em}
.note{font-size:12px;color:var(--mut)}
#sync{display:inline-block;margin-left:8px;font-size:12px;font-weight:600;vertical-align:middle;color:var(--mut)}#sync[data-s="ok"]{color:#137333}#sync[data-s="w"]{color:#a06a00}#sync[data-s="err"]{color:var(--red)}
.mh{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}.mh button{width:44px;height:44px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;font-size:20px;cursor:pointer}
.mh .t{text-align:center;font-weight:700;font-size:18px}.mh .t small{display:block;font-weight:400;font-size:13px;color:var(--mut)}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}.cal .h{font-size:11px;color:var(--mut);text-align:center}
.cal button{height:42px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;font:inherit;font-size:15px;cursor:pointer;position:relative}
.cal button.off{background:var(--off);color:var(--mut);text-decoration:line-through}.cal button.hol{background:var(--hol)}
.cal button.hol:after{content:"";position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--red)}
.cal span{height:42px}
.sc{overflow-x:auto}.tm{width:100%;border-collapse:collapse;font-size:13px;min-width:720px}.tm th{font-size:11px;color:var(--mut);text-align:right;font-weight:600;padding:4px 3px}.tm th:first-child{text-align:left}
.tm td{padding:4px 3px;border-bottom:1px dashed var(--line);text-align:right;font-variant-numeric:tabular-nums}.tm td:first-child{text-align:left}
.tm input,.tm select{font-size:14px;padding:6px;width:100%}.tm select{width:86px;text-align:left}.tm select.ty{width:64px}.tm input.man{outline:2px solid #b7a2fa;background:#f3efff;color:#3b1f8c}
.tm .nm{min-width:84px}.tm .nt,.tm .dy,.tm .hr{width:64px;text-align:right}.tm tr.tot td{font-weight:700;border-top:2px solid var(--line);border-bottom:0}
.tm button{border:0;background:none;color:var(--mut);font-size:16px;cursor:pointer}
.sg{border-collapse:collapse;font-size:12px}.sg th,.sg td{padding:0;text-align:center}.sg th{font-size:10px;color:var(--mut);font-weight:600;min-width:27px}
.sg th.we{color:var(--red)}.sg th.wk,.sg td.wk{border-left:2px solid var(--line)}
.sg .nm{position:sticky;left:0;background:var(--card);text-align:left;padding:0 8px 0 0;min-width:96px;font-size:13px;z-index:1}.sg .nm small{display:block;font-size:10px;color:var(--mut)}
.sg td.c button{width:26px;height:26px;margin:1px;border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--ink);font:inherit;font-size:10px;font-weight:700;cursor:pointer;padding:0}
.sg td.c.we button{background:var(--off)}
.sg td.c button[data-c="Р"]{background:#c9f0d3;border-color:#9bdcae;color:#14532d}.sg td.c button[data-c^="Р+"]{background:#e3d9ff;border-color:#b7a2fa;color:#3b1f8c}
.sg td.c button[data-c="4"]{background:#ffe0b8;border-color:#f7c58a;color:#7a4300}.sg td.c button[data-c="6"]{background:#fff4b3;border-color:#f0dd7a;color:#6b5800}
.sg td.c button[data-c="О"]{background:#bff0eb;border-color:#86dcd3;color:#0b5c55}.sg td.c button[data-c="БО"]{background:#ffc9c4;border-color:#f59a92;color:#7a1410}
.sg td.c button[data-x="1"]{background:#e3d9ff;border-color:#b7a2fa;color:#3b1f8c;box-shadow:inset 0 0 0 1px #8f73f5}
.sg td.t{padding:0 5px;font-variant-numeric:tabular-nums;color:var(--mut);font-size:12px}.sg td.t b{color:var(--ink)}
.card.light,#pick{--card:#ffffff;--ink:#14161a;--line:#dcdee4;--off:#eef0f4;--mut:#5f6570;--hol:#ffe6e6;color:var(--ink)}
.card.light{background:#ffffff}
.sg th.today{background:#fff3c4;color:#111;border-radius:6px}.sg td.c.today button{box-shadow:inset 0 0 0 1px #e0b400}
.sg{user-select:none}.sg .pk{cursor:pointer}.sg th.pk:hover,.sg td.nm.pk:hover{color:var(--red)}
.sg td.c button.sel{box-shadow:0 0 0 2px var(--red);position:relative;z-index:2}
#selbar{position:fixed;left:50%;transform:translateX(-50%);bottom:14px;z-index:60;background:var(--ink);color:var(--bg);border-radius:14px;padding:10px 14px;display:flex;gap:10px;align-items:center;box-shadow:0 8px 28px rgba(0,0,0,.35);max-width:94vw}
#selbar b{font-variant-numeric:tabular-nums}#selbar button{padding:9px 12px;border-radius:9px;border:1px solid rgba(128,128,128,.5);background:var(--red);color:#fff;font:inherit;font-weight:700;cursor:pointer}
#selbar button.g{background:transparent;color:inherit;font-weight:400}
.btn2[aria-pressed=true]{background:var(--red);border-color:var(--red);color:#fff}
#pick{position:fixed;z-index:50;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.35);padding:6px;min-width:230px;max-height:80vh;overflow:auto}
#pick .pt{font-size:12px;color:var(--mut);padding:6px 10px 4px}
#pick button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:11px 10px;border:0;background:none;color:var(--ink);font:inherit;font-size:16px;border-radius:8px;cursor:pointer}
#pick button:hover,#pick button:focus{background:var(--off);outline:none}#pick button[aria-current]{font-weight:700}
#pick i{width:20px;height:20px;border-radius:5px;border:1px solid var(--line);flex:none}
#pick i[data-c="Р"]{background:#c9f0d3;border-color:#9bdcae}#pick i[data-c^="Р+"]{background:#e3d9ff;border-color:#b7a2fa}#pick i[data-c="4"]{background:#ffe0b8;border-color:#f7c58a}#pick i[data-c="6"]{background:#fff4b3;border-color:#f0dd7a}
#pick i[data-c="О"]{background:#bff0eb;border-color:#86dcd3}#pick i[data-c="БО"]{background:#ffc9c4;border-color:#f59a92}
.btn2{padding:10px 14px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;font:inherit;cursor:pointer}
.hint{font-size:12px;color:var(--mut);margin:8px 0 0}.pair{display:flex;gap:10px}.pair>div{flex:1}
</style></head><body><main>
<h1>Заплати и график <small id="sync" data-s="">Зареждам…</small></h1>

<div class="card">
<div class="mh"><button type="button" id="mp" aria-label="Предишен месец">‹</button><div class="t" id="mt"></div><button type="button" id="mn" aria-label="Следващ месец">›</button></div>
<div class="cal" id="cal"></div>
<p class="hint">Календарът показва работните дни на смяна Пн–Пт; за смяна Нд–Чт (Йорданка, Христина, Амбър) дните се броят отделно. Натисни ден, за да го направиш почивен или работен за всички. Празниците са с червена точка (2026, с компенсираните дни).</p>
</div>

<div class="card"><h2>Екип за месеца</h2>
<div class="pair"><div><label for="cf">Коефициент за ръчно въведени допълнителни часове (бонус)</label>
<select id="cf"><option value="1">×1 — бонус (нормален час)</option><option value="2">×2 — официален празник</option></select></div>
<div><label for="cap">Таван на осигурителния доход (€)</label><input id="cap" type="number" inputmode="decimal" step="1" min="0" value="2300"></div></div>
<div class="sc" id="team" style="margin-top:10px"></div>
<button type="button" class="btn2" id="addrow" style="margin-top:10px">+ Добави човек</button>
<p class="hint">Заплатите се смятат <b>автоматично от графика по-долу</b>. „Заплата“ е за пълен месец (по договор): избери <b>нето</b> или <b>бруто</b> до числото. „Смяна“ — Пн–Пт или Нд–Чт. „Дни“ и „Доп. ч“ се попълват от графика; ако въведеш число тук, то има предимство (клетката става лилава, а „↺“ връща автоматичното). Допълнителните часове се плащат по часова ставка = бруто ÷ (работни дни × 8): <b>бонус като нормален час (×1)</b> за допълнителни часове в работен ден, <b>×2 на празник</b>. Работа в почивен ден (Пн–Пт) също е бонус по нормална ставка. Смяна <b>Нд–Чт е на сумирано работно време</b>: неделя е нормален работен ден, всички часове се събират за месеца и само над нормата (работни дни × 8) се плащат като бонус (нормален час).</p>
</div>

<div class="card light"><h2>График за месеца</h2>
<div class="sc" id="sched"></div>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button type="button" class="btn2" id="selmode" aria-pressed="false">☑ Избор на няколко</button><button type="button" class="btn2" id="fillw">Попълни Р до днес</button><button type="button" class="btn2" id="clrs">Изчисти графика</button><button type="button" class="btn2" id="schbtn" style="background:var(--red);border-color:var(--red);color:#fff;font-weight:700">📄 Свали графика (PDF)</button><span id="schstat" class="hint" style="align-self:center;margin:0"></span></div>
<p class="hint">Натисни клетка и избери от менюто: <b>Р</b> — редовна смяна (8 ч); <b>Р+1…Р+4</b> — редовна смяна и допълнителни часове (<b>оцветени в лилаво</b>, бонус — нормален час); <b>4 ч / 6 ч</b> — по-кратка смяна; <b>О</b> — платен отпуск (8 ч); <b>БО</b> — болничен (не се плаща от нас, плаща НОИ); или празно. Работа на празник (×2) се брои изцяло като допълнителен труд, а в почивен ден за смяна Пн–Пт — като бонус по нормална ставка (×1); и двете са в лилаво; при Нд–Чт часовете в петък и събота влизат в месечната сума. „Попълни Р“ слага Р на работните дни на всеки според смяната му (Пн–Пт или Нд–Чт) — в текущия месец само <b>до днес</b>, дните напред остават празни; в други месеци — целия месец. Седмицата е от понеделник; линията отляво отделя седмиците.</p>
<p class="hint"><b>Бързо попълване:</b> с мишката плъзни по клетките, за да ги избереш (или Shift/Ctrl + натискане). На телефон включи „☑ Избор на няколко“ и докосвай клетките. Натисни <b>името</b>, за да избереш целия му месец, или <b>датата</b> горе, за да избереш деня за всички. После от лентата отдолу избери какво да се постави във всички избрани клетки.</p>
</div>

<div class="card"><h2>Оборотна ведомост за заплатите</h2>
<p class="hint" style="margin:0 0 10px">Ведомост за избрания месец: отработени дни, отпуск, болничен, допълнителни часове, бруто, осигуровки, ДДФЛ, нето, вноски на работодателя и общ разход за всеки, с общо. Сваля се като PDF (A4, на ширина).</p>
<button type="button" class="btn2" id="pdfbtn" style="background:var(--red);border-color:var(--red);color:#fff;font-weight:700">📄 Свали ведомост (PDF)</button>
<span id="pdfstat" class="hint" style="margin-left:10px"></span>
</div>

<div class="card"><h2>Единичен калкулатор</h2>
<div class="modes" role="group" aria-label="Какво въвеждаш">
<button type="button" data-m="net" aria-pressed="true">Нето</button>
<button type="button" data-m="gross" aria-pressed="false">Бруто</button>
<button type="button" data-m="cost" aria-pressed="false">Общ разход</button></div>
<label for="amt" id="amtl">Нетна заплата (€)</label><input id="amt" type="number" inputmode="decimal" step="0.01" min="0" value="1200">
<label for="tz">ТЗПБ (% — трета категория труд 0,4)</label><input id="tz" type="number" inputmode="decimal" step="0.1" min="0" value="0.4">
<div id="out" style="margin-top:12px"></div></div>

<p class="note">Ставки 2026 по чл. 114 КТ: служител 13,78 % + ДДФЛ 10 %, работодател 18,92 %. Проверено с ведомост (нето 1 200 € → бруто 1 546,43 €, общ разход 1 839,02 €). Таванът е ориентир — точната сума е от счетоводителя. Допълнителните часове се плащат като бонус по нормална часова ставка (×1), а празничният труд ×2 — провери със счетоводителя как е уговорено в договорите (по чл. 262 КТ минимумът за извънреден труд е по-висок). Без доплащане за стаж.</p>
</main>
<script>
var r2=${r2.toString()};
var RATES=${JSON.stringify(RATES)};
${fromGross.toString()}
${fromNet.toString()}
${fromCost.toString()}
var fmt=function(x){return x.toLocaleString("bg-BG",{minimumFractionDigits:2,maximumFractionDigits:2})+" €"};
var esc=function(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")};
function ld(k,d){try{var v=JSON.parse(localStorage.getItem(k)||"null");return v==null?d:v;}catch(e){return d;}}
var T_PREFIX="motamo-salary-t:", dirty={}, syncTmr=null, serverOn=false;
function pad2(n){return n<10?"0"+n:""+n;}
function hhmm(){var d=new Date(); return pad2(d.getHours())+":"+pad2(d.getMinutes());}
function setSync(t,cls){var e=document.getElementById("sync"); if(e){e.textContent=t; e.setAttribute("data-s",cls||"");}}
function apiUrl(op){return location.pathname+location.search+(location.search?"&":"?")+"op="+op;}
function sv(k,v){
  try{localStorage.setItem(k,JSON.stringify(v)); localStorage.setItem(T_PREFIX+k,String(Date.now()));}catch(e){}
  dirty[k]=1; setSync("Записвам…","w"); scheduleSync(900);
}
function scheduleSync(ms){clearTimeout(syncTmr); syncTmr=setTimeout(syncNow,ms);}
function syncNow(){
  var keys=Object.keys(dirty); if(!keys.length)return Promise.resolve();
  if(!serverOn){ dirty={}; setSync("✓ Записано на това устройство "+hhmm(),"ok"); return Promise.resolve(); }
  dirty={};
  return Promise.all(keys.map(function(k){
    var v=null,t=Date.now(); try{v=JSON.parse(localStorage.getItem(k)||"null"); t=Number(localStorage.getItem(T_PREFIX+k)||t);}catch(e){}
    return fetch(apiUrl("save"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:k,payload:{_t:t,v:v}}),keepalive:true})
      .then(function(r){return r.json();}).then(function(j){if(!j.ok)throw new Error(j.error||"x");});
  })).then(function(){setSync("✓ Записано "+hhmm()+" (и на сървъра)","ok");})
  .catch(function(){keys.forEach(function(k){dirty[k]=1;}); setSync("⚠ Записано на това устройство; сървърът не отговаря — пробвам пак…","err"); scheduleSync(8000);});
}
function localKeys(){var ks=[]; try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i); if(k&&k.indexOf("motamo-salary-")===0&&k.indexOf(T_PREFIX)!==0)ks.push(k);}}catch(e){} return ks;}
function pullServer(){
  return fetch(apiUrl("load"),{cache:"no-store"}).then(function(r){return r.json();}).then(function(j){
    if(!j||!j.ok){ serverOn=false; setSync("✓ Автоматично записване на това устройство","ok"); return; }
    serverOn=true; var srv=j.data||{}, changed=false;
    Object.keys(srv).forEach(function(k){
      var pl=(srv[k]&&srv[k].payload)||{}, sT=Number(pl._t||0), lT=Number(localStorage.getItem(T_PREFIX+k)||0);
      if(sT>lT){ try{localStorage.setItem(k,JSON.stringify(pl.v)); localStorage.setItem(T_PREFIX+k,String(sT));}catch(e){} changed=true; }
      else if(lT>sT){ dirty[k]=1; }
    });
    localKeys().forEach(function(k){ if(!srv[k])dirty[k]=1; });
    if(changed&&typeof reloadState==="function")reloadState();
    if(Object.keys(dirty).length)syncNow(); else setSync("✓ Синхронизирано със сървъра "+hhmm(),"ok");
  }).catch(function(){ serverOn=false; setSync("✓ Автоматично записване на това устройство","ok"); });
}
window.addEventListener("pagehide",function(){ if(Object.keys(dirty).length)syncNow(); });
function cfg(){return {cap:parseFloat(document.getElementById("cap").value)||0, tz:(parseFloat(document.getElementById("tz").value)||0)/100};}

/* ── единичен калкулатор ── */
var mode="net";
var row=function(t,v,s,c){return '<div class="row'+(c?' '+c:'')+'"><span>'+t+(s?'<small>'+s+'</small>':'')+'</span><b>'+fmt(v)+'</b></div>'};
function run(){
  var a=parseFloat(document.getElementById("amt").value)||0, c=cfg(), cap=c.cap, tz=c.tz;
  var r=mode==="net"?fromNet(a,cap,tz):mode==="gross"?fromGross(a,cap,tz):fromCost(a,cap,tz);
  var e=r.emp, w=r.er;
  document.getElementById("out").innerHTML=
   '<h2>Заплата</h2>'+row("Брутна сума",r.gross,"",mode==="gross"?"big":"")+row("Нетна заплата (за получаване)",r.net,"","big")+
   '<h2 style="margin-top:14px">Удръжки от служителя</h2>'+
   row("ДОО (пенсии, ОЗМ, безработица) 8,38 %",e.doo)+row("ДЗПО в УПФ 2,20 %",e.dzpo)+row("Здравно осигуряване 3,20 %",e.health)+row("Общо осигуровки на служителя",r.empTotal)+
   row("Данъчна основа",r.base)+row("ДДФЛ 10 %",r.tax)+
   '<h2 style="margin-top:14px">Вноски от работодателя</h2>'+
   row("ДОО 10,92 %",w.doo)+row("ДЗПО в УПФ 2,80 %",w.dzpo)+row("ТЗПБ "+(tz*100).toFixed(2).replace(".",",")+" %",w.tzpb)+row("Здравно осигуряване 4,80 %",w.health)+row("Общо вноски на работодателя",r.erTotal)+
   '<div style="margin-top:10px"></div>'+row("Общ разход за работодателя",r.cost,"бруто + вноски на работодателя","big")+row("Общо вноски и данък към държавата",r.totalContrib,"служител + ДДФЛ + работодател");
}
document.querySelectorAll(".modes button").forEach(function(b){b.addEventListener("click",function(){
  mode=b.getAttribute("data-m");
  document.querySelectorAll(".modes button").forEach(function(x){x.setAttribute("aria-pressed",String(x===b))});
  document.getElementById("amtl").textContent=mode==="net"?"Нетна заплата (€)":mode==="gross"?"Брутна заплата (€)":"Общ разход за работодателя (€)";
  run();});});

/* ── календар и работни дни ── */
var MONTHS=["Януари","Февруари","Март","Април","Май","Юни","Юли","Август","Септември","Октомври","Ноември","Декември"];
// Неработни дни по закон за 2026 (с компенсираните): Нова година, 3 март, Разпети/Великден (10–13.04), 1 и 6 май, 24 май → пн 25.05,
// 6 септ. (нд) → пн 7.09, 22 септ., Бъдни вечер/Коледа 24–26.12 (сб 26.12 → пн 28.12).
// Включени са и самите празнични дати, които падат в събота/неделя (11–12.04, 24.05, 6.09, 26.12) — важно за смяна Нд–Чт и за работа в празник (×2).
var HOL26=["2026-01-01","2026-03-03","2026-04-10","2026-04-11","2026-04-12","2026-04-13","2026-05-01","2026-05-06","2026-05-24","2026-05-25","2026-09-06","2026-09-07","2026-09-22","2026-12-24","2026-12-25","2026-12-26","2026-12-28"];
var HOLFIX=["01-01","03-03","05-01","05-06","05-24","09-06","09-22","12-24","12-25","12-26"];
function pad(n){return n<10?"0"+n:""+n;}
function isHol(y,m,d){var k=y+"-"+pad(m+1)+"-"+pad(d);return y===2026?HOL26.indexOf(k)>=0:HOLFIX.indexOf(pad(m+1)+"-"+pad(d))>=0;}
var now=new Date(); var cur={y:now.getFullYear(),m:now.getMonth()};
function mk(){return "motamo-salary-"+cur.y+"-"+pad(cur.m+1);}
var st={ov:{},p:{},s:{}};                       // ov: ден→"w"|"o" (ръчно, за всички); p: индекс на човек → {d,h}; s: график
function migrateCode(c){return c==="ГО"?"О":c==="10"?"Р+2":c==="12"?"Р+4":c;}
function loadMonth(){
  st=ld(mk(),{ov:{},p:{},s:{}}); if(!st.ov)st.ov={}; if(!st.p)st.p={}; if(!st.s)st.s={};
  Object.keys(st.s).forEach(function(i){Object.keys(st.s[i]).forEach(function(d){st.s[i][d]=migrateCode(st.s[i][d]);});});
}
function saveMonth(){sv(mk(),st);}
/* kind на деня за смяна pat: "work" (редовен работен ден), "rest" (почивен), "hol" (празник) */
function dayKind(d,pat){
  var dow=new Date(cur.y,cur.m,d).getDay();
  if(st.ov[d]==="o") return isHol(cur.y,cur.m,d)?"hol":"rest";
  if(st.ov[d]==="w") return "work";
  if(isHol(cur.y,cur.m,d)) return "hol";
  var w = pat==="su" ? (dow>=0&&dow<=4) : (dow>=1&&dow<=5);
  return w?"work":"rest";
}
function workDaysFor(pat){var n=0,dm=new Date(cur.y,cur.m+1,0).getDate();for(var d=1;d<=dm;d++)if(dayKind(d,pat)==="work")n++;return n;}
var PATS={mf:"Пн–Пт",su:"Нд–Чт"};
function renderCal(){
  var dm=new Date(cur.y,cur.m+1,0).getDate(), first=(new Date(cur.y,cur.m,1).getDay()+6)%7, a=workDaysFor("mf"), b=workDaysFor("su");
  document.getElementById("mt").innerHTML=MONTHS[cur.m]+" "+cur.y+"<small>работни дни: <b>"+a+"</b> (Пн–Пт) · <b>"+b+"</b> (Нд–Чт) · норма "+(a*8)+" / "+(b*8)+" ч</small>";
  var h="",n=["Пн","Вт","Ср","Чт","Пт","Сб","Нд"];
  n.forEach(function(x){h+='<div class="h">'+x+'</div>';});
  for(var i=0;i<first;i++)h+="<span></span>";
  for(var d=1;d<=dm;d++){
    var k=dayKind(d,"mf"), cl=(k==="work"?"":"off")+(isHol(cur.y,cur.m,d)?" hol":"");
    h+='<button type="button" class="'+cl+'" data-d="'+d+'" aria-pressed="'+(k==="work")+'" aria-label="'+d+' '+MONTHS[cur.m]+(k==="work"?' работен':' почивен')+'">'+d+'</button>';
  }
  document.getElementById("cal").innerHTML=h;
}
function natWork(d,pat){var s=st.ov[d]; delete st.ov[d]; var k=dayKind(d,pat); if(s)st.ov[d]=s; return k==="work";}   // работен ли е денят без ръчна промяна
document.getElementById("cal").addEventListener("click",function(e){
  var b=e.target.closest&&e.target.closest("button[data-d]"); if(!b)return;
  var d=+b.getAttribute("data-d"), isW=dayKind(d,"mf")==="work", nat=natWork(d,"mf");
  if(isW){ if(nat)st.ov[d]="o"; else delete st.ov[d]; } else { if(!nat)st.ov[d]="w"; else delete st.ov[d]; }
  saveMonth(); renderAll();
});
function shift(n){cur.m+=n;if(cur.m<0){cur.m=11;cur.y--;}if(cur.m>11){cur.m=0;cur.y++;}loadMonth();renderAll();}
document.getElementById("mp").addEventListener("click",function(){shift(-1)});
document.getElementById("mn").addEventListener("click",function(){shift(1)});

/* ── екип ── */
var TEAM_KEY="motamo-salary-team";
var SU_NAMES=["Йорданка","Христина","Амбър"];       // работят от неделя до четвъртък
var team=[];
function initTeam(){
  team=ld(TEAM_KEY,null);
  if(!Array.isArray(team)||!team.length)team=[["Румена",1200],["Йорданка",1050],["Роксана",1000],["Мария",950],["Станислав",900],["Лидия",850],["Амбър",750],["Христина",750],["Вера",750],["Митьо",850]];
  team.forEach(function(p){ if(p[2]!=="mf"&&p[2]!=="su") p[2]=SU_NAMES.indexOf(String(p[0]).trim())>=0?"su":"mf"; if(p[3]!=="gross")p[3]="net"; });
}
initTeam();
function reloadState(){ initTeam(); sel={}; loadMonth(); renderAll(); }
function pfor(i){return st.p[i]||(st.p[i]={});}

/* ── график: часове по код ── */
function sc(i,d){return (st.s[i]&&st.s[i][d])||"";}
function hoursOf(code){var m; if(!code||code==="О"||code==="БО")return 0; if(code==="Р")return 8; if((m=/^Р[+]([0-9]+)$/.exec(code)))return 8+(+m[1]); if(/^[0-9]+$/.test(code))return +code; return 0;}
function extraOf(code){var m=/^Р[+]([0-9]+)$/.exec(code||""); return m?+m[1]:0;}
/* има ли клетката допълнителни часове (за оцветяване): Р+N, работа на празник, работа в почивен ден (при Пн–Пт; Нд–Чт са на сумирано) */
function cellExtra(code,kind,pat){
  if(!code||code==="О"||code==="БО")return false;
  if(extraOf(code)>0)return true;
  if(kind==="hol")return hoursOf(code)>0;
  if(pat!=="su"&&kind==="rest")return hoursOf(code)>0;
  return false;
}
/* Правила (собственикът, 28.10):
   • Пн–Пт: допълнителните часове в РАБОТЕН ден (Р+N) са БОНУС по нормална часова ставка (×1); работа в почивен ден — също бонус (×1); на празник ×2.
   • Нд–Чт са на СУМИРАНО работно време: неделя е нормален работен ден, всички часове (и в пт/сб) се събират за месеца;
     само над нормата (работни дни × 8) се плащат като бонус по нормална часова ставка (×1); празничните часове са ×2.
   • О — платен отпуск (8 ч), БО — болничен (не се плаща от нас). */
function schedTot(i){
  var pat=team[i][2], dm=new Date(cur.y,cur.m+1,0).getDate(), norm=workDaysFor(pat)*8;
  var t={days:0,leave:0,sick:0,reg:0,bonusH:0,restH:0,holH:0,ext:0,bonusW:0,otherW:0,extW:0,hours:0,any:false}, sumH=0, leaveH=0;
  for(var d=1;d<=dm;d++){
    var c=sc(i,d); if(!c)continue; t.any=true;
    var kind=dayKind(d,pat), h=hoursOf(c);
    if(c==="БО"){ if(kind==="work")t.sick++; continue; }
    if(c==="О"){ if(kind==="work"){leaveH+=8;t.leave++;} continue; }
    if(h>0)t.days++;
    if(kind==="hol"){ t.holH+=h; continue; }
    if(pat==="su"){ sumH+=h; continue; }
    if(kind==="work"){ var x=extraOf(c); t.reg+=h-x; t.bonusH+=x; }
    else { t.bonusH+=h; }                     // работа в почивен ден — също бонус по нормална ставка
  }
  if(pat==="su"){ var tot=sumH+leaveH; t.reg=Math.min(tot,norm); t.bonusH=Math.max(0,tot-norm); }
  else t.reg+=leaveH;
  t.ext=t.bonusH+t.restH+t.holH;
  t.bonusW=t.bonusH; t.otherW=t.holH*2; t.extW=t.bonusW+t.otherW;
  t.hours=t.reg+t.ext;
  return t;
}
/* заплата на човек от графика (или от ръчно въведените „Дни“/„Доп. ч“, които имат предимство и се броят като бонус) */
function calcPerson(i,c,coef){
  var p=team[i], pat=p[2], wd=workDaysFor(pat), net=parseFloat(p[1])||0, pr=st.p[i]||{};
  var sch=schedTot(i), norm=wd*8;
  var autoD=sch.any&&norm>0?wd*Math.min(sch.reg,norm)/norm:wd, autoH=sch.any?sch.ext:0;
  var manD=pr.d!=null&&pr.d!=="", manH=pr.h!=null&&pr.h!=="";
  var days=manD?Math.max(0,Math.min(+pr.d||0,wd)):autoD, hrs=manH?Math.max(0,+pr.h||0):autoH;
  var full=(p[3]==="gross"?fromGross(net,c.cap,c.tz):fromNet(net,c.cap,c.tz)), hourly=wd>0?full.gross/(wd*8):0, base=wd>0?full.gross*days/wd:0;
  var bonus=manH?hourly*hrs*coef:hourly*sch.bonusW, other=manH?0:hourly*sch.otherW;
  return {name:p[0], pat:pat, wd:wd, net:net, full:full, pr:pr, autoD:autoD, autoH:autoH, manD:manD, manH:manH, days:days, hrs:hrs, sch:sch, base:r2(base), bonus:r2(bonus), other:r2(other), extra:r2(bonus+other), r:fromGross(r2(base+bonus+other),c.cap,c.tz)};
}
function renderTeam(){
  var c=cfg(), coef=parseFloat(document.getElementById("cf").value)||1.5;
  var tn=0,tg=0,tt=0,tc=0;
  var h='<table class="tm"><tr><th>Име</th><th>Смяна</th><th>Заплата/мес.</th><th>Дни</th><th>Доп. ч</th><th>Допл. €</th><th>Бруто</th><th>За получаване</th><th>Разход</th><th></th></tr>';
  team.forEach(function(p,i){
    var P=calcPerson(i,c,coef), net=P.net, pr=P.pr, r=P.r;
    tn+=P.full.net; tg+=r.gross; tt+=r.net; tc+=r.cost;
    h+='<tr><td><input class="nm" data-i="'+i+'" data-f="n" value="'+esc(p[0])+'"></td>'
     +'<td><select data-i="'+i+'" data-f="pat" aria-label="Смяна"><option value="mf"'+(P.pat==="mf"?" selected":"")+'>Пн–Пт</option><option value="su"'+(P.pat==="su"?" selected":"")+'>Нд–Чт</option></select></td>'
     +'<td style="white-space:nowrap"><input class="nt" data-i="'+i+'" data-f="net" type="number" inputmode="decimal" step="0.01" value="'+net+'"> <select class="ty" data-i="'+i+'" data-f="typ" aria-label="Нето или бруто"><option value="net"'+(p[3]==="gross"?"":" selected")+'>нето</option><option value="gross"'+(p[3]==="gross"?" selected":"")+'>бруто</option></select></td>'
     +'<td><input class="dy'+(P.manD?" man":"")+'" data-i="'+i+'" data-f="d" type="number" inputmode="numeric" step="0.5" min="0" max="'+P.wd+'" placeholder="'+(Math.round(P.autoD*10)/10)+'" value="'+(P.manD?pr.d:"")+'"></td>'
     +'<td><input class="hr'+(P.manH?" man":"")+'" data-i="'+i+'" data-f="h" type="number" inputmode="decimal" step="0.5" min="0" placeholder="'+(Math.round(P.autoH*10)/10)+'" value="'+(P.manH?pr.h:"")+'"></td>'
     +'<td>'+(P.extra?fmt(P.extra):"")+'</td><td>'+fmt(r.gross)+'</td><td><b>'+fmt(r.net)+'</b></td><td>'+fmt(r.cost)+'</td><td>'+((P.manD||P.manH)?'<button type="button" data-auto="'+i+'" title="Ръчно въведено — върни автоматичното от графика" aria-label="Върни автоматичното" style="color:#7a5af8;font-weight:700">↺</button> ':'')+'<button type="button" data-del="'+i+'" aria-label="Махни">×</button></td></tr>';
  });
  h+='<tr class="tot"><td>Общо ('+team.length+')</td><td></td><td>'+fmt(tn)+'</td><td></td><td></td><td></td><td>'+fmt(tg)+'</td><td>'+fmt(tt)+'</td><td>'+fmt(tc)+'</td><td></td></tr></table>';
  var host=document.getElementById("team"), act=document.activeElement, ai=act&&act.getAttribute?act.getAttribute("data-i"):null, af=act&&act.getAttribute?act.getAttribute("data-f"):null;
  host.innerHTML=h;
  if(ai!=null&&af!=="pat"){var el=host.querySelector('input[data-i="'+ai+'"][data-f="'+af+'"]'); if(el){el.focus(); try{el.setSelectionRange(el.value.length,el.value.length);}catch(e){}}}
}
document.getElementById("team").addEventListener("input",function(e){
  var t=e.target, i=t.getAttribute("data-i"); if(i==null)return; i=+i; var f=t.getAttribute("data-f");
  if(f==="n"){team[i][0]=t.value;sv(TEAM_KEY,team);}
  else if(f==="net"){team[i][1]=parseFloat(t.value)||0;sv(TEAM_KEY,team);}
  else if(f==="typ"){team[i][3]=t.value==="gross"?"gross":"net";sv(TEAM_KEY,team);renderAll();return;}
  else if(f==="pat"){team[i][2]=t.value==="su"?"su":"mf";sv(TEAM_KEY,team);renderAll();return;}
  else{pfor(i)[f]=t.value;saveMonth();}
  renderTeam(); renderSched();
});
document.getElementById("team").addEventListener("click",function(e){
  var au=e.target.getAttribute&&e.target.getAttribute("data-auto");
  if(au!=null){ var pr=st.p[+au]; if(pr){delete pr.d; delete pr.h;} saveMonth(); renderAll(); return; }
  var d=e.target.getAttribute&&e.target.getAttribute("data-del"); if(d==null)return;
  if(!confirm("Махаш ли този човек от списъка?"))return;
  team.splice(+d,1); st.p={}; st.s={}; sv(TEAM_KEY,team); saveMonth(); renderAll();
});
document.getElementById("addrow").addEventListener("click",function(){team.push(["Нов",800,"mf","net"]);sv(TEAM_KEY,team);renderAll();});

/* ── график ── */
function isToday(d){var n=new Date(); return n.getFullYear()===cur.y&&n.getMonth()===cur.m&&n.getDate()===d;}
function renderSched(){
  var dm=new Date(cur.y,cur.m+1,0).getDate(), D=["Нд","Пн","Вт","Ср","Чт","Пт","Сб"];
  var h='<table class="sg"><tr><th class="nm"></th>';
  for(var d=1;d<=dm;d++){var w=new Date(cur.y,cur.m,d).getDay(); h+='<th class="pk '+(w===1?"wk ":"")+(isToday(d)?"today":"")+'" data-col="'+d+'" title="Избери деня за всички">'+D[w]+'<br>'+d+'</th>';}
  h+='<th class="t">Дни</th><th class="t">О</th><th class="t">БО</th><th class="t">Доп. ч</th><th class="t">Часове</th></tr>';
  team.forEach(function(p,i){
    var t=schedTot(i);
    h+='<tr><td class="nm pk" data-row="'+i+'" title="Избери целия месец">'+esc(p[0])+'<small>'+PATS[p[2]]+'</small></td>';
    for(var d=1;d<=dm;d++){var w=new Date(cur.y,cur.m,d).getDay(), c=sc(i,d), k=dayKind(d,p[2]);
      h+='<td class="c'+(k==="work"?"":" we")+(w===1?" wk":"")+(isToday(d)?" today":"")+'"><button type="button" class="'+(sel[i+":"+d]?"sel":"")+'" data-si="'+i+'" data-sd="'+d+'" data-c="'+c+'" data-x="'+(cellExtra(c,k,p[2])?"1":"")+'" aria-label="'+esc(p[0])+' '+d+'">'+c+'</button></td>';}
    h+='<td class="t"><b>'+t.days+'</b></td><td class="t">'+(t.leave||"")+'</td><td class="t">'+(t.sick||"")+'</td><td class="t">'+(t.ext?String(Math.round(t.ext*10)/10).replace(".",","):"")+'</td><td class="t"><b>'+t.hours+'</b></td></tr>';
  });
  document.getElementById("sched").innerHTML=h+"</table>";
}
var PICK=[["Р","Р — редовна смяна (8 ч)"],["Р+1","Р + 1 час допълнително (бонус)"],["Р+2","Р + 2 часа допълнително (бонус)"],["Р+3","Р + 3 часа допълнително (бонус)"],["Р+4","Р + 4 часа допълнително (бонус)"],["4","4 часа (кратка смяна)"],["6","6 часа (кратка смяна)"],["О","О — платен отпуск"],["БО","БО — болничен"],["","— Празно"]], pickAt=null;
function closePick(){var m=document.getElementById("pick"); if(m)m.parentNode.removeChild(m); pickAt=null;}
function applyPick(i,d,c){if(!st.s[i])st.s[i]={}; if(c)st.s[i][d]=c; else delete st.s[i][d]; saveMonth(); renderTeam(); renderSched();}
/* ── избор на няколко клетки ── */
var sel={}, selMode=false, drag=null, justDragged=false;
function selCount(){return Object.keys(sel).length;}
function paintSel(){
  document.querySelectorAll("#sched button[data-si]").forEach(function(b){b.classList.toggle("sel",!!sel[b.getAttribute("data-si")+":"+b.getAttribute("data-sd")]);});
  var bar=document.getElementById("selbar"), n=selCount();
  if(!n){ if(bar)bar.parentNode.removeChild(bar); return; }
  if(!bar){
    bar=document.createElement("div"); bar.id="selbar";
    bar.innerHTML='<span>Избрани: <b id="selcnt"></b></span><button type="button" id="selapply">Постави…</button><button type="button" class="g" id="selclear">Откажи</button>';
    document.body.appendChild(bar);
    document.getElementById("selapply").addEventListener("click",function(ev){ev.stopPropagation(); openMenu(this.getBoundingClientRect(),"Избрани клетки: "+selCount(),"един избор за всички избрани",null,applyMany,true);});
    document.getElementById("selclear").addEventListener("click",function(){clearSel();});
  }
  document.getElementById("selcnt").textContent=n;
}
function clearSel(){sel={}; paintSel();}
function selRange(a,b){
  var i0=Math.min(a.i,b.i), i1=Math.max(a.i,b.i), d0=Math.min(a.d,b.d), d1=Math.max(a.d,b.d); sel={};
  for(var i=i0;i<=i1;i++)for(var d=d0;d<=d1;d++)sel[i+":"+d]=true;
}
function applyMany(v){
  Object.keys(sel).forEach(function(k){var q=k.split(":"), i=+q[0], d=+q[1]; if(!st.s[i])st.s[i]={}; if(v)st.s[i][d]=v; else delete st.s[i][d];});
  sel={}; saveMonth(); renderAll();
}
/* меню: за една клетка или за всички избрани (up = отваря се над бутона) */
function openMenu(r,title,kindText,cur0,onChoose,up){
  closePick();
  var m=document.createElement("div"); m.id="pick"; m.setAttribute("role","menu"); m.setAttribute("aria-label",title);
  m.innerHTML='<div class="pt">'+esc(title)+(kindText?" · "+esc(kindText):"")+"</div>"+PICK.map(function(o){return '<button type="button" role="menuitem" data-v="'+o[0]+'"'+(o[0]===cur0?' aria-current="true"':'')+'><i data-c="'+o[0]+'"></i>'+o[1]+'</button>';}).join("");
  document.body.appendChild(m);
  var w=m.offsetWidth, h=m.offsetHeight, x=Math.min(Math.max(8,r.left),window.innerWidth-w-8), y=up?r.top-h-8:r.bottom+4; if(y+h>window.innerHeight-8)y=Math.max(8,r.top-h-4); if(y<8)y=8;
  m.style.left=x+"px"; m.style.top=y+"px";
  m.addEventListener("click",function(ev){var o=ev.target.closest("button[data-v]"); if(!o)return; var v=o.getAttribute("data-v"); closePick(); onChoose(v);});
  var f=m.querySelector("button[aria-current]")||m.querySelector("button"); if(f)f.focus();
  pickAt=true;
}
var schedEl=document.getElementById("sched");
schedEl.addEventListener("mousedown",function(e){
  var b=e.target.closest&&e.target.closest("button[data-si]"); if(!b||e.button!==0)return;
  drag={i:+b.getAttribute("data-si"),d:+b.getAttribute("data-sd"),moved:false};
});
schedEl.addEventListener("mouseover",function(e){
  if(!drag||!(e.buttons&1))return;
  var b=e.target.closest&&e.target.closest("button[data-si]"); if(!b)return;
  var c={i:+b.getAttribute("data-si"),d:+b.getAttribute("data-sd")};
  if(!drag.moved&&c.i===drag.i&&c.d===drag.d)return;
  drag.moved=true; selRange(drag,c); paintSel();
});
document.addEventListener("mouseup",function(){ if(drag&&drag.moved)justDragged=true; drag=null; });
schedEl.addEventListener("click",function(e){
  var th=e.target.closest&&e.target.closest("th[data-col]"), nm=e.target.closest&&e.target.closest("td[data-row]");
  if(th){ var d=+th.getAttribute("data-col"), all=team.every(function(p,i){return sel[i+":"+d];}); team.forEach(function(p,i){ if(all)delete sel[i+":"+d]; else sel[i+":"+d]=true; }); paintSel(); return; }
  if(nm){ var ri=+nm.getAttribute("data-row"), dm=new Date(cur.y,cur.m+1,0).getDate(), all2=true; for(var d2=1;d2<=dm;d2++)if(!sel[ri+":"+d2]){all2=false;break;} for(var d3=1;d3<=dm;d3++){ if(all2)delete sel[ri+":"+d3]; else sel[ri+":"+d3]=true; } paintSel(); return; }
  var b=e.target.closest&&e.target.closest("button[data-si]"); if(!b)return;
  if(justDragged){justDragged=false; return;}
  var i2=+b.getAttribute("data-si"), d4=+b.getAttribute("data-sd"), key=i2+":"+d4;
  if(selMode||e.shiftKey||e.ctrlKey||e.metaKey){ if(sel[key])delete sel[key]; else sel[key]=true; paintSel(); return; }
  if(selCount()){ clearSel(); }
  e.stopPropagation(); closePick();
  var k=dayKind(d4,team[i2][2]), kt=k==="work"?"работен ден":k==="hol"?"празник (×2)":(team[i2][2]==="su"?"почивен ден — влиза в сумираното време":"почивен ден — бонус по нормална ставка");
  openMenu(b.getBoundingClientRect(),team[i2][0]+" · "+d4+" "+MONTHS[cur.m],kt,sc(i2,d4),function(v){applyPick(i2,d4,v);},false);
});
document.getElementById("selmode").addEventListener("click",function(){
  selMode=!selMode; this.setAttribute("aria-pressed",String(selMode)); if(!selMode)clearSel();
});
document.addEventListener("click",function(e){if(pickAt&&!(e.target.closest&&(e.target.closest("#pick")||e.target.closest("#selbar"))))closePick();});
document.addEventListener("keydown",function(e){if(e.key==="Escape"){closePick();clearSel();}});
window.addEventListener("scroll",closePick,true);
function fillLimit(){var n=new Date(), dm=new Date(cur.y,cur.m+1,0).getDate(); return (n.getFullYear()===cur.y&&n.getMonth()===cur.m)?Math.min(n.getDate(),dm):dm;}
function fillLabel(){var n=new Date(), curM=(n.getFullYear()===cur.y&&n.getMonth()===cur.m); document.getElementById("fillw").textContent=curM?"Попълни Р до днес":"Попълни Р по смяна";}
document.getElementById("fillw").addEventListener("click",function(){
  var lim=fillLimit();
  team.forEach(function(p,i){if(!st.s[i])st.s[i]={}; for(var d=1;d<=lim;d++){if(dayKind(d,p[2])==="work"&&!st.s[i][d])st.s[i][d]="Р";}});
  saveMonth(); renderAll();
});
document.getElementById("clrs").addEventListener("click",function(){
  if(!confirm("Изчиствам ли целия график за този месец?"))return; st.s={}; saveMonth(); renderAll();
});

/* ── Оборотна ведомост (PDF през pdfmake, зарежда се само при натискане) ── */
function loadPdfMake(cb,fail){
  if(window.pdfMake&&window.pdfMake.vfs){cb();return;}
  var s1=document.createElement("script"); s1.src="https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/pdfmake.min.js";
  s1.onload=function(){var s2=document.createElement("script"); s2.src="https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/vfs_fonts.js"; s2.onload=cb; s2.onerror=fail; document.head.appendChild(s2);};
  s1.onerror=fail; document.head.appendChild(s1);
}
function n2(x){return (Math.round(x*100)/100).toLocaleString("bg-BG",{minimumFractionDigits:2,maximumFractionDigits:2});}
function nz(x){return x?String(Math.round(x*10)/10).replace(".",","):"";}
function payrollDoc(){
  var c=cfg(), coef=parseFloat(document.getElementById("cf").value)||1.5, a=workDaysFor("mf"), b=workDaysFor("su");
  var title=MONTHS[cur.m]+" "+cur.y;
  var H=function(t){return {text:t,bold:true,fillColor:"#eeeeee",alignment:"center",fontSize:7.5};};
  var body=[[H("№"),H("Име"),H("Отраб. дни"),H("О"),H("БО"),H("Доп. ч"),H("Основна заплата €"),H("Бонус €"),H("Празничен труд €"),H("Бруто"),H("Осиг. служител"),H("ДДФЛ"),H("За получаване (нето)"),H("Осиг. работодател"),H("Общ разход")]];
  var T={g:0,e:0,t:0,n:0,w:0,c:0,h:0,b:0,o:0,s:0};
  team.forEach(function(p,i){
    var P=calcPerson(i,c,coef), r=P.r;
    T.g+=r.gross; T.e+=r.empTotal; T.t+=r.tax; T.n+=r.net; T.w+=r.erTotal; T.c+=r.cost; T.h+=P.hrs; T.b+=P.bonus; T.s+=P.base; T.o+=P.other;
    body.push([{text:String(i+1),alignment:"center"},{stack:[{text:String(p[0]),bold:true},{text:PATS[P.pat],fontSize:6,color:"#777"}]},
      {text:nz(P.days)+" / "+P.wd,alignment:"center"},{text:P.sch.leave?String(P.sch.leave):"",alignment:"center"},{text:P.sch.sick?String(P.sch.sick):"",alignment:"center"},{text:nz(P.hrs),alignment:"center"},
      {text:n2(P.base),alignment:"right"},{text:P.bonus?n2(P.bonus):"",alignment:"right"},{text:P.other?n2(P.other):"",alignment:"right"},
      {text:n2(r.gross),alignment:"right"},{text:n2(r.empTotal),alignment:"right"},{text:n2(r.tax),alignment:"right"},{text:n2(r.net),alignment:"right",bold:true},
      {text:n2(r.erTotal),alignment:"right"},{text:n2(r.cost),alignment:"right"}]);
  });
  var B=function(t,al){return {text:t,bold:true,alignment:al||"right",fillColor:"#f6f6f6"};};
  body.push([B("","center"),B("ОБЩО ("+team.length+")","left"),B("","center"),B("","center"),B("","center"),B(nz(T.h),"center"),B(n2(T.s)),B(n2(T.b)),B(n2(T.o)),B(n2(T.g)),B(n2(T.e)),B(n2(T.t)),B(n2(T.n)),B(n2(T.w)),B(n2(T.c))]);
  var today=new Date().toLocaleDateString("bg-BG");
  return {
    pageSize:"A4", pageOrientation:"landscape", pageMargins:[28,28,28,32],
    defaultStyle:{fontSize:8},
    info:{title:"Оборотна ведомост за заплати — "+title},
    content:[
      {text:"ОБОРОТНА ВЕДОМОСТ ЗА ЗАПЛАТИ",fontSize:15,bold:true,alignment:"center"},
      {text:title+" · ЧОВЕК И БЪДЕЩЕ ЕООД (МОТАМО)",fontSize:10,alignment:"center",margin:[0,2,0,2]},
      {text:"Работни дни: "+a+" (Пн–Пт) / "+b+" (Нд–Чт) · норма: "+(a*8)+" / "+(b*8)+" часа · суми в евро (EUR) · ставки 2026 по чл. 114 КТ (служител 13,78 % + ДДФЛ 10 %; работодател 18,92 %)",fontSize:8,alignment:"center",color:"#555",margin:[0,0,0,10]},
      {table:{headerRows:1,widths:[16,"*",40,18,18,28,50,42,42,48,48,40,54,48,48],body:body},layout:{hLineColor:function(){return "#bbbbbb";},vLineColor:function(){return "#bbbbbb";},paddingTop:function(){return 5;},paddingBottom:function(){return 5;}}},
      {text:"Бележки: нето е договореното за пълен месец; основна заплата = бруто за отработените дни; бонус = допълнителните часове по нормална часова ставка; бруто за месеца = основна заплата + бонус + празничен труд (часова ставка = бруто ÷ (работни дни × 8)). Бонус — допълнителни часове по нормална часова ставка, ×1 (при Пн–Пт в работен ден; при смяна Нд–Чт — часовете над месечната норма, тъй като са на сумирано работно време); празничен труд ×2; работа в почивен ден (Пн–Пт) — също бонус по нормална ставка. О — платен отпуск, БО — болничен (не се плаща от работодателя). Ориентировъчен разчет — окончателните суми са от счетоводителя.",fontSize:7,color:"#555",margin:[0,8,0,14]},
      {columns:[{text:"Съставил: ______________________",fontSize:9},{text:"Управител: ______________________",fontSize:9,alignment:"center"},{text:"Дата: "+today,fontSize:9,alignment:"right"}]}
    ],
    footer:function(pg,pgs){return {text:"Стр. "+pg+" от "+pgs,alignment:"right",fontSize:7,color:"#888",margin:[0,0,28,0]};}
  };
}
document.getElementById("pdfbtn").addEventListener("click",function(){
  var stt=document.getElementById("pdfstat"); stt.textContent="Подготвям PDF…";
  loadPdfMake(function(){
    try{
      var name="vedomost-zaplati-"+cur.y+"-"+(cur.m<9?"0":"")+(cur.m+1)+".pdf";
      pdfMake.createPdf(payrollDoc()).download(name,function(){stt.textContent="Свалено: "+name;});
    }catch(e){stt.textContent="Грешка при създаване на PDF.";}
  },function(){stt.textContent="Не успях да заредя PDF библиотеката (интернет?).";});
});

/* ── График като PDF (само смени, без пари) ── */
var XCOL=["#e3d9ff","#3b1f8c"];
var CCOL={"Р":["#c9f0d3","#14532d"],"4":["#ffe0b8","#7a4300"],"6":["#fff4b3","#6b5800"],"О":["#bff0eb","#0b5c55"],"БО":["#ffc9c4","#7a1410"]};
function ccol(code){ if(CCOL[code])return CCOL[code]; if(/^Р[+]/.test(code))return ["#e3d9ff","#3b1f8c"]; return null; }
function scheduleDoc(){
  var dm=new Date(cur.y,cur.m+1,0).getDate(), D=["Нд","Пн","Вт","Ср","Чт","Пт","Сб"], title=MONTHS[cur.m]+" "+cur.y;
  var hdr=[{text:"Служител",bold:true,fillColor:"#eeeeee",fontSize:7,margin:[0,3,0,3]}];
  for(var d=1;d<=dm;d++){var w=new Date(cur.y,cur.m,d).getDay(), we=(w===0||w===6);
    hdr.push({stack:[{text:D[w],fontSize:5.5,color:"#555555"},{text:String(d),fontSize:7,bold:true,color:"#111111"}],alignment:"center",fillColor:"#eeeeee",margin:[0,1,0,1]});}
  ["Дни","О","БО","Доп. ч","Часове"].forEach(function(t){hdr.push({text:t,bold:true,alignment:"center",fillColor:"#eeeeee",fontSize:6.5,margin:[0,3,0,3]});});
  var body=[hdr];
  team.forEach(function(p,i){
    var t=schedTot(i), r=[{stack:[{text:String(p[0]),bold:true,fontSize:8},{text:PATS[p[2]],fontSize:5.5,color:"#777777"}],margin:[0,1,0,1]}];
    for(var d=1;d<=dm;d++){
      var c=sc(i,d), k=dayKind(d,p[2]), col=c?(cellExtra(c,k,p[2])?XCOL:ccol(c)):null;
      r.push({text:c,alignment:"center",fontSize:6,bold:true,margin:[0,3,0,3],fillColor:col?col[0]:(k==="work"?null:"#ececec"),color:col?col[1]:"#111111"});
    }
    r.push({text:String(t.days),alignment:"center",bold:true},{text:t.leave?String(t.leave):"",alignment:"center"},{text:t.sick?String(t.sick):"",alignment:"center"},{text:nz(t.ext),alignment:"center"},{text:String(t.hours),alignment:"center",bold:true});
    body.push(r);
  });
  var widths=[62]; for(var d2=1;d2<=dm;d2++)widths.push(16); widths.push(20,16,16,24,28);
  var chip=function(label,code){var col=ccol(code); return {text:label,fillColor:col[0],color:col[1],bold:true,fontSize:7,alignment:"center",margin:[0,2,0,2]};};
  var leg={table:{widths:[34,44,34,34,40,40],body:[[chip("Р","Р"),chip("Р+N","Р+1"),chip("4 / 6 ч","4"),chip("О","О"),chip("БО","БО"),{text:"",border:[false,false,false,false]}]]},layout:"noBorders",margin:[0,10,0,0]};
  var today=new Date().toLocaleDateString("bg-BG");
  return {
    pageSize:"A4", pageOrientation:"landscape", pageMargins:[24,26,24,30], defaultStyle:{fontSize:7},
    info:{title:"График за работа — "+title},
    content:[
      {text:"ГРАФИК ЗА РАБОТА",fontSize:15,bold:true,alignment:"center"},
      {text:title+" · ЧОВЕК И БЪДЕЩЕ ЕООД (МОТАМО)",fontSize:10,alignment:"center",margin:[0,2,0,2]},
      {text:"Смени: Пн–Пт и Нд–Чт (Йорданка, Христина, Амбър) · сивите клетки са почивни дни за смяната на служителя",fontSize:8,alignment:"center",color:"#555555",margin:[0,0,0,8]},
      {table:{headerRows:1,widths:widths,body:body},layout:{hLineColor:function(){return "#bbbbbb";},vLineColor:function(){return "#bbbbbb";},paddingLeft:function(){return 1.5;},paddingRight:function(){return 1.5;},paddingTop:function(){return 1;},paddingBottom:function(){return 1;}}},
      leg,
      {text:"Р — редовна смяна (8 ч) · Р+N — редовна смяна и N допълнителни часа · 4 / 6 — кратка смяна · О — платен отпуск · БО — болничен. Колона „Доп. ч“ — допълнителни часове. Седмицата започва от понеделник.",fontSize:7,color:"#555555",margin:[0,6,0,0]},
      {text:"Дата на съставяне: "+today,fontSize:8,alignment:"right",margin:[0,8,0,0]}
    ],
    footer:function(pg,pgs){return {text:"Стр. "+pg+" от "+pgs,alignment:"right",fontSize:7,color:"#888888",margin:[0,0,24,0]};}
  };
}
document.getElementById("schbtn").addEventListener("click",function(){
  var stt=document.getElementById("schstat"); stt.textContent="Подготвям PDF…";
  loadPdfMake(function(){
    try{
      var name="grafik-"+cur.y+"-"+(cur.m<9?"0":"")+(cur.m+1)+".pdf";
      pdfMake.createPdf(scheduleDoc()).download(name,function(){stt.textContent="Свалено: "+name;});
    }catch(e){stt.textContent="Грешка при създаване на PDF.";}
  },function(){stt.textContent="Не успях да заредя PDF библиотеката (интернет?).";});
});

function renderAll(){renderCal();renderTeam();renderSched();run();fillLabel();if(typeof paintSel==="function")paintSel();}
["amt","cap","tz","cf"].forEach(function(i){document.getElementById(i).addEventListener("input",renderAll);document.getElementById(i).addEventListener("change",renderAll);});
loadMonth(); renderAll(); pullServer();
</script></body></html>`;

module.exports = { salaryKey, salaryPage: page, fromGross, fromNet, fromCost, RATES, dbLoad, dbSave };
