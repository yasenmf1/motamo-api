// lib/clockdash.js — табло за собственика (кой е на работа, карта с геозоните, закъснели) + Форма 76 (присъствена форма за печат).
// Достъп: ?view=clockdash&k=<hoursKey>  и  ?view=form76&k=<hoursKey>&m=YYYY-MM[&site=cex|shop]
const TC = require("./timeclock.js");
const REM = require("./clockremind.js");
const I = TC._i;
const esc = I.esc;

const ABB = { in: "Започна", out: "Приключи", break_start: "Почивка", break_end: "Върна се" };
const jsonSafe = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

async function dashData(now) {
  now = now || new Date();
  const today = I.sofiaDateOf(now), prev = new Date(now.getTime() - 24 * 3600000);
  const staff = ((await I.staffAll()) || []).filter(s => s.active);
  const rows = (await I.rpc("tc_rows", { p_from: I.sofiaDateOf(prev), p_to: today })) || [];
  const sched = (await I.rpc("tc_sched_list")) || [];
  const dow = REM.isoDow(today), nowMin = REM.sofiaMin(now);
  const sess = I.sessions(rows, now);
  const month = await I.monthData(today.slice(0, 7), now);
  const mt = {}; month.totals.forEach(t => { mt[t.user_id] = t; });
  const people = staff.map(s => {
    const uid = Number(s.user_id), mine = rows.filter(r => Number(r.user_id) === uid);
    const last = mine.length ? mine[mine.length - 1] : null;
    const st = last ? I.stateOf(last, now) : "off";
    const cur = sess.find(x => Number(x.user_id) === uid && x.flag === "working");
    const todayRows = mine.filter(r => r.for_date === today);
    const done = sess.filter(x => Number(x.user_id) === uid && x.date === today && x.end).reduce((a, x) => a + x.min, 0);
    const live = cur && st !== "off" ? Math.max(0, (now - new Date(cur.start)) / 60000 - cur.brk) : 0;
    const sc = sched.find(x => Number(x.user_id) === uid);
    const scToday = !!(sc && (sc.days || []).includes(dow));
    const st0 = sc ? REM.startFor(sc, dow) : null;
    const a = st0 ? Number(String(st0).split(":")[0]) * 60 + Number(String(st0).split(":")[1]) : null;
    const hasIn = todayRows.some(r => r.kind === "in");
    const late = scToday && a != null && !hasIn && st === "off" && nowMin >= a + 10;
    const t = mt[uid];
    const withDist = todayRows.filter(r => r.dist_m != null);
    return {
      id: uid, name: s.name, site: s.site, state: st, since: cur && st !== "off" ? cur.start : null,
      todayMin: Math.round(done + live), brk: cur && st !== "off" ? Math.round(cur.brk) : 0, scToday, sched: sc ? st0 + "–" + sc.end_t : null, late,
      firstIn: (todayRows.find(r => r.kind === "in") || {}).at || null,
      lastDist: withDist.length ? withDist[withDist.length - 1].dist_m : null,
      monthMin: Math.round(t ? t.min : 0), monthDays: t ? t.days : 0, monthBrk: Math.round(t ? t.brk : 0)
    };
  });
  const points = rows.filter(r => r.for_date === today && r.lat != null).map(r => ({ name: r.name, kind: r.kind, at: r.at, lat: r.lat, lon: r.lon, d: r.dist_m }));
  return { now: now.toISOString(), today, people, points };
}

