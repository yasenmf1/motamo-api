// lib/ownerdash.js — „Табло на собственика" v2: оборот точка/цех със сравнения, дни от седмицата, часове, канали и плащане,
// най-продавани, топ клиенти на цеха, склад по доставчик, какво ще свърши преди доставка, пратени поръчки.
// Само четене (нищо не пише в Barsy). Страницата се зарежда веднага, а всяка част идва от своя адрес (?view=ownerdata&part=…)
// и се рисува, когато е готова — бавна или счупена част не спира останалите.
// Ключ: sha256("motamo-owner-dash:" + PEEK_TOKEN) — изведен, без нови променливи на средата.
const crypto = require("crypto");

const ownerKey = () => process.env.PEEK_TOKEN
  ? crypto.createHash("sha256").update("motamo-owner-dash:" + process.env.PEEK_TOKEN).digest("hex").slice(0, 24) : null;
const keyOk = (k) => { const e = ownerKey(); return !!(e && typeof k === "string" && k.length === e.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(e))); };

const sofiaDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(d || new Date());
const sofiaHms = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Sofia", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d || new Date());
const plusDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const isoDow = (iso) => { const d = new Date(iso + "T12:00:00Z").getUTCDay(); return d === 0 ? 7 : d; };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const prevMonthStart = (to) => { let y = +to.slice(0, 4), m = +to.slice(5, 7) - 1; if (m < 1) { m = 12; y--; } return y + "-" + String(m).padStart(2, "0") + "-01"; };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// ── малък кеш (60 с) — да не питаме Barsy при всяко отваряне ───────────────────
const CACHE = new Map();
async function cached(key, ttlMs, fn) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  CACHE.set(key, { t: Date.now(), v });
  return v;
}

// ── общи изчисления ────────────────────────────────────────────────────────────
function series(byDay, from, to) {
  const out = [];
  for (let d = from; d <= to; d = plusDays(d, 1)) out.push({ d, v: r2(byDay && byDay[d]) });
  return out;
}
// този месец до днес спрямо миналия месец за същите дни
function mtdPair(byDay, to) {
  const y = +to.slice(0, 4), m = +to.slice(5, 7), dom = +to.slice(8), ym = to.slice(0, 7);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1, pym = py + "-" + String(pm).padStart(2, "0"), cap = Math.min(dom, daysInMonth(py, pm));
  let cur = 0, prev = 0;
  for (const d of Object.keys(byDay || {})) {
    const v = byDay[d] || 0;
    if (d.startsWith(ym) && +d.slice(8) <= dom) cur += v; else if (d.startsWith(pym) && +d.slice(8) <= cap) prev += v;
  }
  return { cur: r2(cur), prev: r2(prev), days: dom, prevMonth: pym };
}
// 7 пълни дни, завършващи вчера (offset 0) или преди още 7 дни (offset 7)
const weekSum = (byDay, to, offset) => { let t = 0; for (let i = 1; i <= 7; i++) t += (byDay && byDay[plusDays(to, -i - offset)]) || 0; return r2(t); };
// средно за ден от седмицата — само дни с продажби, без днешния (още не е свършил)
function weekdayAvg(byDay, from, to) {
  const sum = Array(8).fill(0), n = Array(8).fill(0);
  for (let d = from; d < to; d = plusDays(d, 1)) { const v = (byDay && byDay[d]) || 0; if (v > 0) { const w = isoDow(d); sum[w] += v; n[w]++; } }
  return [1, 2, 3, 4, 5, 6, 7].map(w => ({ dow: w, avg: n[w] ? r2(sum[w] / n[w]) : 0, n: n[w] }));
}
const bestDay = (s) => s.reduce((b, x) => (x.v > (b ? b.v : 0) ? x : b), null);

// ── ТОЧКА ─────────────────────────────────────────────────────────────────────
function pointView(data, from, to) {
  const by = data.by_day || {}, s = series(by, from, to);
  const hours = Array.from({ length: 24 }, (_, h) => r2((data.by_hour || {})[h]));
  const pay = data.pay || {};
  const prods = data.products || [], movers = data.movers || [];
  const top = prods.slice(0, 8).map((p, i) => {
    const mv = movers[i] && movers[i].name === p.name ? movers[i] : null;
    return { n: p.name, rev: r2(p.revenue), units: Math.round(p.units || 0), prev: mv ? r2(mv.prev) : null, delta: mv && mv.delta_pct != null ? Math.round(mv.delta_pct) : null };
  });
  return {
    ok: true, from, to, series: s, today: r2(by[to]), cmp: data.cmp || null, mtd: mtdPair(by, to),
    w7: { cur: weekSum(by, to, 0), prev: weekSum(by, to, 7) }, wd: weekdayAvg(by, from, to), hours,
    online: r2(data.online_neto), counter: r2(data.counter_neto), onlineN: data.online_n | 0, counterN: data.counter_n | 0,
    pay: { cash: r2(pay.cash && pay.cash.neto), card: r2(pay.card && pay.card.neto), other: r2(pay.other && pay.other.neto), used: !!data.pay_used },
    top, accounts: data.accounts || 0, avg_check: r2(data.avg_check), best: bestDay(s), units_truncated: !!data.units_truncated
  };
}

