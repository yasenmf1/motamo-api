// lib/quality.js — Контрол на качеството в ЦЕХА (16.00 всеки ден, Йорданка).
// Точки 4 и 5: проба на производството (планирано срещу измерено, допуск ±5 %) и чеклист „Край на деня".
// Температури / хигиена при старт / входящ контрол са автоматични през bgkontrola — тук НЕ се пипат.
// Записът е само за добавяне (Supabase `qc_log`, без update/delete) — дневник за проверки (БАБХ).
// Страницата се отваря от Telegram бутона в 16:00 (ключ на склада). Само добавя редове и праща резюме на собственика.
const TG = require("./telegram.js");

const SB_URL = TG.SB_URL, sbH = TG.sbH;   // същият Supabase достъп като ботът (lib/telegram.js)

const TOL = 0.05;   // допустимо отклонение на теглото (±5 %) — собственикът потвърди чернова 19.10; промени тук
// Продукти за пробата (имена на заготовки в Barsy на цеха). „Друго" → описание в бележката.
const PRODUCTS = ["заг. Сварен суши ориз", "заг. Марината за ориз", "заг. Ориз Поке СЧМ", "заг. Соево чеснова майонеза Хепи", "Друго (опиши в бележката)"];
// Край на деня — чернова за цеха (собственикът може да я промени тук).
const END_ITEMS = [
  "Изхвърлени изтекли и открити продукти",
  "Заготовките и отворените опаковки са с етикет и дата",
  "Повърхности, под и съдове почистени",
  "Уредите са изключени, хладилниците са затворени",
  "Боклукът е изнесен",
  "Липсите за утре са записани (ориз, сосове, кутии)",
  "Цехът е заключен"
];

const sofiaHour = (d) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(d || new Date())) % 24;
const dowOf = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const num = (x) => { const n = Number(String(x == null ? "" : x).replace(",", ".")); return Number.isFinite(n) ? n : null; };

// ±TOL от планираното → "ok" | "warn"
function evalSample(planned, measured) {
  if (planned == null || measured == null || planned <= 0) return "warn";
  return Math.abs(measured - planned) / planned <= TOL ? "ok" : "warn";
}