async function dashPage(k, now) {
  const d = await dashData(now);
  const fmtT = I.fmtT, hm = I.hm;
  const cnt = (f) => d.people.filter(f).length;
  const stat = (n, lbl, cls) => `<div class="c ${cls || ""}"><b>${n}</b><span>${lbl}</span></div>`;
  const pill = (p) => p.state === "work" ? '<span class="p w">на работа</span>' : p.state === "brk" ? '<span class="p b">на почивка</span>' : p.late ? '<span class="p l">закъснява</span>' : '<span class="p o">не е на работа</span>';
  const rowsHtml = d.people.sort((a, b) => (a.site === b.site ? a.name.localeCompare(b.name, "bg") : a.site.localeCompare(b.site))).map(p =>
    `<tr><td>${esc(p.name)}</td><td>${I.SITE_BG[p.site]}</td><td>${pill(p)}</td><td>${p.firstIn ? fmtT(p.firstIn) : "—"}</td><td>${p.todayMin ? hm(p.todayMin) : "—"}</td><td>${p.brk ? p.brk + " мин" : ""}</td><td>${p.sched ? esc(p.sched) + (p.scToday ? "" : " (днес почивен)") : "<i>няма график</i>"}</td><td>${p.lastDist != null ? p.lastDist + " м" : ""}</td><td>${p.monthMin ? hm(p.monthMin) : "—"}</td><td>${p.monthDays}</td></tr>`).join("");
  const ym = d.today.slice(0, 7), kk = encodeURIComponent(k);
  const data = jsonSafe({ sites: TC.SITES, points: d.points, kinds: ABB });
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO · Часове — табло</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"><style>
*{box-sizing:border-box}body{margin:0;font:15px system-ui,Segoe UI,Roboto,sans-serif;background:#eef0f3;color:#14171a}.w{max-width:1100px;margin:0 auto;padding:14px}
h1{font-size:21px;margin:6px 0 12px}h2{font-size:17px;margin:20px 0 8px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.c{background:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 1px 6px rgba(0,0,0,.08)}.c b{display:block;font-size:30px}.c span{font-size:13px;color:#666}.c.g b{color:#1f9d44}.c.a b{color:#e39a0b}.c.r b{color:#c9302c}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08);font-size:14px}th,td{padding:8px 9px;text-align:left;border-bottom:1px solid #eee;white-space:nowrap}th{background:#1b2430;color:#fff}
.tb{overflow-x:auto}.p{padding:3px 9px;border-radius:99px;font-size:12px;font-weight:600}.p.w{background:#dff5e3;color:#14692b}.p.b{background:#fff0cf;color:#8a5a00}.p.l{background:#fde3e1;color:#a3231f}.p.o{background:#eee;color:#555}
#map{height:380px;border-radius:14px;box-shadow:0 1px 6px rgba(0,0,0,.08)}.nav a{display:inline-block;margin:0 8px 8px 0;padding:8px 13px;background:#fff;border-radius:9px;text-decoration:none;color:#14171a;box-shadow:0 1px 4px rgba(0,0,0,.1)}.note{color:#666;font-size:13px;margin-top:12px}
</style></head><body><div class="w"><h1>⏱ Часове — табло · ${esc(d.today.slice(8))}.${esc(d.today.slice(5, 7))}.${esc(d.today.slice(0, 4))}</h1>
<div class="cards">${stat(cnt(p => p.state === "work"), "на работа", "g")}${stat(cnt(p => p.state === "brk"), "на почивка", "a")}${stat(cnt(p => p.late), "закъсняват", "r")}${stat(cnt(p => p.state === "off" && !p.late), "не са на работа")}</div>
<h2>Днес</h2><div class="tb"><table><tr><th>Служител</th><th>Обект</th><th>Състояние</th><th>Започна</th><th>Днес</th><th>Почивка</th><th>График</th><th>Разст. при отбелязване</th><th>Месец</th><th>Дни</th></tr>${rowsHtml || "<tr><td colspan=10>Екипът е празен.</td></tr>"}</table></div>
<h2>Карта — геозони и отбелязвания днес</h2><div id="map"></div>
<h2>Справки</h2><p class="nav"><a href="/api/transfer?view=form76&k=${kk}&m=${ym}&site=cex">📄 Форма 76 · Цех</a><a href="/api/transfer?view=form76&k=${kk}&m=${ym}&site=shop">📄 Форма 76 · Точка</a><a href="/api/transfer?view=hours&k=${kk}&m=${ym}">📋 Таблица за месеца</a><a href="/api/transfer?view=hours&k=${kk}&m=${ym}&fmt=csv">⬇ CSV</a><a href="/api/transfer?view=clockteam&k=${kk}">🔗 Връзки на служителите</a></p>
<p class="note">Таблото се обновява само на минута. Почивките са неплатени и са приспаднати. „Закъснява“ се показва само при въведен график.</p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script><script>
var D=${data};
(function(){
  if(!window.L){document.getElementById("map").innerHTML="<p style='padding:14px'>Картата не се зареди.</p>";return}
  var s=D.sites,map=L.map("map").setView([42.434,25.647],13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map);
  var names={cex:"Цех",shop:"Точка"},b=[];
  Object.keys(s).forEach(function(k){L.circle([s[k].lat,s[k].lon],{radius:s[k].r,color:"#c9302c",fillOpacity:.1}).addTo(map).bindTooltip(names[k]+" — геозона "+s[k].r+" м");b.push([s[k].lat,s[k].lon])});
  var col={in:"#1f9d44",out:"#c9302c",break_start:"#e39a0b",break_end:"#2878d6"};
  D.points.forEach(function(p){var t=new Date(p.at).toLocaleTimeString("bg-BG",{timeZone:"Europe/Sofia",hour:"2-digit",minute:"2-digit"});
    L.circleMarker([p.lat,p.lon],{radius:7,color:"#fff",weight:2,fillColor:col[p.kind]||"#333",fillOpacity:1}).addTo(map).bindPopup(p.name+" · "+(D.kinds[p.kind]||p.kind)+" "+t+(p.d!=null?" · "+p.d+" м":""));b.push([p.lat,p.lon])});
  if(b.length)map.fitBounds(b,{padding:[30,30],maxZoom:16});
})();
setTimeout(function(){location.reload()},60000);
</script></body></html>`;
}

// ── Форма 76 ─────────────────────────────────────────────────────────────────
function nightMin(startIso, endIso) {              // минути между 22:00 и 06:00 (София), по часовника от начало до край
  const s = new Date(startIso), e = new Date(endIso); let n = 0;
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", hour12: false }).format(s).split(":");
  const lm = (Number(p[0]) % 24) * 60 + Number(p[1]), total = Math.max(0, Math.round((e - s) / 60000));
  for (let i = 0; i < total; i++) { const m = (lm + i) % 1440; if (m < 360 || m >= 1320) n++; }
  return n;
}
const dec = (min) => { const h = Math.round(min / 6) / 10; return (Number.isInteger(h) ? String(h) : h.toFixed(1)).replace(".", ","); };

async function form76Data(ym, site, now) {
  const md = await I.monthData(ym, now || new Date());
  const b = I.monthRange(ym)[1], days = Number(b.slice(8));
  const by = {};
  const blank = (s) => ({ user_id: s.user_id, name: s.name, site: s.site, day: {}, min: 0, brk: 0, night: 0, dset: new Set() });
  md.sess.filter(s => s.end && (!site || s.site === site)).forEach(s => {
    const u = by[s.user_id] = by[s.user_id] || blank(s);
    const d = Number(s.date.slice(8)); u.day[d] = (u.day[d] || 0) + s.min; u.min += s.min; u.brk += s.brk || 0; u.night += nightMin(s.start, s.end); if (s.min > 0) u.dset.add(s.date);
  });
  ((await I.staffAll()) || []).filter(x => x.active && (!site || x.site === site)).forEach(x => { if (!by[x.user_id]) by[x.user_id] = blank({ user_id: x.user_id, name: x.name, site: x.site }); });
  const list = Object.values(by).sort((x, y) => (x.site === y.site ? x.name.localeCompare(y.name, "bg") : x.site.localeCompare(y.site)));
  return { ym, days, list };
}

async function form76Page(ym, site, now) {
  now = now || new Date();
  if (!/^\d{4}-\d{2}$/.test(String(ym || ""))) ym = I.sofiaDateOf(now).slice(0, 7);
  if (site !== "cex" && site !== "shop") site = null;
  const D = await form76Data(ym, site, now);
  const MONTHS = ["", "януари", "февруари", "март", "април", "май", "юни", "юли", "август", "септември", "октомври", "ноември", "декември"];
  const dow = (d) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1, d)).getUTCDay();
  const we = (d) => { const w = dow(d); return w === 0 || w === 6 ? " we" : ""; };
  const hdr = Array.from({ length: D.days }, (_, i) => `<th class="d${we(i + 1)}">${i + 1}</th>`).join("");
  const tables = ["cex", "shop"].filter(st => !site || st === site).map(st => {
    const g = D.list.filter(p => p.site === st); if (!g.length) return "";
    const body = g.map((p, i) => `<tr><td>${i + 1}</td><td class="n">${esc(p.name)}</td><td></td>${Array.from({ length: D.days }, (_, j) => `<td class="d${we(j + 1)}">${p.day[j + 1] ? dec(p.day[j + 1]) : ""}</td>`).join("")}<td><b>${p.dset.size}</b></td><td><b>${dec(p.min)}</b></td><td>${p.night ? dec(p.night) : ""}</td><td>${p.brk ? Math.round(p.brk) : ""}</td><td></td><td></td></tr>`).join("");
    const tot = g.reduce((a, p) => a + p.min, 0);
    return `<section><h2>Обект: ${I.SITE_BG[st]}</h2><table><tr><th>№</th><th>Име</th><th>Длъжност</th>${hdr}<th>Дни</th><th>Часове</th><th>Нощни</th><th>Почивки (мин)</th><th>Отпуск</th><th>Болн.</th></tr>${body}
<tr class="t"><td colspan="${3 + D.days}">Общо часове за обекта</td><td></td><td><b>${dec(tot)}</b></td><td colspan="4"></td></tr></table></section>`;
  }).join("");
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Форма 76 — ${esc(MONTHS[Number(ym.slice(5))])} ${esc(ym.slice(0, 4))}</title><style>
@page{size:A4 landscape;margin:9mm}*{box-sizing:border-box}body{margin:0;font:11px system-ui,Segoe UI,Arial,sans-serif;color:#000;background:#fff}.w{padding:10px}
h1{font-size:15px;text-align:center;margin:0 0 2px}.sub{text-align:center;margin:0 0 8px;font-size:12px}h2{font-size:12px;margin:10px 0 4px}
table{width:100%;border-collapse:collapse;table-layout:fixed;margin-bottom:8px}th,td{border:1px solid #000;padding:2px 1px;text-align:center;font-size:9px;overflow:hidden}
th{background:#eee}td.n{text-align:left;padding-left:3px;font-size:10px;white-space:nowrap}th:nth-child(1),td:nth-child(1){width:18px}th:nth-child(2){width:72px}th:nth-child(3){width:48px}.d{width:15px}.we{background:#f1f1f1}tr.t td{text-align:right;padding-right:4px}
.sg{display:flex;justify-content:space-between;margin-top:16px;font-size:11px}.sg div{width:30%;border-top:1px solid #000;padding-top:3px;text-align:center}.note{font-size:9px;color:#444;margin-top:8px}
.bar{padding:8px;background:#eef0f3;text-align:center}.bar button{font-size:15px;padding:8px 18px}@media print{.bar{display:none}.w{padding:0}}
</style></head><body><div class="bar"><button onclick="print()">🖨 Печат / PDF</button></div><div class="w">
<h1>ПРИСЪСТВЕНА ФОРМА (Форма 76) — ${esc(MONTHS[Number(ym.slice(5))])} ${esc(ym.slice(0, 4))}</h1>
<p class="sub">Работодател: ЧОВЕК И БЪДЕЩЕ ЕООД (МОТАМО) · отработени часове по дни (десетични)</p>
${tables || "<p>Няма данни.</p>"}
<div class="sg"><div>Съставил</div><div>Работодател</div><div>Дата</div></div>
<p class="note">Часовете са по отбелязванията в приложението (с проверка на местоположението). Почивките са неплатени и са приспаднати от часовете. „Длъжност“, „Отпуск“ и „Болн.“ се попълват ръчно. Образец за преглед от счетоводителя — не е официален документ, докато не бъде подписан.</p></div></body></html>`;
}

module.exports = { dashData, dashPage, form76Page, form76Data, nightMin };