// ── ЦЕХ ───────────────────────────────────────────────────────────────────────
// accs: затворени сметки на цеха { d: "YYYY-MM-DD", t: "HH:MM:SS", v: нето, cid, name } (нето = с ДДС ÷ 1,2, както в цеховото табло).
function cexView(accs, from, to, now) {
  const wk = plusDays(to, -7), d30 = plusDays(to, -29);
  const byDay = {}, today = {}, c30 = {}; let todayN = 0, cT = 0, cTn = 0, cW = 0, cWn = 0;
  for (const a of accs) {
    if (!a || a.d < from || a.d > to) continue;
    byDay[a.d] = (byDay[a.d] || 0) + a.v;
    if (a.d === to) { todayN++; const c = today[a.cid] || (today[a.cid] = { v: 0, n: 0 }); c.v += a.v; c.n++; }
    if (a.d >= d30) { const c = c30[a.cid] || (c30[a.cid] = { id: a.cid, name: a.name, v: 0, n: 0 }); c.v += a.v; c.n++; }
    if (a.d === to) { cT += a.v; cTn++; } else if (a.d === wk) { cW += a.v; cWn++; }       // цял ден срещу цял ден: стоковете се затварят в различен час
  }
  const s = series(byDay, from, to);
  const clients = Object.values(c30).map(c => ({ id: c.id, name: c.name, v: r2(c.v), n: c.n, today: r2(today[c.id] && today[c.id].v), todayN: today[c.id] ? today[c.id].n : 0 }))
    .filter(c => c.v > 0).sort((x, y) => y.v - x.v);
  return {
    ok: true, from, to, series: s, today: r2(byDay[to]), stokovi_n: todayN, cmp: { today: r2(cT), lastWeek: r2(cW), hm: null, todayN: cTn, lastWeekN: cWn },
    mtd: mtdPair(byDay, to), w7: { cur: weekSum(byDay, to, 0), prev: weekSum(byDay, to, 7) }, wd: weekdayAvg(byDay, from, to),
    clients, today_clients: clients.filter(c => c.today > 0).length, best: bestDay(s)
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
  const idleTop = idle.slice().sort((a, b) => b.val - a.val).slice(0, 6).map(x => ({ n: x.n, s: x.s, u: x.u, val: x.val }));
  // стойност по доставчик (суровини и консумативи) и колко артикула са на колко дни покритие
  const sv = {}; for (const r of raw) { const k = r.sup || "—"; sv[k] = (sv[k] || 0) + (r.val || 0); }
  const bySup = Object.keys(sv).map(k => ({ sup: k, v: Math.round(sv[k]) })).filter(x => x.v > 0).sort((a, b) => b.v - a.v);
  const cover = [["до 3 дни", 0, 3], ["3–7", 3, 7], ["7–14", 7, 14], ["14–30", 14, 30], ["над 30", 30, 1e9]]
    .map(([l, a, b]) => ({ l, n: raw.filter(r => r.c != null && r.c >= a && r.c < b).length, bad: b <= 7 }));
  return {
    ok: true, value: Math.round(value), risk_n: risky.length, sup_n: groups.length, zero_n: zero, groups, idle: idleTop, idle_value: Math.round(idle.reduce((a, x) => a + (x.val || 0), 0)),
    by_sup: bySup.slice(0, 6), by_sup_rest: Math.round(bySup.slice(6).reduce((a, x) => a + x.v, 0)), cover, date: rep && rep.for_date || null
  };
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
  const to = sofiaDate(now), from = prevMonthStart(to);        // от 1-во число на миналия месец (≤ 62 дни)
  if (part === "point") return cached("point", 60000, async () => pointView(await deps.shopDashData(from, to, 0, deps.shopUser, deps.shopPass), from, to));
  if (part === "cex") return cached("cex", 60000, async () => cexView(await deps.cexAccounts(from, to), from, to, now));
  if (part === "stock") return cached("stock", 60000, async () => stockView(await deps.stockReport()));
  if (part === "orders") return ordersView(await deps.soList());
  return { ok: false, error: "part" };
}

// ── СТРАНИЦА ──────────────────────────────────────────────────────────────────
const CSS = String.raw`
:root{color-scheme:light dark;--page:light-dark(#f6f6f3,#0b0b0d);--card:light-dark(#fff,#141417);--soft:light-dark(#f0f0ed,#1c1c20);--ink:light-dark(#17171a,#f3f3f5);--ink2:light-dark(#48484d,#c4c4ca);--muted:light-dark(#66666d,#8c8c95);
--line:light-dark(rgb(0 0 0/.075),rgb(255 255 255/.08));--line2:light-dark(rgb(0 0 0/.14),rgb(255 255 255/.16));--accent:light-dark(#3e63dd,#7b96ff);--money:light-dark(#0f7f57,#34c48b);--up:var(--money);--down:light-dark(#d23f45,#ff6b70);--warn:light-dark(#c98a00,#f6b100);--tip:light-dark(#1f2530,#2a3548);--live:#12a150;
--shadow:0 1px 2px rgb(0 0 0/.04),0 1px 1px rgb(0 0 0/.02)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--page);color:var(--ink);font:13.5px/1.4 Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1500px;margin:0 auto;padding:14px 14px calc(26px + env(safe-area-inset-bottom))}
.top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px}.top h1{font-size:18px;font-weight:600;margin:0 auto 0 0}
.pill{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:99px;background:var(--card);border:1px solid var(--line);font-size:12.5px;color:var(--ink2);box-shadow:var(--shadow);text-decoration:none}
.dot{width:7px;height:7px;border-radius:50%;background:var(--live);box-shadow:0 0 0 0 rgb(18 161 80/.5);animation:pulse 2s infinite}.dot.off{background:var(--muted);animation:none}
@keyframes pulse{70%{box-shadow:0 0 0 7px rgb(18 161 80/0)}100%{box-shadow:0 0 0 0 rgb(18 161 80/0)}}
button.pill{cursor:pointer;font:inherit;font-size:12.5px}button.pill:hover{background:var(--soft)}
.g{display:grid;gap:10px;grid-template-columns:repeat(12,minmax(0,1fr))}.s3{grid-column:span 3}.s4{grid-column:span 4}.s5{grid-column:span 5}.s6{grid-column:span 6}.s7{grid-column:span 7}.s8{grid-column:span 8}.s12{grid-column:span 12}
@media(max-width:1180px){.s3{grid-column:span 6}.s4,.s5{grid-column:span 6}.s7,.s8{grid-column:span 12}}
@media(max-width:760px){.g{gap:8px}.s3{grid-column:span 6}.s4,.s5,.s6,.s7,.s8{grid-column:span 12}.wrap{padding:10px 10px 24px}}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:11px 13px;box-shadow:var(--shadow);min-width:0;opacity:0;transform:translateY(8px);animation:rise .55s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes rise{to{opacity:1;transform:none}}
.g>.card:nth-child(1){animation-delay:.02s}.g>.card:nth-child(2){animation-delay:.07s}.g>.card:nth-child(3){animation-delay:.12s}.g>.card:nth-child(4){animation-delay:.17s}.g>.card:nth-child(5){animation-delay:.22s}.g>.card:nth-child(6){animation-delay:.27s}.g>.card:nth-child(n+7){animation-delay:.32s}
h2{font-size:13.5px;font-weight:600;margin:0}.hd{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap}.sub{color:var(--muted);font-size:12px;display:flex;gap:6px 9px;flex-wrap:wrap;align-items:center;font-variant-numeric:tabular-nums}
.seg{display:inline-flex;background:var(--soft);border-radius:8px;padding:2px;gap:2px}.seg button{border:0;background:transparent;color:var(--ink2);font:inherit;font-size:12px;padding:3px 9px;border-radius:6px;cursor:pointer}.seg button.on{background:var(--card);color:var(--ink);box-shadow:var(--shadow);font-weight:500}
.k{display:flex;flex-direction:column;gap:2px;position:relative;overflow:hidden;min-height:128px}.k .l{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12.5px}
.ic{width:21px;height:21px;border-radius:6px;display:grid;place-items:center;font-size:12px;background:color-mix(in srgb,var(--accent) 12%,transparent)}.ic.m{background:color-mix(in srgb,var(--money) 13%,transparent)}.ic.o{background:color-mix(in srgb,var(--warn) 18%,transparent)}
.k .v{font-size:26px;font-weight:600;letter-spacing:-.02em;margin:5px 0 1px;font-variant-numeric:tabular-nums;line-height:1.1}.k .v small{font-size:14px;color:var(--muted);font-weight:500;margin-left:3px}
.k .sp{height:34px;margin:auto -13px -11px;display:block;width:calc(100% + 26px)}
.dl{font-weight:600;font-size:12px}.dl.up{color:var(--up)}.dl.down{color:var(--down)}.dl.n{color:var(--muted);font-weight:500}
.k.bad{border-color:color-mix(in srgb,var(--warn) 45%,var(--line));background:color-mix(in srgb,var(--warn) 7%,var(--card))}.k.bad .v{color:var(--warn)}
.chart{width:100%;height:210px;display:block}.leg{display:flex;gap:12px;font-size:12px;color:var(--ink2);flex-wrap:wrap;align-items:center}.leg i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.ln{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round;stroke-dasharray:1;stroke-dashoffset:1;animation:dr 1.2s .1s ease forwards}@keyframes dr{to{stroke-dashoffset:0}}
.ar{opacity:0;animation:fi .9s .55s forwards}@keyframes fi{to{opacity:1}}
.gr{transform-origin:left center;transform:scaleX(0);transition:transform .9s cubic-bezier(.2,.7,.2,1)}.gr.on{transform:scaleX(1)}
.vb{display:flex;align-items:flex-end;gap:5px;height:118px}.vb .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%;min-width:0;gap:3px}
.vb .col i{display:block;width:100%;max-width:34px;border-radius:5px 5px 2px 2px;background:color-mix(in srgb,var(--accent) 30%,transparent);transform-origin:bottom;transform:scaleY(0);transition:transform .8s cubic-bezier(.2,.7,.2,1)}.vb .col i.on{transform:scaleY(1)}
.vb .col.hi i{background:var(--accent)}.vb .col.mo i{background:color-mix(in srgb,var(--money) 32%,transparent)}.vb .col.mo.hi i{background:var(--money)}.vb .col span{font-size:11px;color:var(--muted);line-height:1}.vb .col b{font-size:10.5px;font-weight:500;color:var(--ink2);line-height:1;font-variant-numeric:tabular-nums}
.pair{margin:8px 0 2px}.pair .r{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;margin:4px 0;font-size:12px;color:var(--muted)}.pair .r .t{height:8px;border-radius:5px;background:var(--line);overflow:hidden}.pair .r .t i{display:block;height:100%;border-radius:5px}.pair .r b{color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums;min-width:62px;text-align:right}
.pair .r span:first-child{min-width:78px}
.row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--line);position:relative;font-variant-numeric:tabular-nums}.row:first-of-type{border-top:0}.row .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .bar{position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;background:transparent}.row .bar i{display:block;height:100%;border-radius:2px;background:var(--money)}.row.w .bar i{background:var(--warn)}.row.a .bar i{background:var(--accent)}
.chip{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:99px;font-size:11px;font-weight:500;background:color-mix(in srgb,var(--warn) 18%,transparent);color:light-dark(#7a5300,#f6b100);white-space:nowrap}.chip.g2{background:color-mix(in srgb,var(--muted) 15%,transparent);color:var(--ink2)}
.sg{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}.sup{border:1px solid var(--line);border-radius:10px;overflow:hidden}.sup>header{display:flex;align-items:center;gap:6px;padding:6px 9px;background:var(--soft);flex-wrap:wrap}.sup>header b{font-weight:600;font-size:12.5px}.sup a.go{margin-left:auto;text-decoration:none;color:var(--accent);font-weight:500;font-size:12px}
.sup .row{padding:4px 9px;font-size:12.5px;grid-template-columns:minmax(0,1fr) 62px 66px}.sup .row .c{color:var(--down);font-weight:600;text-align:right}.sup .row .o{text-align:right;font-weight:500}.more{padding:5px 9px;border-top:1px solid var(--line);color:var(--accent);cursor:pointer;font-size:12px}
.seq{display:flex;height:9px;border-radius:6px;overflow:hidden;gap:2px;margin:6px 0 4px}.seq i{display:block;height:100%;transform-origin:left;transform:scaleX(0);transition:transform .9s cubic-bezier(.2,.7,.2,1)}.seq i.on{transform:scaleX(1)}
.lg2{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums}.lg2 i{display:inline-block;width:8px;height:8px;border-radius:3px;margin-right:4px}
.mix h3{font-size:11.5px;font-weight:500;color:var(--muted);margin:8px 0 0}
.ord{padding:5px 0;border-top:1px solid var(--line)}.ord:first-child{border-top:0}.ord summary{cursor:pointer;display:flex;gap:8px;align-items:center;list-style:none;font-size:12.5px}.ord summary::-webkit-details-marker{display:none}.ord pre{white-space:pre-wrap;font:12px/1.45 inherit;margin:6px 0 0;color:var(--ink2)}.ord .t{color:var(--muted);min-width:78px}
.sk{border-radius:8px;background:linear-gradient(90deg,var(--soft),var(--line),var(--soft));background-size:200% 100%;animation:sh 1.3s infinite;height:12px}@keyframes sh{to{background-position:-200% 0}}
.err{color:var(--muted);display:flex;gap:8px;align-items:center;flex-wrap:wrap}.err a{color:var(--accent);cursor:pointer}.empty{color:var(--muted);padding:6px 0;font-size:12.5px}
.tip{position:fixed;z-index:9;pointer-events:none;background:var(--tip);color:#fff;border-radius:9px;padding:7px 10px;font-size:12px;box-shadow:0 12px 32px -8px rgb(0 0 0/.3);display:none;font-variant-numeric:tabular-nums;max-width:240px}.tip b{display:block;font-size:14px;font-weight:600}
.lnk{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
@media(prefers-reduced-motion:reduce){.card,.ln,.ar,.gr,.vb .col i,.seq i,.dot,.sk{animation:none!important;transition:none!important}.card{opacity:1;transform:none}.ln{stroke-dashoffset:0}.ar{opacity:1}.gr,.vb .col i,.seq i{transform:none}}
`;

const BODY = String.raw`
<div class="wrap">
<div class="top"><h1>Табло</h1><span class="pill"><span class="dot off" id="dot"></span><span id="upd">зареждам…</span></span><button class="pill" id="rf">↻ Обнови</button></div>
<div class="g">
 <div class="card k s3" id="k-point"><div class="l"><span class="ic">🏪</span>Точка · днес</div><div class="sk" style="height:30px;width:60%;margin-top:8px"></div></div>
 <div class="card k s3" id="k-cex"><div class="l"><span class="ic m">🏭</span>Цех · днес</div><div class="sk" style="height:30px;width:60%;margin-top:8px"></div></div>
 <div class="card k s3" id="k-stock"><div class="l"><span class="ic">📦</span>Склад</div><div class="sk" style="height:30px;width:60%;margin-top:8px"></div></div>
 <div class="card k s3" id="k-order"><div class="l"><span class="ic o">🛒</span>За поръчка</div><div class="sk" style="height:30px;width:60%;margin-top:8px"></div></div>

 <div class="card s8"><div class="hd"><h2>Оборот</h2><div class="sub"><span class="seg" id="seg-who"><button data-v="both" class="on">Двете</button><button data-v="point">Точка</button><button data-v="cex">Цех</button></span><span class="seg" id="seg-n"><button data-v="14">14 д</button><button data-v="30" class="on">30 д</button><button data-v="all">Всичко</button></span></div></div>
  <svg class="chart" id="chart" role="img" aria-label="Оборот по дни"></svg><div class="leg" id="leg"></div></div>
 <div class="card s4" id="c-mtd"><div class="hd"><h2>Месец към месец</h2><span class="sub">същите дни</span></div><div id="mtd"><div class="sk" style="height:90px"></div></div></div>

 <div class="card s4" id="c-wd"><div class="hd"><h2>По дни от седмицата</h2><span class="seg" id="seg-wd"><button data-v="point" class="on">Точка</button><button data-v="cex">Цех</button></span></div><div id="wd"><div class="sk" style="height:118px"></div></div><div class="sub" id="wd-sub" style="margin-top:6px"></div></div>
 <div class="card s4" id="c-hours"><div class="hd"><h2>Кога се продава в точката</h2><span class="sub" id="h-sub"></span></div><div id="hours"><div class="sk" style="height:118px"></div></div></div>
 <div class="card s4 mix" id="c-mix"><div class="hd"><h2>Канал и плащане</h2><span class="sub">точка</span></div><div id="mix"><div class="sk" style="height:100px"></div></div></div>

 <div class="card s6" id="c-top"><div class="hd"><h2>Най-продавани в точката</h2><span class="sub" id="top-sub"></span></div><div id="top"><div class="sk" style="height:120px"></div></div></div>
 <div class="card s6" id="c-cl"><div class="hd"><h2>Клиенти на цеха · 30 дни</h2><span class="sub" id="cl-sub"></span></div><div id="cl"><div class="sk" style="height:120px"></div></div></div>

 <div class="card s8" id="c-risk"><div class="hd"><h2>Ще свърши преди доставка</h2><span class="sub" id="risk-sub"></span></div><div id="risk"><div class="sk" style="height:70px"></div></div></div>
 <div class="card s4" id="c-sup"><div class="hd"><h2>Склад</h2><span class="sub" id="sup-sub"></span></div><div id="sup"><div class="sk" style="height:110px"></div></div></div>

 <div class="card s6" id="c-ord"><div class="hd"><h2>Пратени поръчки към доставчици</h2></div><div id="ord"><div class="sk" style="height:40px"></div></div></div>
 <div class="card s6" id="c-idle"><div class="hd"><h2>Стои без движение</h2><span class="sub" id="idle-sub"></span></div><div id="idle"><div class="sk" style="height:40px"></div></div></div>
</div>
<div class="lnk" id="lnk"></div>
</div><div class="tip" id="tip"></div>`;

const JS = String.raw`
var C=window.C,D={point:null,cex:null,stock:null,orders:null},ST={who:"both",n:"30",wd:"point"};
var DOWN=["","пн","вт","ср","чт","пт","сб","нд"];
function $(i){return document.getElementById(i)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
var nf0=new Intl.NumberFormat("bg-BG",{maximumFractionDigits:0}),nf1=new Intl.NumberFormat("bg-BG",{maximumFractionDigits:1});
var reduce=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
function eur(n){return nf0.format(Math.round(n||0))}
function kf(v){return v>=1000?nf1.format(v/1000)+"k":String(Math.round(v))}
function dni(n){return nf1.format(n)+(Math.abs(n-1)<0.05?" ден":" дни")}
function tmS(iso){return new Intl.DateTimeFormat("bg-BG",{timeZone:"Europe/Sofia",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(iso))}
function dayS(iso){var a=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Sofia"}),s=a.format(new Date(iso)),n=a.format(new Date()),y=a.format(new Date(Date.now()-864e5));return s===n?"днес":s===y?"вчера":s.slice(8)+"."+s.slice(5,7)}
function dm(d){return d.slice(8)+"."+d.slice(5,7)}
function dow(d){var x=new Date(d+"T12:00:00Z").getUTCDay();return x===0?7:x}
function fail(id,part){var e=$(id);if(e)e.innerHTML='<div class="err">Не се чете сега. <a onclick="load(\''+part+'\')">Опитай пак</a></div>'}
function getPart(part){return fetch("/api/cex-plan?view=ownerdata&part="+part+"&k="+encodeURIComponent(C.k),{cache:"no-store"}).then(function(r){return r.json()})}
function stamp(){$("dot").className="dot";$("upd").textContent="обновено "+tmS(new Date().toISOString())}
function grow(root){requestAnimationFrame(function(){requestAnimationFrame(function(){var a=(root||document).querySelectorAll(".gr,.vb .col i,.seq i");for(var i=0;i<a.length;i++)a[i].classList.add("on")})})}
function countUp(el,to,dur){if(!el)return;if(reduce||!isFinite(to)){el.textContent=eur(to);return}var t0=null;function f(ts){if(!t0)t0=ts;var p=Math.min(1,(ts-t0)/(dur||900)),e=1-Math.pow(1-p,3);el.textContent=eur(to*e);if(p<1)requestAnimationFrame(f)}requestAnimationFrame(f)}
// делта: честна база — под минималната не вдига тревога
function delta(cur,base,txt,minBase){var mb=minBase==null?20:minBase;if(base==null||base<mb)return '<span class="dl n">'+(base==null?"":txt+" "+eur(base)+" €")+'</span>';var p=(cur-base)/base*100,c=p>=0?"up":"down";return '<span class="dl '+c+'">'+(p>=0?"▲ ":"▼ ")+Math.abs(p).toFixed(0)+'%</span><span>'+txt+'</span>'}
function niceMax(m){if(m<=0)return 1;var p=Math.pow(10,Math.floor(Math.log10(m))),f=m/p;return(f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p}
var tip=$("tip");
function showTip(html,x,y){tip.innerHTML=html;tip.style.display="block";tip.style.left=Math.min(x+14,window.innerWidth-250)+"px";tip.style.top=Math.max(6,y-12)+"px"}
function hideTip(){tip.style.display="none"}
function bindTip(el,fn){el.addEventListener("mousemove",function(e){showTip(fn(),e.clientX,e.clientY)});el.addEventListener("mouseleave",hideTip);el.addEventListener("touchstart",function(e){var t=e.touches[0];showTip(fn(),t.clientX,t.clientY);setTimeout(hideTip,2200)},{passive:true})}
function spark(data,col,uid){
  var W=240,H=34,mx=Math.max.apply(null,data.map(function(x){return x.v}))||1,n=data.length,d="";
  data.forEach(function(p,i){var x=n>1?i/(n-1)*W:0,y=H-3-(H-8)*(p.v/mx);d+=(i?"L":"M")+x.toFixed(1)+" "+y.toFixed(1)});
  var a=d+"L"+W+" "+H+"L0 "+H+"Z";
  return '<svg class="sp" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none"><defs><linearGradient id="sg'+uid+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:'+col+';stop-opacity:.3"/><stop offset="1" style="stop-color:'+col+';stop-opacity:0"/></linearGradient></defs><path class="ar" d="'+a+'" fill="url(#sg'+uid+')"/><path class="ln" pathLength="1" d="'+d+'" style="stroke:'+col+';stroke-width:1.6"/></svg>'}
function kpi(id,icon,cls,label,valHtml,sub,extra,bad){var e=$(id);e.className="card k s3"+(bad?" bad":"");e.style.animation="none";e.style.opacity=1;e.style.transform="none";e.innerHTML='<div class="l"><span class="ic '+cls+'">'+icon+'</span>'+label+'</div><div class="v">'+valHtml+'</div><div class="sub">'+sub+'</div>'+(extra||"")}
function renderPoint(p){
  var c=p.cmp,sub="";
  if(c)sub+=delta(c.today,c.lastWeek,"до "+c.hm+" спрямо миналата седмица");
  var avg=c&&c.todayN?" · ср. чек "+(Math.round(c.today/c.todayN*10)/10).toString().replace(".",",")+" €":"";
  kpi("k-point","🏪","","Точка · днес",'<b class="cu">0</b><small>€</small>',sub+"<span>"+(c?c.todayN+" сметки":"")+avg+"</span>",spark(p.series.slice(-30),"var(--accent)","p"));
  countUp($("k-point").querySelector(".cu"),p.today);
  mtdCard();lineChart();wdCard();hoursCard(p);mixCard(p);topCard(p)}
function renderCex(c){
  var cm=c.cmp,sub=cm?delta(cm.today,cm.lastWeek,"спрямо миналата седмица"):"";
  kpi("k-cex","🏭","m","Цех · днес",'<b class="cu">0</b><small>€</small>',sub+"<span>"+c.stokovi_n+" стокови · "+c.today_clients+" клиента</span>",spark(c.series.slice(-30),"var(--money)","c"));
  countUp($("k-cex").querySelector(".cu"),c.today);
  mtdCard();lineChart();wdCard();clCard(c)}
function mtdRow(t,cur,prev,col){var mx=Math.max(cur,prev,1);return '<div class="pair"><div class="sub" style="justify-content:space-between"><b style="color:var(--ink);font-weight:600">'+t+'</b><span>'+delta(cur,prev,"спрямо миналия",50)+'</span></div>'
  +'<div class="r"><span>Този месец</span><div class="t"><i class="gr" style="width:'+(cur/mx*100)+'%;background:'+col+'"></i></div><b>'+eur(cur)+' €</b></div>'
  +'<div class="r"><span>Миналия</span><div class="t"><i class="gr" style="width:'+(prev/mx*100)+'%;background:var(--line2)"></i></div><b>'+eur(prev)+' €</b></div></div>'}
function w7Row(w){return '<div class="sub" style="margin-top:2px">7 дни: <b style="color:var(--ink);font-weight:500">'+eur(w.cur)+' €</b> '+delta(w.cur,w.prev,"спрямо предишните 7",50)+'</div>'}
function mtdCard(){var h="",p=D.point,c=D.cex;
  if(p)h+=mtdRow("Точка",p.mtd.cur,p.mtd.prev,"var(--accent)")+w7Row(p.w7);
  if(c)h+='<div style="height:6px"></div>'+mtdRow("Цех",c.mtd.cur,c.mtd.prev,"var(--money)")+w7Row(c.w7);
  if(!h)return;$("mtd").innerHTML=h;grow($("mtd"))}
function lineChart(){
  var sets=[];
  if(ST.who!=="cex"&&D.point)sets.push({name:"Точка",col:"var(--accent)",id:"p",data:D.point.series});
  if(ST.who!=="point"&&D.cex)sets.push({name:"Цех",col:"var(--money)",id:"c",data:D.cex.series});
  if(!sets.length)return;
  var svg=$("chart"),W=svg.clientWidth||600,H=210,L=38,R=8,T=8,B=20,N=ST.n==="all"?9999:+ST.n;
  sets=sets.map(function(s){return{name:s.name,col:s.col,id:s.id,data:s.data.slice(-N)}});
  var n=sets[0].data.length,all=[];sets.forEach(function(s){s.data.forEach(function(x){all.push(x.v)})});var mx=niceMax(Math.max.apply(null,all));
  function X(i){return L+(W-L-R)*(n>1?i/(n-1):0)}function Y(v){return T+(H-T-B)*(1-v/mx)}
  var s="<defs>";sets.forEach(function(q){s+='<linearGradient id="lg'+q.id+'" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:'+q.col+';stop-opacity:.26"/><stop offset="1" style="stop-color:'+q.col+';stop-opacity:0"/></linearGradient>'});s+="</defs>";
  for(var t=0;t<=4;t++){var v=mx*t/4,y=Y(v);s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="var(--line)"/><text x="'+(L-6)+'" y="'+(y+4)+'" text-anchor="end" font-size="10.5" fill="var(--muted)">'+kf(v)+'</text>'}
  var base=sets[0].data;[0,Math.floor((n-1)/2),n-1].forEach(function(i){s+='<text x="'+X(i)+'" y="'+(H-5)+'" text-anchor="'+(i===0?"start":i===n-1?"end":"middle")+'" font-size="10.5" fill="var(--muted)">'+dm(base[i].d)+'</text>'});
  var step=(W-L-R)/Math.max(1,n-1);
  base.forEach(function(p,i){var w=dow(p.d);if(w>=6&&n<=40){s+='<rect x="'+Math.max(L,X(i)-step/2)+'" y="'+T+'" width="'+step+'" height="'+(H-T-B)+'" fill="var(--soft)" opacity=".55"/>'}});
  sets.forEach(function(q){var d="";q.data.forEach(function(p,i){d+=(i?"L":"M")+X(i).toFixed(1)+" "+Y(p.v).toFixed(1)});
    s+='<path class="ar" d="'+d+"L"+X(n-1)+" "+Y(0)+"L"+X(0)+" "+Y(0)+'Z" fill="url(#lg'+q.id+')"/><path class="ln" pathLength="1" d="'+d+'" style="stroke:'+q.col+'"/><circle cx="'+X(n-1)+'" cy="'+Y(q.data[n-1].v)+'" r="3.5" fill="'+q.col+'"/>'});
  s+='<line id="vl" y1="'+T+'" y2="'+(H-B)+'" stroke="var(--line2)" style="display:none"/><rect id="hit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'" fill="transparent"/>';
  svg.setAttribute("viewBox","0 0 "+W+" "+H);svg.innerHTML=s;
  var hit=$("hit"),vl=$("vl");
  function at(e){var r=svg.getBoundingClientRect(),cx=e.touches?e.touches[0].clientX:e.clientX,px=(cx-r.left)*(W/r.width),i=Math.round((px-L)/step);return Math.max(0,Math.min(n-1,i))}
  function mv(e){var i=at(e);vl.setAttribute("x1",X(i));vl.setAttribute("x2",X(i));vl.style.display="";var d=base[i].d,h="<b>"+dm(d)+" · "+DOWN[dow(d)]+"</b>";sets.forEach(function(q){h+=q.name+" "+nf0.format(Math.round(q.data[i].v))+" €<br>"});var cx=e.touches?e.touches[0].clientX:e.clientX,cy=e.touches?e.touches[0].clientY:e.clientY;showTip(h,cx,cy)}
  hit.addEventListener("mousemove",mv);hit.addEventListener("touchmove",mv,{passive:true});hit.addEventListener("mouseleave",function(){hideTip();vl.style.display="none"});
  var lg="";sets.forEach(function(q){lg+='<span><i style="background:'+q.col+'"></i>'+q.name+'</span>'});
  var bests="";sets.forEach(function(q){var b=null;q.data.forEach(function(x){if(!b||x.v>b.v)b=x});if(b&&b.v>0)bests+='<span style="color:var(--muted)">най-добър '+q.name.toLowerCase()+': '+dm(b.d)+' · '+eur(b.v)+' €</span>'});
  $("leg").innerHTML=lg+'<span style="color:var(--muted)">€ без ДДС</span>'+bests}
function colsHtml(vals,labels,hiIdx,cls,fmt){var mx=Math.max.apply(null,vals)||1,h='<div class="vb">';vals.forEach(function(v,i){h+='<div class="col '+(cls||"")+(i===hiIdx?" hi":"")+'" data-i="'+i+'"><b>'+(v>0?fmt(v):"")+'</b><i style="height:'+Math.max(v>0?4:0,v/mx*78)+'%"></i><span>'+labels[i]+'</span></div>'});return h+"</div>"}
function wdCard(){
  var src=D[ST.wd];if(!src)return;var wd=src.wd,vals=wd.map(function(x){return x.avg}),today=dow(src.to),mo=ST.wd==="cex"?"mo":"";
  var el=$("wd");el.innerHTML=colsHtml(vals,wd.map(function(x){return DOWN[x.dow]}),today-1,mo,kf);grow(el);
  var cols=el.querySelectorAll(".col");for(var i=0;i<cols.length;i++)(function(c){bindTip(c,function(){var x=wd[+c.getAttribute("data-i")];return "<b>"+DOWN[x.dow]+"</b>средно "+nf0.format(Math.round(x.avg))+" € · "+x.n+" дни с продажби"})})(cols[i]);
  var best=0;wd.forEach(function(x,i){if(x.avg>wd[best].avg)best=i});$("wd-sub").innerHTML='<span>най-силен: <b style="color:var(--ink);font-weight:500">'+(wd[best].avg>0?DOWN[wd[best].dow]+" · "+eur(wd[best].avg)+" €":"—")+'</b></span><span>средно на ден с продажби</span>'}
function hoursCard(p){
  var hs=[];for(var h=8;h<=22;h++)hs.push(h);var vals=hs.map(function(h){return p.hours[h]}),mx=Math.max.apply(null,vals),pk=vals.indexOf(mx),tot=vals.reduce(function(a,b){return a+b},0);
  var el=$("hours");el.innerHTML=colsHtml(vals,hs,pk,"",kf);grow(el);
  var cols=el.querySelectorAll(".col");for(var i=0;i<cols.length;i++)(function(c){bindTip(c,function(){var i=+c.getAttribute("data-i");return "<b>"+hs[i]+":00–"+(hs[i]+1)+":00</b>"+nf0.format(Math.round(vals[i]))+" € · "+(tot?Math.round(vals[i]/tot*100):0)+"% от оборота"})})(cols[i]);
  $("h-sub").textContent=mx>0?"най-силен "+hs[pk]+":00":""}
function segHtml(parts,label){var tot=parts.reduce(function(a,x){return a+x.v},0);if(!(tot>0))return '<div class="empty">—</div>';var h='<h3>'+label+'</h3><div class="seq">';parts.forEach(function(x){if(x.v>0)h+='<i style="width:'+(x.v/tot*100)+'%;background:'+x.c+'" title="'+esc(x.l)+' '+eur(x.v)+' €"></i>'});h+='</div><div class="lg2">';parts.forEach(function(x){if(x.v>0)h+='<span><i style="background:'+x.c+'"></i>'+x.l+' '+Math.round(x.v/tot*100)+'% · '+eur(x.v)+' €</span>'});return h+"</div>"}
function mixCard(p){var h=segHtml([{l:"Сайт",v:p.online,c:"var(--accent)"},{l:"Каса",v:p.counter,c:"color-mix(in srgb,var(--accent) 35%,transparent)"}],"Откъде идва ("+(p.onlineN+p.counterN)+" сметки)");
  if(p.pay.used)h+=segHtml([{l:"Карта",v:p.pay.card,c:"var(--money)"},{l:"Брой",v:p.pay.cash,c:"color-mix(in srgb,var(--money) 40%,transparent)"},{l:"Друго",v:p.pay.other,c:"var(--line2)"}],"Как плащат");
  $("mix").innerHTML=h;grow($("mix"))}
function topCard(p){var el=$("top");$("top-sub").textContent=p.units_truncated?"непълно":"";
  if(!p.top.length){el.innerHTML='<div class="empty">—</div>';return}
  var mx=p.top[0].rev||1,h="";p.top.forEach(function(x){var dl=x.delta==null||x.prev==null||x.prev<20?"":'<span class="dl '+(x.delta>=0?"up":"down")+'">'+(x.delta>=0?"▲":"▼")+Math.abs(x.delta)+'%</span>';
    h+='<div class="row a"><span class="n" title="'+esc(x.n)+'">'+esc(x.n)+'</span><span class="sub">'+x.units+' бр · '+dl+'</span><b>'+eur(x.rev)+' €</b><div class="bar"><i class="gr" style="width:'+(x.rev/mx*100)+'%"></i></div></div>'});
  el.innerHTML=h;grow(el)}
function clCard(c){var el=$("cl");$("cl-sub").textContent=c.clients.length+" клиента";
  if(!c.clients.length){el.innerHTML='<div class="empty">—</div>';return}
  var mx=c.clients[0].v||1,tot=c.clients.reduce(function(a,x){return a+x.v},0),h="";
  c.clients.slice(0,9).forEach(function(x){h+='<div class="row"><span class="n" title="'+esc(x.name)+'">'+esc(x.name)+'</span><span class="sub">'+(x.today>0?"днес "+eur(x.today)+" € · ":"")+Math.round(x.v/tot*100)+'%</span><b>'+eur(x.v)+' €</b><div class="bar"><i class="gr" style="width:'+(x.v/mx*100)+'%"></i></div></div>'});
  if(c.clients.length>9)h+='<div class="empty">+ още '+(c.clients.length-9)+'</div>';el.innerHTML=h;grow(el)}
var COV=["var(--down)","var(--warn)","color-mix(in srgb,var(--money) 35%,transparent)","color-mix(in srgb,var(--money) 60%,transparent)","var(--money)"];
function renderStock(s){
  var tot=s.cover.reduce(function(a,x){return a+x.n},0)||1;
  var mini='<div class="seq" style="margin:auto 0 0">';s.cover.forEach(function(x,i){if(x.n)mini+='<i style="width:'+(x.n/tot*100)+'%;background:'+COV[i]+'" title="'+x.l+': '+x.n+'"></i>'});mini+="</div>";
  kpi("k-stock","📦","","Склад",'<b class="cu">0</b><small>€</small>',"<span>"+(s.zero_n?'<b style="color:var(--down)">'+s.zero_n+" на нула</b>":"суровини и консумативи")+"</span><span>"+tot+" артикула</span>",mini);
  countUp($("k-stock").querySelector(".cu"),s.value);grow($("k-stock"));
  var worst=s.groups.length?s.groups[0].items[0]:null;
  kpi("k-order","🛒","o","За поръчка",'<b class="cu">0</b><small>арт.</small>',"<span>"+s.sup_n+" доставчика</span>"+(worst?"<span>най-спешно: "+esc(worst.n)+"</span>":""),"",s.risk_n>0);
  countUp($("k-order").querySelector(".cu"),s.risk_n,600);
  var el=$("risk");$("risk-sub").textContent=s.date?"към "+dm(s.date):"";
  if(!s.groups.length){el.innerHTML='<div class="empty">Нищо не свършва преди следващата доставка.</div>'}else{
    var h='<div class="sg">';s.groups.forEach(function(g){
      h+='<div class="sup"><header><b>'+esc(g.sup)+'</b><span class="chip">доставка след '+dni(g.lead)+'</span><a class="go" href="'+C.links.order+'" target="_blank">Поръчай →</a></header>';
      g.items.forEach(function(x,i){var pct=Math.min(100,Math.max(4,Math.round(Math.max(0,x.c)/Math.max(0.1,x.lead)*100)));
        h+='<div class="row w"'+(i>=4?' style="display:none"':"")+'><span class="n" title="'+esc(x.n)+'">'+esc(x.n)+'</span><span class="c" title="Покритие '+nf1.format(x.c)+" дни, доставка след "+nf1.format(x.lead)+'">'+(x.c<=0?"на нула":dni(x.c))+'</span><span class="o" title="Предложение до доставката след следващата">'+(x.need>0?nf1.format(x.need)+" "+esc(x.u):"—")+'</span><div class="bar"><i class="gr" style="width:'+pct+'%"></i></div></div>'});
      if(g.items.length>4)h+='<div class="more" onclick="var r=this.parentNode.querySelectorAll(\'.row\');for(var i=0;i<r.length;i++)r[i].style.display=\'grid\';this.remove()">+ още '+(g.items.length-4)+'</div>';
      h+='</div>'});el.innerHTML=h+"</div>";grow(el)}
  var su=$("sup"),mxv=(s.by_sup[0]||{v:1}).v,hh='<h3 style="font-size:11.5px;font-weight:500;color:var(--muted);margin:0 0 2px">Стойност по доставчик</h3>';
  s.by_sup.forEach(function(x){hh+='<div class="row"><span class="n">'+esc(x.sup)+'</span><span></span><b>'+eur(x.v)+' €</b><div class="bar"><i class="gr" style="width:'+(x.v/mxv*100)+'%"></i></div></div>'});
  if(s.by_sup_rest)hh+='<div class="empty">+ други '+eur(s.by_sup_rest)+' €</div>';
  hh+='<h3 style="font-size:11.5px;font-weight:500;color:var(--muted);margin:8px 0 2px">Колко дни стигат</h3><div class="lg2">';
  s.cover.forEach(function(x,i){hh+='<span><i style="background:'+COV[i]+'"></i>'+x.l+' · <b style="color:var(--ink);font-weight:500">'+x.n+'</b></span>'});
  su.innerHTML=hh+"</div>";grow(su);
  var idl=$("idle");$("idle-sub").textContent=s.idle_value?eur(s.idle_value)+" €":"";
  if(!s.idle.length)idl.innerHTML='<div class="empty">—</div>';else{var mxi=s.idle[0].val||1,t="";s.idle.forEach(function(x){t+='<div class="row a"><span class="n" title="'+esc(x.n)+'">'+esc(x.n)+'</span><span class="sub">'+nf1.format(x.s)+" "+esc(x.u)+'</span><b>'+eur(x.val)+' €</b><div class="bar"><i class="gr" style="width:'+(x.val/mxi*100)+'%"></i></div></div>'});idl.innerHTML=t;grow(idl)}}
function renderOrders(o){var el=$("ord");if(!o.items.length){el.innerHTML='<div class="empty">Още няма записани поръчки. Всяка пратена от страницата „Поръчка към доставчик“ се записва тук.</div>';return}
  var h="";o.items.forEach(function(x){h+='<details class="ord"><summary><span class="t">'+dayS(x.at)+" "+tmS(x.at)+'</span><b>'+esc(x.sup)+'</b><span class="sub">'+x.n+' реда</span></summary><pre>'+esc(x.text)+'</pre></details>'});el.innerHTML=h}
function load(part){
  var map={point:renderPoint,cex:renderCex,stock:renderStock,orders:renderOrders};
  return getPart(part).then(function(j){if(!j||!j.ok)throw new Error("x");D[part]=j;map[part](j);stamp()})
  .catch(function(){if(part==="point"){fail("k-point","point");fail("mtd","point");fail("hours","point");fail("mix","point");fail("top","point")}else if(part==="cex"){fail("k-cex","cex");fail("cl","cex")}else if(part==="stock"){fail("k-stock","stock");fail("k-order","stock");fail("risk","stock");fail("sup","stock");fail("idle","stock")}else fail("ord","orders")})}
function all(){["point","cex","stock","orders"].forEach(load)}
$("rf").onclick=function(){$("dot").className="dot off";$("upd").textContent="обновявам…";all()};
function tabs(id,key,fn){var b=$(id).querySelectorAll("button");for(var i=0;i<b.length;i++)b[i].onclick=function(){for(var j=0;j<b.length;j++)b[j].classList.remove("on");this.classList.add("on");ST[key]=this.getAttribute("data-v");fn()}}
tabs("seg-who","who",lineChart);tabs("seg-n","n",lineChart);tabs("seg-wd","wd",wdCard);
var lk="";if(C.links.order)lk+='<a class="pill" href="'+C.links.order+'" target="_blank">🛒 Поръчка към доставчик</a>';if(C.links.clock)lk+='<a class="pill" href="'+C.links.clock+'" target="_blank">⏱ Часове</a>';$("lnk").innerHTML=lk;
var rz;window.addEventListener("resize",function(){clearTimeout(rz);rz=setTimeout(function(){if(D.point||D.cex)lineChart()},150)});
all();setInterval(all,300000);
`;

function page(k, links) {
  const cfg = JSON.stringify({ k, links: links || {} }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>MOTAMO · Табло</title>
<meta name="theme-color" content="#f6f6f3"><link rel="apple-touch-icon" href="https://motamo.bg/icons/icon-192.png"><style>${CSS}</style></head><body>${BODY}
<script>window.C=${cfg}</script><script>${JS}</script></body></html>`;
}

module.exports = { ownerKey, keyOk, partData, page, pointView, cexView, stockView, ordersView, series, mtdPair, weekSum, weekdayAvg, plusDays, sofiaDate, prevMonthStart, JS };
