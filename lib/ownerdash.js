// lib/ownerdash.js — „Табло на собственика": оборот точка, оборот цех, стокови, склад, какво да се поръча, пратени поръчки.
// Само четене (нищо не пише в Barsy). Страницата се зарежда веднага, а всяка част идва от своя адрес (?view=ownerdata&part=…)
// и се рисува, когато е готова — бавна или счупена част не спира останалите.
// Ключ: sha256("motamo-owner-dash:" + PEEK_TOKEN) — изведен, без нови променливи на средата.
const crypto = require("crypto");

const ownerKey = () => process.env.PEEK_TOKEN
  ? crypto.createHash("sha256").update("motamo-owner-dash:" + process.env.PEEK_TOKEN).digest("hex").slice(0, 24) : null;
const keyOk = (k) => { const e = ownerKey(); return !!(e && typeof k === "string" && k.length === e.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(e))); };

const sofiaDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(d || new Date());
const plusDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── малък кеш (60 с) — да не питаме Barsy при всяко отваряне ───────────────────
const CACHE = new Map();
async function cached(key, ttlMs, fn) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  CACHE.set(key, { t: Date.now(), v });
  return v;
}

// ── редове от дните (30 дни, с нули) ──────────────────────────────────────────
function series(byDay, from, to) {
  const out = [];
  for (let d = from; d <= to; d = plusDays(d, 1)) out.push({ d, v: r2(byDay && byDay[d]) });
  return out;
}

// ── ТОЧКА ─────────────────────────────────────────────────────────────────────
function pointView(data, from, to) {
  const s = series(data.by_day, from, to), today = to, ym = to.slice(0, 7);
  return {
    ok: true, from, to, series: s, today: r2(data.by_day && data.by_day[today]),
    cmp: data.cmp || null,                                   // { today, lastWeek, hm } до същия час
    month: r2(s.filter(x => x.d.startsWith(ym)).reduce((a, x) => a + x.v, 0)),
    total30: r2(s.reduce((a, x) => a + x.v, 0)), accounts: data.accounts || 0, avg_check: r2(data.avg_check)
  };
}

// ── ЦЕХ ───────────────────────────────────────────────────────────────────────
// accs: затворени сметки на цеха { d: "YYYY-MM-DD", v: нето, cid, name } — оборотът е същият като в цеховото табло (нето = с ДДС ÷ 1,2).
function cexView(accs, from, to) {
  const byDay = {}, today = {}; let todayN = 0;
  for (const a of accs) {
    if (!a || a.d < from || a.d > to) continue;
    byDay[a.d] = (byDay[a.d] || 0) + a.v;
    if (a.d === to) { todayN++; const c = today[a.cid] || (today[a.cid] = { id: a.cid, name: a.name, v: 0, n: 0 }); c.v += a.v; c.n++; }
  }
  const s = series(byDay, from, to), ym = to.slice(0, 7);
  const clients = Object.values(today).map(c => ({ id: c.id, name: c.name, v: r2(c.v), n: c.n })).filter(c => c.v > 0).sort((x, y) => y.v - x.v);
  return {
    ok: true, from, to, series: s, today: r2(byDay[to]), stokovi_n: todayN,
    month: r2(s.filter(x => x.d.startsWith(ym)).reduce((q, x) => q + x.v, 0)), total30: r2(s.reduce((q, x) => q + x.v, 0)), clients
  };
}