function page(k) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOTAMO · Контрол на качеството</title><style>
*{box-sizing:border-box}body{margin:0;font:16px system-ui,Segoe UI,Roboto,sans-serif;background:#eef0f3;color:#14171a}
.wrap{max-width:640px;margin:0 auto;padding:14px 14px 90px}h1{font-size:20px;margin:4px 0 2px}.sub{color:#666;font-size:14px;margin:0 0 12px}
.card{background:#fff;border-radius:14px;padding:12px 14px;margin:0 0 14px;box-shadow:0 2px 8px rgba(20,23,26,.08)}
h2{font-size:16px;margin:0 0 8px}label{display:block;font-size:13px;color:#555;margin:8px 0 3px}
input,select,textarea{width:100%;font:16px system-ui;padding:9px 10px;border:1px solid #d7dade;border-radius:9px;background:#fff}
.row{border-top:1px solid #eee;padding:8px 0}.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.chip{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:999px;font-size:13px;font-weight:700}.ok{background:#dff5e6;color:#0a6b2e}.warn{background:#fde8d4;color:#b3541a}
.it{display:flex;gap:8px;align-items:center;justify-content:space-between;border-top:1px solid #eee;padding:9px 0}.it span{flex:1;font-size:15px}
.tg{display:flex;gap:6px}.tg button{font:16px system-ui;font-weight:700;border:1px solid #d7dade;background:#fff;border-radius:10px;padding:8px 12px;cursor:pointer}
.tg button.on.ok{background:#16a34a;color:#fff;border-color:#16a34a}.tg button.on.warn{background:#d97706;color:#fff;border-color:#d97706}
.note{display:none;margin-top:6px}.note.show{display:block}
.bar{position:fixed;left:0;right:0;bottom:0;background:#fff;padding:10px 14px;box-shadow:0 -2px 10px rgba(0,0,0,.1)}
.bar button{width:100%;font:17px system-ui;font-weight:800;padding:13px;border:0;border-radius:12px;background:#c8151f;color:#fff;cursor:pointer}.bar button[disabled]{opacity:.5}
.add{background:none;border:1px dashed #aaa;border-radius:10px;padding:8px;width:100%;font:15px system-ui;color:#555;margin-top:8px}
.msg{font-size:15px;margin:8px 0 0}.msg.good{color:#0a6b2e}.msg.bad{color:#b3121b}
</style></head><body><div class="wrap">
<h1>🧪 Контрол на качеството · цех</h1><p class="sub" id="dt"></p>
<div class="card"><label>Кой попълва</label><input id="who" placeholder="Име" maxlength="40"></div>
<div class="card"><h2>🧪 Проба на производството</h2><div class="sub" style="margin:0 0 6px">Попълни само това, което си правила днес (планирано и измерено, кг). Допуск ±5 %. Празните редове се пропускат.</div>
<div id="samples"></div><button class="add" onclick="addSample()">+ Друг продукт</button></div>
<div class="card"><h2>🌙 Край на деня</h2><div id="end"></div></div>
<p class="msg" id="msg"></p></div>
<div class="bar"><button id="go" onclick="send()">Запиши</button></div>
<script>
var K=${JSON.stringify(k || "")},TOL=${TOL},PRODUCTS=${JSON.stringify(PRODUCTS)},END=${JSON.stringify(END_ITEMS)};
function initS(){return PRODUCTS.filter(function(p){return p.indexOf('Друго')!==0}).map(function(p){return {item:p,planned:'',measured:'',note:'',fixed:true}})}
var ST={samples:initS(),end:END.map(function(t){return {item:t,status:null,note:''}})};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function n(x){var v=Number(String(x==null?'':x).replace(',','.'));return isFinite(v)&&String(x).trim()!==''?v:null}
function stOf(s){var p=n(s.planned),m=n(s.measured);if(p==null||m==null||p<=0)return null;return Math.abs(m-p)/p<=TOL?'ok':'warn'}
function addSample(){ST.samples.push({item:'',planned:'',measured:'',note:'',fixed:false});renderS()}
function renderS(){var h='';ST.samples.forEach(function(s,i){var st=stOf(s);
  h+='<div class="row">'+(s.fixed?'<b>'+esc(String(s.item).replace('заг. ',''))+'</b>':'<input placeholder="Друг продукт — име" value="'+esc(s.item)+'" oninput="ST.samples['+i+'].item=this.value">')
   +'<div class="two"><div><label>Планирано (кг)</label><input inputmode="decimal" value="'+esc(s.planned)+'" oninput="ST.samples['+i+'].planned=this.value;chip('+i+')"></div>'
   +'<div><label>Измерено (кг)</label><input inputmode="decimal" value="'+esc(s.measured)+'" oninput="ST.samples['+i+'].measured=this.value;chip('+i+')"></div></div>'
   +'<span class="chip '+(st||'')+'" id="c'+i+'">'+(st==='ok'?'✅ в нормата':st==='warn'?'⚠️ извън ±5 %':'')+'</span>'
   +'<div class="note'+(st==='warn'?' show':'')+'" id="sn'+i+'"><input placeholder="Какво е станало? (задължително)" value="'+esc(s.note)+'" oninput="ST.samples['+i+'].note=this.value"></div></div>'});
  document.getElementById('samples').innerHTML=h}
function chip(i){var s=ST.samples[i],st=stOf(s),c=document.getElementById('c'+i);c.className='chip '+(st||'');c.textContent=st==='ok'?'✅ в нормата':st==='warn'?'⚠️ извън ±5 %':'';document.getElementById('sn'+i).className='note'+(st==='warn'?' show':'')}
function renderE(){var h='';ST.end.forEach(function(e,i){h+='<div class="it"><span>'+esc(e.item)+'</span><div class="tg"><button class="ok'+(e.status==='ok'?' on':'')+'" onclick="setE('+i+',\\'ok\\')">✅</button><button class="warn'+(e.status==='warn'?' on':'')+'" onclick="setE('+i+',\\'warn\\')">⚠️</button></div></div>'
  +'<div class="note'+(e.status==='warn'?' show':'')+'"><input placeholder="Какво е проблемът? (задължително)" value="'+esc(e.note)+'" oninput="ST.end['+i+'].note=this.value"></div>'});
  document.getElementById('end').innerHTML=h}
function setE(i,v){ST.end[i].status=v;renderE()}
function send(){var m=document.getElementById('msg'),who=document.getElementById('who').value.trim();
  if(!who){m.className='msg bad';m.textContent='Напиши името си.';return}
  var samples=ST.samples.filter(function(s){return n(s.planned)!=null||n(s.measured)!=null}),bad='';
  samples.forEach(function(s){var st=stOf(s);if(!String(s.item).trim())bad='Напиши име на продукта.';else if(n(s.planned)==null||n(s.measured)==null)bad='Попълни и планирано, и измерено.';else if(st==='warn'&&!String(s.note).trim())bad='При ⚠️ в пробата напиши бележка.'});
  var end=ST.end;if(end.some(function(e){return !e.status}))bad=bad||'Отбележи всяка точка от „Край на деня" (✅ или ⚠️).';
  end.forEach(function(e){if(e.status==='warn'&&!String(e.note).trim())bad=bad||'При ⚠️ напиши какво е проблемът.'});
  if(bad){m.className='msg bad';m.textContent=bad;return}
  var b=document.getElementById('go');b.disabled=true;m.className='msg';m.textContent='записва…';
  try{localStorage.setItem('qcwho',who)}catch(e){}
  fetch('/api/transfer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:K,action:'qc_save',who:who,samples:samples,end:end})})
   .then(function(r){return r.json()}).then(function(j){b.disabled=false;
     if(j.ok){m.className='msg good';m.textContent='✅ Записано ('+j.rows+' реда).'+(j.warn?' ⚠️ '+j.warn+' с проблем — собственикът е известен.':'');ST.samples=initS();ST.end=END.map(function(t){return {item:t,status:null,note:''}});renderS();renderE();window.scrollTo(0,0)}
     else{m.className='msg bad';m.textContent='Грешка: '+(j.error||'')}}).catch(function(){b.disabled=false;m.className='msg bad';m.textContent='Няма връзка. Опитай пак.'})}
document.getElementById('dt').textContent=new Date().toLocaleDateString('bg-BG',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Sofia'});
try{document.getElementById('who').value=localStorage.getItem('qcwho')||''}catch(e){}
renderS();renderE();
</script></body></html>`;
}

// Запис от формата. Връща { ok, rows, warn } и праща резюме на собственика.
async function save(body) {
  const today = TG.sofiaDate();
  const who = String(body.who || "").trim().slice(0, 40);
  if (!who) return { ok: false, error: "липсва име" };
  const batch = require("crypto").randomBytes(6).toString("hex");
  const rows = [];
  const warns = [];
  for (const s of (Array.isArray(body.samples) ? body.samples : []).slice(0, 12)) {
    const planned = num(s.planned), measured = num(s.measured);
    const item = String(s.item || "").slice(0, 80);
    if (!item || planned == null || measured == null || planned <= 0) return { ok: false, error: "невалидна проба за „" + item + "“" };
    const status = evalSample(planned, measured), note = String(s.note || "").slice(0, 300) || null;
    if (status === "warn" && !note) return { ok: false, error: "при ⚠️ е нужна бележка („" + item + "“)" };
    rows.push({ for_date: today, site: "cex", kind: "production", item, status, expected: planned, measured, unit: "кг", note, submitted_by: who, batch });
    if (status === "warn") warns.push(`🧪 ${item}: планирано ${planned}, измерено ${measured} кг${note ? " — " + note : ""}`);
  }
  const end = Array.isArray(body.end) ? body.end : [];
  if (end.length !== END_ITEMS.length) return { ok: false, error: "непълен чеклист „Край на деня“" };
  for (let i = 0; i < END_ITEMS.length; i++) {
    const e = end[i] || {};
    if (String(e.item || "") !== END_ITEMS[i]) return { ok: false, error: "чеклистът не съвпада — презареди страницата" };
    if (e.status !== "ok" && e.status !== "warn") return { ok: false, error: "липсва отметка: " + END_ITEMS[i] };
    const note = String(e.note || "").slice(0, 300) || null;
    if (e.status === "warn" && !note) return { ok: false, error: "при ⚠️ е нужна бележка" };
    rows.push({ for_date: today, site: "cex", kind: "endofday", item: END_ITEMS[i], status: e.status, note, submitted_by: who, batch });
    if (e.status === "warn") warns.push(`🌙 ${END_ITEMS[i]}${note ? " — " + note : ""}`);
  }
  const r = await fetch(`${SB_URL}/rest/v1/qc_log`, { method: "POST", headers: { ...sbH, Prefer: "return=minimal" }, body: JSON.stringify(rows) });
  if (!r.ok) return { ok: false, error: "не се записа в базата (" + r.status + ")" };
  const nProd = rows.filter(x => x.kind === "production").length, nProdOk = rows.filter(x => x.kind === "production" && x.status === "ok").length;
  const nEnd = rows.filter(x => x.kind === "endofday").length, nEndOk = rows.filter(x => x.kind === "endofday" && x.status === "ok").length;
  const text = `${warns.length ? "⚠️" : "✅"} <b>Контрол · цех · ${today.slice(8)}.${today.slice(5, 7)}</b> (${TG.escHtml(who)})\n`
    + `🧪 Проба: ${nProd ? nProdOk + "/" + nProd + " в нормата" : "няма производство"}\n🌙 Край на деня: ${nEndOk}/${nEnd}`
    + (warns.length ? "\n\n" + warns.map(TG.escHtml).join("\n") : "");
  await TG.tgSend(text, TG.OWNER_CHAT_ID).catch(() => {});
  return { ok: true, rows: rows.length, warn: warns.length };
}

// 16:00 (София): бутон към формата за склада; Vercel cron върви в UTC → пуска се на два часа, действа само в 16:00 местно.
async function cronPrompt(base, now) {
  const today = TG.sofiaDate(now), dow = dowOf(today);
  if (dow < 1 || dow > 6) return { ok: true, skipped: "sunday" };
  if (sofiaHour(now) !== 16) return { ok: true, skipped: "not_16" };
  if (await TG.sentGet("qc_prompt", today).catch(() => null)) return { ok: true, skipped: "already" };
  const text = "🧪🌙 <b>Контрол на качеството — 16:00</b>\nПроба на производството и край на деня. Отнема 2 минути.";
  const markup = { inline_keyboard: [[{ text: "✅ Отвори контрола", url: `${base}?view=qc&k=${TG.skladKey()}` }]] };
  let n = await TG.sendToRole("sklad", text, today, markup).catch(() => 0);
  if (!n) { const r = await TG.tgSend(text, null, today, markup).catch(() => ({})); n = r.ok ? 1 : 0; }
  await TG.sentSave("qc_prompt", today, { sent: n }).catch(() => {});
  return { ok: true, sent: n };
}

// 17:30 (София): ако няма записан контрол за деня → сигнал на собственика.
async function cronCheck(now) {
  const today = TG.sofiaDate(now), dow = dowOf(today);
  if (dow < 1 || dow > 6) return { ok: true, skipped: "sunday" };
  if (sofiaHour(now) !== 17) return { ok: true, skipped: "not_17" };
  if (await TG.sentGet("qc_check", today).catch(() => null)) return { ok: true, skipped: "already" };
  const r = await fetch(`${SB_URL}/rest/v1/qc_log?for_date=eq.${today}&kind=eq.endofday&select=id&limit=1`, { headers: sbH });
  const rows = r.ok ? await r.json() : null;
  if (rows === null) return { ok: false, error: "supabase_" + r.status };
  await TG.sentSave("qc_check", today, { missing: !rows.length }).catch(() => {});
  if (rows.length) return { ok: true, done: true };
  await TG.tgSend("⚠️ <b>Контролът на качеството за днес още не е попълнен</b> (цех, 16:00).", TG.OWNER_CHAT_ID).catch(() => {});
  return { ok: true, alerted: true };
}

module.exports = { page, save, cronPrompt, cronCheck, evalSample, sofiaHour, TOL, PRODUCTS, END_ITEMS };