// ── СКЛАД + какво да се поръча ─────────────────────────────────────────────────
// gap = дни покритие − дни до следващата доставка. Под 0 → ще свърши преди камиона. Поръчка: да стигне до доставката след следващата (+7 дни).
function stockView(rep) {
  const raw = (rep && rep.raw) || [];
  const idle = [].concat((rep && rep.toPoint) || [], (rep && rep.rest) || []);
  const value = raw.reduce((a, x) => a + (x.val || 0), 0) + idle.reduce((a, x) => a + (x.val || 0), 0);
  const risky = [];
  for (const r of raw) {
    if (r.c == null) continue;
    const lead = Number(r.lead) || 0, gap = r.c - lead;
    if (gap >= 0) continue;
    const v = Math.max(Number(r.v28) || 0, Number(r.v7) || 0) + (Number(r.vp) || 0);
    const need = Math.max(0, (lead + 7) * v - (Number(r.s) || 0));
    risky.push({ n: r.n, u: r.u || "", s: Number(r.s) || 0, c: r.c, lead, gap: Math.round(gap * 10) / 10, need: Math.ceil(need * 100) / 100, sup: r.sup || "—" });
  }
  const by = {};
  for (const x of risky) (by[x.sup] = by[x.sup] || []).push(x);
  const groups = Object.keys(by).map(sup => {
    const items = by[sup].sort((a, b) => a.gap - b.gap);
    return { sup, lead: items[0].lead, n: items.length, worst: items[0].gap, items };
  }).sort((a, b) => a.worst - b.worst);
  const zero = raw.filter(r => (Number(r.s) || 0) <= 0 && ((Number(r.v28) || 0) > 0 || (Number(r.v7) || 0) > 0)).length;
  const idleTop = idle.slice().sort((a, b) => b.val - a.val).slice(0, 5).map(x => ({ n: x.n, s: x.s, u: x.u, val: x.val }));
  return { ok: true, value: Math.round(value), risk_n: risky.length, sup_n: groups.length, zero_n: zero, groups, idle: idleTop, idle_value: Math.round(idle.reduce((a, x) => a + (x.val || 0), 0)), date: rep && rep.for_date || null };
}

// ── ПРАТЕНИ ПОРЪЧКИ ───────────────────────────────────────────────────────────
function ordersView(rows) {
  return {
    ok: true, items: (rows || []).map(r => {
      const lines = String(r.body || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
      return { at: r.at, sup: r.supplier, n: Math.max(0, lines.length - 1), text: String(r.body || "").slice(0, 900) };
    })
  };
}

// deps: { shopDashData, cexAccounts(from,to), stockReport, soList, shopUser, shopPass }
async function partData(part, deps, now) {
  now = now || new Date();
  const to = sofiaDate(now), from = plusDays(to, -29);
  if (part === "point") return cached("point", 60000, async () => {
    const d = await deps.shopDashData(from, to, 0, deps.shopUser, deps.shopPass);
    return pointView(d, from, to);
  });
  if (part === "cex") return cached("cex", 60000, async () => cexView(await deps.cexAccounts(from, to), from, to));
  if (part === "stock") return cached("stock", 60000, async () => stockView(await deps.stockReport()));
  if (part === "orders") return ordersView(await deps.soList());
  return { ok: false, error: "part" };
}

// ── СТРАНИЦА ──────────────────────────────────────────────────────────────────
function page(k, links) {
  const cfg = JSON.stringify({ k, links: links || {} }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>MOTAMO · Табло</title>
<meta name="theme-color" content="#f8f8f6"><link rel="apple-touch-icon" href="https://motamo.bg/icons/icon-192.png">
<style>
:root{color-scheme:light dark;--page:light-dark(#f8f8f6,#0b0b0d);--card:light-dark(#fff,#141417);--soft:light-dark(#f1f1ef,#1c1c20);--ink:light-dark(#17171a,#f3f3f5);--ink2:light-dark(#48484d,#c4c4ca);--muted:light-dark(#66666d,#8c8c95);
--line:light-dark(rgb(0 0 0/.075),rgb(255 255 255/.08));--line2:light-dark(rgb(0 0 0/.14),rgb(255 255 255/.16));--accent:light-dark(#3e63dd,#7b96ff);--money:light-dark(#0f7f57,#34c48b);--up:var(--money);--down:light-dark(#d23f45,#ff6b70);--warn:light-dark(#c98a00,#f6b100);--tip:light-dark(#1f2530,#2a3548);--live:#12a150;
--shadow:0 1px 2px rgb(0 0 0/.04),0 1px 1px rgb(0 0 0/.02)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.4 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.w{max-width:1500px;margin:0 auto;padding:16px 16px calc(28px + env(safe-area-inset-bottom))}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:2px 0 14px}.top h1{font-size:20px;font-weight:600;margin:0;margin-right:auto}
.pill{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border-radius:99px;background:var(--card);border:1px solid var(--line);font-size:13px;color:var(--ink2);box-shadow:var(--shadow)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--live)}.dot.off{background:var(--muted)}button.pill{cursor:pointer;font:inherit;font-size:13px}button.pill:hover{background:var(--soft)}
.grid{display:grid;gap:12px}.kpis{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;box-shadow:var(--shadow);min-width:0}
.k .l{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}.ic{width:24px;height:24px;border-radius:7px;display:grid;place-items:center;font-size:13px;background:color-mix(in srgb,var(--accent) 12%,transparent)}
.ic.m{background:color-mix(in srgb,var(--money) 12%,transparent)}.ic.w{background:color-mix(in srgb,var(--warn) 18%,transparent)}
.k .v{font-size:30px;font-weight:600;letter-spacing:-.02em;margin:8px 0 4px;font-variant-numeric:tabular-nums}.k .v small{font-size:16px;color:var(--muted);font-weight:500;margin-left:3px}
.sub{color:var(--muted);font-size:13px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-variant-numeric:tabular-nums}
.dl{font-weight:600;font-size:13px}.dl.up{color:var(--up)}.dl.down{color:var(--down)}.dl.n{color:var(--muted);font-weight:500}
.k.bad{border-color:color-mix(in srgb,var(--warn) 45%,var(--line));background:color-mix(in srgb,var(--warn) 7%,var(--card))}.k.bad .v{color:var(--warn)}
h2{font-size:15px;font-weight:600;margin:0}.hd{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}.hd .sub{margin:0}
.cols{grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);margin-top:12px;align-items:start}@media(max-width:900px){.cols{grid-template-columns:1fr}}
.sup{border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}.sup>header{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--soft)}
.sup>header b{font-weight:600}.chip{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:99px;font-size:12px;font-weight:500;background:color-mix(in srgb,var(--warn) 18%,transparent);color:light-dark(#7a5300,#f6b100)}
.chip.g{background:color-mix(in srgb,var(--muted) 15%,transparent);color:var(--ink2)}.sup a.go{margin-left:auto;text-decoration:none;color:var(--accent);font-weight:500;font-size:13px}
.row{display:grid;grid-template-columns:minmax(0,1fr) 92px 96px;gap:10px;align-items:center;padding:8px 12px;border-top:1px solid var(--line);position:relative}
.row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row .c,.row .o{text-align:right;font-variant-numeric:tabular-nums}.row .c{color:var(--down);font-weight:600}.row .o{font-weight:500}
.row .bar{position:absolute;left:12px;right:12px;bottom:3px;height:3px;border-radius:3px;background:var(--line)}.row .bar i{display:block;height:100%;border-radius:3px;background:var(--warn)}
.more{padding:8px 12px;border-top:1px solid var(--line);color:var(--accent);cursor:pointer;font-size:13px}
.cl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:8px 0;border-top:1px solid var(--line);position:relative}.cl:first-child{border-top:0}.cl .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cl .v{text-align:right;font-variant-numeric:tabular-nums;font-weight:500}.cl .t{grid-column:1/3;height:3px;border-radius:3px;background:var(--line);margin-top:3px}.cl .t i{display:block;height:100%;border-radius:3px;background:var(--money)}
.ord{padding:8px 0;border-top:1px solid var(--line)}.ord:first-child{border-top:0}.ord summary{cursor:pointer;display:flex;gap:10px;align-items:center;list-style:none}.ord summary::-webkit-details-marker{display:none}.ord pre{white-space:pre-wrap;font:13px/1.45 inherit;margin:8px 0 0;color:var(--ink2)}.ord .t{color:var(--muted);font-variant-numeric:tabular-nums;min-width:86px}
.chart{width:100%;height:230px;display:block}.leg{display:flex;gap:14px;font-size:13px;color:var(--ink2);flex-wrap:wrap}.leg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.sk{border-radius:8px;background:linear-gradient(90deg,var(--soft),var(--line),var(--soft));background-size:200% 100%;animation:sh 1.3s infinite;height:14px}@keyframes sh{to{background-position:-200% 0}}
.err{color:var(--muted);display:flex;gap:10px;align-items:center;flex-wrap:wrap}.err a{color:var(--accent);cursor:pointer}.empty{color:var(--muted);padding:8px 0}
.tip{position:fixed;z-index:9;pointer-events:none;background:var(--tip);color:#fff;border-radius:10px;padding:8px 11px;font-size:12.5px;box-shadow:0 12px 32px -8px rgb(0 0 0/.3);display:none;font-variant-numeric:tabular-nums}.tip b{display:block;font-size:15px;font-weight:600}
.lnk{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}.lnk a{text-decoration:none;color:var(--ink2)}
@media(prefers-reduced-motion:reduce){.sk{animation:none}}
</style></head><body><div class="w">
<div class="top"><h1>Табло</h1><span class="pill"><span class="dot off" id="dot"></span><span id="upd">зареждам…</span></span><button class="pill" id="rf" title="Обнови">↻ Обнови</button></div>
<div class="grid kpis">
 <div class="card k" id="k-point"><div class="l"><span class="ic">🏪</span>Точка · днес</div><div class="v sk" style="height:34px;width:60%"></div></div>
 <div class="card k" id="k-cex"><div class="l"><span class="ic m">🏭</span>Цех · днес</div><div class="v sk" style="height:34px;width:60%"></div></div>
 <div class="card k" id="k-stock"><div class="l"><span class="ic">📦</span>Склад</div><div class="v sk" style="height:34px;width:60%"></div></div>
 <div class="card k" id="k-order"><div class="l"><span class="ic w">🛒</span>За поръчка</div><div class="v sk" style="height:34px;width:60%"></div></div>
</div>
<div class="grid cols">
 <div class="card" id="c-risk"><div class="hd"><h2>Ще свърши преди доставка</h2><span class="sub" id="risk-sub"></span></div><div id="risk"><div class="sk" style="height:60px"></div></div></div>
 <div class="card" id="c-stok"><div class="hd"><h2>Стокови днес</h2><span class="sub" id="stok-sub"></span></div><div id="stok"><div class="sk" style="height:60px"></div></div></div>
</div>
<div class="card" style="margin-top:12px" id="c-chart"><div class="hd"><h2>Оборот · 30 дни</h2><div class="leg"><span><i style="background:var(--accent)"></i>Точка</span><span><i style="background:var(--money)"></i>Цех</span><span style="color:var(--muted)">€ без ДДС</span></div></div><svg class="chart" id="chart" role="img" aria-label="Оборот на точката и цеха за 30 дни"></svg></div>
<div class="grid cols">
 <div class="card" id="c-ord"><div class="hd"><h2>Пратени поръчки към доставчици</h2></div><div id="ord"><div class="sk" style="height:40px"></div></div></div>
 <div class="card" id="c-idle"><div class="hd"><h2>Стои без движение</h2><span class="sub" id="idle-sub"></span></div><div id="idle"><div class="sk" style="height:40px"></div></div></div>
</div>
<div class="lnk" id="lnk"></div>
</div><div class="tip" id="tip"></div>
<script>
var C=${cfg};var D={point:null,cex:null,stock:null,orders:null};
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
var nf0=new Intl.NumberFormat("bg-BG",{maximumFractionDigits:0}),nf2=new Intl.NumberFormat("bg-BG",{minimumFractionDigits:2,maximumFractionDigits:2}),nf1=new Intl.NumberFormat("bg-BG",{maximumFractionDigits:1});
function eur(n){return nf0.format(Math.round(n||0))}
function tmS(iso){return new Intl.DateTimeFormat("bg-BG",{timeZone:"Europe/Sofia",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso))}
function dayS(iso){var d=new Date(iso),t=new Date();var a=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Sofia"});var s=a.format(d),n=a.format(t),y=a.format(new Date(Date.now()-864e5));return s===n?"днес":s===y?"вчера":s.slice(8)+"."+s.slice(5,7)}
function fail(id,part){var e=$(id);if(e)e.innerHTML='<div class="err">Не се чете сега. <a onclick="load(\\''+part+'\\')">Опитай пак</a></div>'}
function getPart(part){return fetch("/api/cex-plan?view=ownerdata&part="+part+"&k="+encodeURIComponent(C.k),{cache:"no-store"}).then(function(r){return r.json()})}
function stamp(){var d=$("dot");d.className="dot";$("upd").textContent="обновено "+tmS(new Date().toISOString())}
function kpi(id,icon,cls,label,val,unit,sub,bad){var e=$(id);e.className="card k"+(bad?" bad":"");e.innerHTML='<div class="l"><span class="ic '+cls+'">'+icon+'</span>'+label+'</div><div class="v">'+val+(unit?'<small>'+unit+'</small>':'')+'</div><div class="sub">'+sub+'</div>'}
function delta(cur,base,txt){if(base==null||base<20)return '<span class="dl n">'+(base==null?"":txt+" "+eur(base)+" €")+'</span>';var p=(cur-base)/base*100;var c=p>=0?"up":"down";return '<span class="dl '+c+'">'+(p>=0?"▲ ":"▼ ")+Math.abs(p).toFixed(0)+"%</span><span>"+txt+"</span>"}
function renderPoint(p){
  var cmp=p.cmp;kpi("k-point","🏪","","Точка · днес",eur(p.today),"€",(cmp?delta(cmp.today,cmp.lastWeek,"спрямо "+cmp.hm+" миналата седмица"):"")+'<span>месец '+eur(p.month)+' €</span>');
}
function renderCex(c){
  kpi("k-cex","🏭","m","Цех · днес",eur(c.today),"€",'<span>'+c.stokovi_n+' стокови</span><span>месец '+eur(c.month)+' €</span>');
  var el=$("stok");$("stok-sub").textContent=c.clients.length?c.clients.length+" клиента":"";
  if(!c.clients.length){el.innerHTML='<div class="empty">Още няма стокови днес.</div>';return}
  var mx=c.clients[0].v||1,h="";c.clients.slice(0,12).forEach(function(x){h+='<div class="cl"><span class="n" title="'+esc(x.name)+'">'+esc(x.name)+'</span><span class="v">'+nf0.format(Math.round(x.v))+' €'+(x.n>1?' · '+x.n:'')+'</span><div class="t"><i style="width:'+Math.max(3,Math.round(x.v/mx*100))+'%"></i></div></div>'});
  if(c.clients.length>12)h+='<div class="empty">+ още '+(c.clients.length-12)+'</div>';el.innerHTML=h}
function renderStock(s){
  kpi("k-stock","📦","","Склад",eur(s.value),"€",'<span>'+(s.zero_n?'<b style="color:var(--down)">'+s.zero_n+' на нула</b>':'суровини и консумативи')+'</span>');
  kpi("k-order","🛒","w","За поръчка",s.risk_n,"арт.",'<span>'+s.sup_n+' доставчика</span>',s.risk_n>0);
  var el=$("risk");$("risk-sub").textContent=s.date?"към "+s.date.slice(8)+"."+s.date.slice(5,7):"";
  if(!s.groups.length){el.innerHTML='<div class="empty">Нищо не свършва преди следващата доставка.</div>'}else{
    var h="";s.groups.forEach(function(g,gi){
      h+='<div class="sup"><header><b>'+esc(g.sup)+'</b><span class="chip">доставка след '+nf1.format(g.lead)+' дни</span><span class="chip g">'+g.n+' арт.</span><a class="go" href="'+C.links.order+'" target="_blank">Поръчай →</a></header>';
      g.items.forEach(function(x,i){var pct=Math.min(100,Math.max(4,Math.round(Math.max(0,x.c)/Math.max(0.1,x.lead)*100)));
        h+='<div class="row" data-g="'+gi+'"'+(i>=5?' style="display:none"':'')+'><span class="n" title="'+esc(x.n)+'">'+esc(x.n)+'</span><span class="c" title="Покритие '+nf1.format(x.c)+' дни, доставка след '+nf1.format(x.lead)+'">'+nf1.format(x.c)+' дни</span><span class="o" title="Предложение до доставката след следващата">'+(x.need>0?nf1.format(x.need)+' '+esc(x.u):'—')+'</span><div class="bar"><i style="width:'+pct+'%"></i></div></div>'});
      if(g.items.length>5)h+='<div class="more" onclick="var r=this.parentNode.querySelectorAll(\\'.row\\');for(var i=0;i<r.length;i++)r[i].style.display=\\'grid\\';this.remove()">+ още '+(g.items.length-5)+'</div>';
      h+='</div>'});el.innerHTML=h}
  var idl=$("idle");$("idle-sub").textContent=s.idle_value?eur(s.idle_value)+" €":"";
  if(!s.idle.length)idl.innerHTML='<div class="empty">—</div>';else{var t="";s.idle.forEach(function(x){t+='<div class="cl"><span class="n" title="'+esc(x.n)+'">'+esc(x.n)+'</span><span class="v">'+nf1.format(x.s)+' '+esc(x.u)+' · '+eur(x.val)+' €</span></div>'});idl.innerHTML=t}
}
function renderOrders(o){var el=$("ord");if(!o.items.length){el.innerHTML='<div class="empty">Още няма записани поръчки. Всяка пратена от страницата „Поръчка към доставчик“ се записва тук.</div>';return}
  var h="";o.items.forEach(function(x){h+='<details class="ord"><summary><span class="t">'+dayS(x.at)+' '+tmS(x.at)+'</span><b>'+esc(x.sup)+'</b><span class="sub">'+x.n+' реда</span></summary><pre>'+esc(x.text)+'</pre></details>'});el.innerHTML=h}
function niceMax(m){if(m<=0)return 1;var p=Math.pow(10,Math.floor(Math.log10(m))),f=m/p;return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p}
function drawChart(){
  var a=D.point&&D.point.series,b=D.cex&&D.cex.series;if(!a&&!b)return;var svg=$("chart");var W=svg.clientWidth||700,H=230,L=44,R=10,T=10,B=24;
  var n=(a||b).length,mx=niceMax(Math.max.apply(null,(a||[]).map(function(x){return x.v}).concat((b||[]).map(function(x){return x.v}))));
  function X(i){return L+(W-L-R)*(n>1?i/(n-1):0)}function Y(v){return T+(H-T-B)*(1-v/mx)}
  var s='';for(var t=0;t<=4;t++){var v=mx*t/4,y=Y(v);s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="var(--line)"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="11" fill="var(--muted)">'+(v>=1000?nf1.format(v/1000)+"k":Math.round(v))+'</text>'}
  var base=(a||b);[0,Math.floor((n-1)/2),n-1].forEach(function(i){s+='<text x="'+X(i)+'" y="'+(H-6)+'" text-anchor="'+(i===0?"start":i===n-1?"end":"middle")+'" font-size="11" fill="var(--muted)">'+base[i].d.slice(8)+'.'+base[i].d.slice(5,7)+'</text>'});
  function line(ser,col){var d="";ser.forEach(function(p,i){d+=(i?"L":"M")+X(i).toFixed(1)+" "+Y(p.v).toFixed(1)});return '<path d="'+d+'" fill="none" stroke="'+col+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'+'<circle cx="'+X(ser.length-1)+'" cy="'+Y(ser[ser.length-1].v)+'" r="3.5" fill="'+col+'"/>'}
  if(b)s+=line(b,"var(--money)");if(a)s+=line(a,"var(--accent)");
  s+='<rect id="hit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'" fill="transparent"/><line id="vl" y1="'+T+'" y2="'+(H-B)+'" stroke="var(--line2)" style="display:none"/>';
  svg.setAttribute("viewBox","0 0 "+W+" "+H);svg.innerHTML=s;
  var hit=$("hit"),tip=$("tip"),vl=$("vl");
  function mv(ev){var r=svg.getBoundingClientRect(),px=(ev.touches?ev.touches[0].clientX:ev.clientX)-r.left,i=Math.round((px-L)/((W-L-R)/Math.max(1,n-1)));i=Math.max(0,Math.min(n-1,i));
    vl.setAttribute("x1",X(i));vl.setAttribute("x2",X(i));vl.style.display="";var d=base[i].d;
    tip.innerHTML='<b>'+d.slice(8)+'.'+d.slice(5,7)+'</b>'+(a?'Точка '+nf0.format(Math.round(a[i].v))+' €<br>':'')+(b?'Цех '+nf0.format(Math.round(b[i].v))+' €':'');tip.style.display="block";
    var tx=(ev.touches?ev.touches[0].clientX:ev.clientX)+14,ty=(ev.touches?ev.touches[0].clientY:ev.clientY)-10;tip.style.left=Math.min(tx,window.innerWidth-170)+"px";tip.style.top=ty+"px"}
  hit.addEventListener("mousemove",mv);hit.addEventListener("touchmove",mv,{passive:true});hit.addEventListener("mouseleave",function(){tip.style.display="none";vl.style.display="none"});
}
function load(part){
  var map={point:["k-point",renderPoint],cex:["k-cex",renderCex],stock:["k-stock",renderStock],orders:["ord",renderOrders]};
  return getPart(part).then(function(j){
    if(!j||!j.ok)throw new Error("x");D[part]=j;map[part][1](j);if(part==="point"||part==="cex")drawChart();stamp()
  }).catch(function(){if(part==="point")fail("k-point","point");else if(part==="cex"){fail("k-cex","cex");fail("stok","cex")}else if(part==="stock"){fail("k-stock","stock");fail("k-order","stock");fail("risk","stock");fail("idle","stock")}else fail("ord","orders")})
}
function all(){["point","cex","stock","orders"].forEach(load)}
$("rf").onclick=function(){$("dot").className="dot off";$("upd").textContent="обновявам…";all()};
var lk='';if(C.links.order)lk+='<a class="pill" href="'+C.links.order+'" target="_blank">🛒 Поръчка към доставчик</a>';if(C.links.stock)lk+='<a class="pill" href="'+C.links.stock+'" target="_blank">📦 Склад — пълен</a>';if(C.links.shop)lk+='<a class="pill" href="'+C.links.shop+'" target="_blank">🏪 Точка — подробно</a>';if(C.links.cex)lk+='<a class="pill" href="'+C.links.cex+'" target="_blank">🏭 Цех — подробно</a>';if(C.links.clock)lk+='<a class="pill" href="'+C.links.clock+'" target="_blank">⏱ Часове</a>';
$("lnk").innerHTML=lk;
window.addEventListener("resize",function(){drawChart()});
all();setInterval(all,300000);
</script></body></html>`;
}

module.exports = { ownerKey, keyOk, partData, page, pointView, cexView, stockView, ordersView, series, plusDays, sofiaDate };
