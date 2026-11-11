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
// Прогноза за края на месеца: реалното до днес + очакваното за останалите дни (средното за всеки ден от седмицата; затворените дни са 0)
function forecast(byDay, to, wd) {
  const y = +to.slice(0, 4), m = +to.slice(5, 7), ym = to.slice(0, 7), dim = daysInMonth(y, m), py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1, pym = py + "-" + String(pm).padStart(2, "0");
  let mtd = 0, prev = 0, rest = 0, left = 0;
  for (const d of Object.keys(byDay || {})) { if (d.startsWith(ym) && d <= to) mtd += byDay[d] || 0; else if (d.startsWith(pym)) prev += byDay[d] || 0; }
  for (let day = +to.slice(8) + 1; day <= dim; day++) { const d = ym + "-" + String(day).padStart(2, "0"); rest += (wd[isoDow(d) - 1] || { avg: 0 }).avg; left++; }
  return { mtd: r2(mtd), proj: r2(mtd + rest), left, prev: r2(prev), prevMonth: pym };
}
// най-добрите 7 поредни дни
function bestWeek(s) {
  let best = null;
  for (let i = 6; i < s.length; i++) { let t = 0; for (let k = i - 6; k <= i; k++) t += s[k].v; if (!best || t > best.v) best = { from: s[i - 6].d, to: s[i].d, v: r2(t) }; }
  return best;
}
const bestDay = (s) => s.reduce((b, x) => (x.v > (b ? b.v : 0) ? x : b), null);

// ── ТОЧКА ─────────────────────────────────────────────────────────────────────
function pointView(data, from, to) {
  const by = data.by_day || {}, s = series(by, from, to);
  // часовете са СРЕДНО НА ДЕН (общото за периода ÷ дните с продажби), иначе числата са общо за седмици и се бъркат с оборота на цеха
  const openDays = s.filter(x => x.v > 0).length || 1;
  const hours = Array.from({ length: 24 }, (_, h) => r2(((data.by_hour || {})[h] || 0) / openDays));
  const pay = data.pay || {};
  const prods = data.products || [], movers = data.movers || [];
  const top = prods.slice(0, 8).map((p, i) => {
    const mv = movers[i] && movers[i].name === p.name ? movers[i] : null;
    return { n: p.name, rev: r2(p.revenue), units: Math.round(p.units || 0), prev: mv ? r2(mv.prev) : null, delta: mv && mv.delta_pct != null ? Math.round(mv.delta_pct) : null };
  });
  return {
    ok: true, from, to, series: s, today: r2(by[to]), cmp: data.cmp || null, mtd: mtdPair(by, to),
    w7: { cur: weekSum(by, to, 0), prev: weekSum(by, to, 7) }, wd: weekdayAvg(by, from, to), hours, open_days: openDays,
    online: r2(data.online_neto), counter: r2(data.counter_neto), onlineN: data.online_n | 0, counterN: data.counter_n | 0,
    pay: { cash: r2(pay.cash && pay.cash.neto), card: r2(pay.card && pay.card.neto), other: r2(pay.other && pay.other.neto), used: !!data.pay_used },
    top, accounts: data.accounts || 0, avg_check: r2(data.avg_check), best: bestDay(s), best_week: bestWeek(s), units_truncated: !!data.units_truncated,
    fc: forecast(by, to, weekdayAvg(by, from, to))
  };
}

// ── градове на клиентите на цеха (по CEX_OBJECTS в api/cex-plan.js): Хасково 9, Сливен 11, Ямбол 15; СиБиЕс (2) по обект; останалото — Стара Загора ──
const CITY_CLIENT = { 9: "Хасково", 11: "Сливен", 15: "Ямбол" };
const CITY_PERSON2 = { 12: "Нова Загора", 13: "Казанлък", 14: "Раднево", 15: "Чирпан" };
const cityOf = (cid, pid) => CITY_CLIENT[Number(cid)] || (Number(cid) === 2 && CITY_PERSON2[Number(pid)]) || "Стара Загора";
const shortPn = (pn, fb) => { const t = String(pn || "").split(",").pop().trim(); return t && t.length <= 40 ? t : fb; };
function cityGroups(accs, test) {
  const by = {};
  for (const a of accs) {
    if (!test(a)) continue;
    const city = cityOf(a.cid, a.pid), g = by[city] || (by[city] = { city, v: 0, n: 0, cl: {} });
    g.v += a.v; g.n++;
    const multi = [2, 11, 15].includes(Number(a.cid)), key = multi ? a.cid + ":" + a.pid : String(a.cid), c = g.cl[key] || (g.cl[key] = { name: multi ? shortPn(a.pn, a.name) : a.name, v: 0, n: 0 });
    c.v += a.v; c.n++;
  }
  return Object.values(by).map(g => ({ city: g.city, v: r2(g.v), n: g.n, objects: Object.keys(g.cl).length,
    clients: Object.values(g.cl).map(c => ({ name: c.name, v: r2(c.v), n: c.n })).sort((x, y) => y.v - x.v) })).sort((x, y) => y.v - x.v);
}

// ── ЦЕХ ───────────────────────────────────────────────────────────────────────
// accs: затворени сметки на цеха { d: "YYYY-MM-DD", t: "HH:MM:SS", v: нето, cid, name } (нето = с ДДС ÷ 1,2, както в цеховото табло).
const dm2 = (d) => d.slice(8) + "." + d.slice(5, 7);
// Автоматични наблюдения за цеха (до 7 реда, по важност): зависимост от един клиент, растеж/спад, нови и „заспали“ клиенти, средна стокова
function cexFacts(list, tot, big, to, nAcc30) {
  const out = [], by = list.filter(c => c.v > 0).sort((x, y) => y.v - x.v);
  if (by[0] && tot > 0) { const p = Math.round(by[0].v / tot * 100); out.push({ t: p >= 50 ? "warn" : "info", sev: p >= 50 ? 9 : 3, text: by[0].name + " е " + p + "% от оборота на цеха за 30 дни" + (p >= 50 ? " — голяма зависимост от един клиент" : "") }); }
  for (const c of list) {
    if (c.v > 0 && c.prev >= 300) {
      const d = Math.round((c.v - c.prev) / c.prev * 100);
      if (d >= 15) out.push({ t: "up", sev: 4, d, text: c.name + " расте: ▲ " + d + "% спрямо предишните 30 дни" });
      if (d <= -15) out.push({ t: "down", sev: 8, d, text: c.name + " спада: ▼ " + Math.abs(d) + "% спрямо предишните 30 дни" });
    }
    if (c.v > 0 && c.prev === 0) out.push({ t: "new", sev: 5, text: "Нов клиент: " + c.name + " (" + Math.round(c.v) + " € за 30 дни)" });
    const days = c.last ? Math.round((Date.parse(to + "T12:00:00Z") - Date.parse(c.last + "T12:00:00Z")) / 86400000) : null;
    if (c.prev >= 300 && days != null && days >= 10) out.push({ t: "warn", sev: 10, text: c.name + " не е поръчвал от " + days + " дни (последно " + dm2(c.last) + ")" });
  }
  if (nAcc30 > 0) out.push({ t: "info", sev: 1, text: "Средна стокова " + Math.round(tot / nAcc30) + " € · най-голяма " + Math.round(big.v) + " € (" + big.name + ", " + dm2(big.d) + ")" });
  const best = out.filter(x => x.t === "up").sort((x, y) => y.d - x.d)[0], worst = out.filter(x => x.t === "down").sort((x, y) => x.d - y.d)[0];
  const keep = out.filter(x => (x.t !== "up" && x.t !== "down") || x === best || x === worst);
  return keep.sort((x, y) => y.sev - x.sev).slice(0, 7).map(({ t, text }) => ({ t, text }));
}

// accs: затворени сметки на цеха { d: "YYYY-MM-DD", t: "HH:MM:SS", v: нето, cid, pid, pn, name } (нето = с ДДС ÷ 1,2, както в цеховото табло).
function cexView(accs, from, to, now) {
  const wk = plusDays(to, -7), d30 = plusDays(to, -29), p0 = plusDays(to, -59), p1 = plusDays(to, -30);
  const mon = (d) => plusDays(d, -(isoDow(d) - 1));
  const weeks = Array.from({ length: 8 }, (_, i) => plusDays(mon(to), -7 * (7 - i)));
  const byDay = {}, today = {}, cl = {}; let todayN = 0, cT = 0, cTn = 0, cW = 0, cWn = 0, big = null, n30 = 0;
  for (const a of accs) {
    if (!a || a.d < from || a.d > to) continue;
    byDay[a.d] = (byDay[a.d] || 0) + a.v;
    if (a.d === to) { todayN++; const c = today[a.cid] || (today[a.cid] = { v: 0, n: 0 }); c.v += a.v; c.n++; cT += a.v; cTn++; } else if (a.d === wk) { cW += a.v; cWn++; }
    const c = cl[a.cid] || (cl[a.cid] = { id: a.cid, name: a.name, v: 0, n: 0, prev: 0, last: "", spark: Array(8).fill(0), dow: Array(7).fill(0), dowN: Array(7).fill(0) });
    if (a.d >= d30) { c.v += a.v; c.n++; n30++; if (!big || a.v > big.v) big = { v: a.v, name: a.name, d: a.d }; } else if (a.d >= p0 && a.d <= p1) c.prev += a.v;
    if (a.d > c.last) c.last = a.d;
    const wi = weeks.indexOf(mon(a.d)); if (wi >= 0) c.spark[wi] += a.v;
    if (a.d >= d30) { const w = isoDow(a.d) - 1; c.dow[w] += a.v; c.dowN[w]++; }       // ритъмът е за последните 30 дни
  }
  const s = series(byDay, from, to), list = Object.values(cl), tot30 = list.reduce((q, c) => q + c.v, 0);
  const clients = list.filter(c => c.v > 0).map(c => ({
    id: c.id, name: c.name, v: r2(c.v), n: c.n, today: r2(today[c.id] && today[c.id].v), todayN: today[c.id] ? today[c.id].n : 0,
    spark: c.spark.map(r2), prev: r2(c.prev), delta: c.prev >= 300 ? Math.round((c.v - c.prev) / c.prev * 100) : null, last: c.last
  })).sort((x, y) => y.v - x.v);
  const rhythm = clients.slice(0, 9).map(c => ({ name: c.name, d: cl[c.id].dow.map(r2), n: cl[c.id].dowN }));
  return {
    ok: true, from, to, series: s, today: r2(byDay[to]), stokovi_n: todayN, cmp: { today: r2(cT), lastWeek: r2(cW), hm: null, todayN: cTn, lastWeekN: cWn },
    mtd: mtdPair(byDay, to), w7: { cur: weekSum(byDay, to, 0), prev: weekSum(byDay, to, 7) }, wd: weekdayAvg(byDay, from, to),
    clients, today_clients: clients.filter(c => c.today > 0).length, best: bestDay(s), best_week: bestWeek(s), big: big ? { v: r2(big.v), name: big.name, d: big.d } : null, fc: forecast(byDay, to, weekdayAvg(byDay, from, to)), rhythm,
    facts: cexFacts(list, tot30, big, to, n30),
    cities: { d30: cityGroups(accs, a => a && a.d >= d30 && a.d <= to), month: cityGroups(accs, a => a && a.d.startsWith(to.slice(0, 7)) && a.d <= to) }
  };
}

// ── ЦЕХ · най-продавани от 1 януари: общо, по град (група клиенти) и по клиент ────────────────────────────
const SALES_GROUPS = ["Сливен", "Хасково", "Ямбол", "Стара Загора и СиБиЕс"];
const salesGroup = (cid) => (Number(cid) === 11 ? "Сливен" : Number(cid) === 9 ? "Хасково" : Number(cid) === 15 ? "Ямбол" : "Стара Загора и СиБиЕс");
// rep = резултат на reportSalesByArticles: { articles:[{ article_id, name, units, revenue, cost }] }
const normArts = (rep) => ((rep && rep.articles) || []).filter(a => a.units > 0).map(a => ({ id: a.article_id, n: a.name, units: a.units, rev: a.revenue, cost: a.cost }));
function mkTop(arts, limit) {
  const rev = arts.reduce((q, a) => q + a.rev, 0);
  return { rev: r2(rev), n: arts.length, arts: arts.slice().sort((x, y) => y.rev - x.rev).slice(0, limit).map(a => ({ n: a.n, units: Math.round(a.units), rev: r2(a.rev), m: a.rev > 0 && a.cost > 0 ? Math.round((1 - a.cost / a.rev) * 100) : null, share: rev ? Math.round(a.rev / rev * 1000) / 10 : 0 })) };
}
function salesView(all, per, to) {                       // per: [{ id, name, rep }] (rep може да е null при грешка)
  const from = to.slice(0, 4) + "-01-01", merge = (lists) => { const m = {}; for (const l of lists) for (const a of l) { const x = m[a.id] || (m[a.id] = { id: a.id, n: a.n, units: 0, rev: 0, cost: 0 }); x.units += a.units; x.rev += a.rev; x.cost += a.cost; } return Object.values(m); };
  const okPer = per.filter(c => c.rep), arts = okPer.map(c => normArts(c.rep));
  const allArts = all ? normArts(all) : merge(arts);
  const groups = {};
  for (const g of SALES_GROUPS) { const ls = okPer.filter(c => salesGroup(c.id) === g).map(c => normArts(c.rep)); if (ls.length) groups[g] = mkTop(merge(ls), 12); }
  const clients = okPer.map(c => ({ id: c.id, name: c.name, group: salesGroup(c.id), ...mkTop(normArts(c.rep), 10) })).filter(c => c.rev > 0).sort((x, y) => y.rev - x.rev);
  return { ok: true, from, to, all: mkTop(allArts, 12), groups, clients, missing: per.length - okPer.length };
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

// ── ПЕЧАЛБА ПО КЛИЕНТ от 1 януари (справка „Продажби по сметки“: оборот без ДДС и себестойност) ──────────────────
function marginView(m, names, to) {
  const rows = Object.keys(m || {}).map(id => { const x = m[id]; return { id: +id, name: names[id] || ("клиент " + id), rev: r2(x.rev), cost: r2(x.cost), profit: r2(x.rev - x.cost), margin: x.rev > 0 ? Math.round((x.rev - x.cost) / x.rev * 1000) / 10 : null }; })
    .filter(r => r.rev > 0).sort((a, b) => b.profit - a.profit);
  const rev = rows.reduce((q, r) => q + r.rev, 0), profit = rows.reduce((q, r) => q + r.profit, 0);
  return { ok: true, from: to.slice(0, 4) + "-01-01", to, rows, rev: r2(rev), profit: r2(profit), margin: rev > 0 ? Math.round(profit / rev * 1000) / 10 : null, missing: Object.keys(names || {}).length - rows.length };
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

// месечни обороти от 1 януари: pm/cx = { "2026-10": нето, … } или null, ако източникът не е отговорил
function monthsView(pm, cx, to) {
  const y = to.slice(0, 4), cm = +to.slice(5, 7), months = [];
  for (let m = 1; m <= cm; m++) {
    const ym = y + "-" + String(m).padStart(2, "0");
    months.push({ ym, point: pm && pm[ym] != null ? r2(pm[ym]) : null, cex: cx && cx[ym] != null ? r2(cx[ym]) : null });
  }
  return { ok: true, months, point_missing: !pm, cex_missing: !cx };
}

// deps: { shopDashData, cexAccounts(from,to), cexArticles(from,to,clientId|null), cexMargin(from,to,ids), shopMonths(y,to), cexMonths(y,to), stockReport, soList, shopUser, shopPass }
async function partData(part, deps, now) {
  now = now || new Date();
  const to = sofiaDate(now), from = prevMonthStart(to);        // от 1-во число на миналия месец (≤ 62 дни)
  if (part === "point") return cached("point", 60000, async () => pointView(await deps.shopDashData(from, to, 0, deps.shopUser, deps.shopPass), from, to));
  const accsOf = () => cached("cexaccs", 60000, () => deps.cexAccounts(from, to));
  if (part === "cex") return cached("cex", 60000, async () => cexView(await accsOf(), from, to, now));
  if (part === "months") return cached("months", 600000, async () => {
    const y = to.slice(0, 4);
    const [pm, cx] = await Promise.all([deps.shopMonths(y, to).catch(() => null), deps.cexMonths(y, to).catch(() => null)]);
    if (!pm && !cx) throw new Error("months");
    // последните два месеца — от същите сметки като останалите карти (справката се разминава с ~1 %: „едно число — едно място“)
    if (cx) { const accs = await accsOf().catch(() => null); if (accs) { const sums = {}; for (const a of accs) sums[a.d.slice(0, 7)] = (sums[a.d.slice(0, 7)] || 0) + a.v; for (const ym of Object.keys(sums)) if (ym >= from.slice(0, 7)) cx[ym] = sums[ym]; } }
    return monthsView(pm, cx, to);
  });
  if (part === "cexsales") return cached("cexsales", 900000, async () => {
    const accs = await accsOf(), seen = {}; for (const a of accs) seen[a.cid] = a.name;
    const y = to.slice(0, 4), f = y + "-01-01", ids = Object.keys(seen).map(Number);
    const all = await deps.cexArticles(f, to, null).catch(() => null);
    const per = ids.map(id => ({ id, name: seen[id], rep: null }));
    for (let i = 0; i < per.length; i += 3) await Promise.all(per.slice(i, i + 3).map(async c => { c.rep = await deps.cexArticles(f, to, c.id).catch(() => null); if (c.rep && !c.rep.ok) c.rep = null; }));
    if (!(all && all.ok) && !per.some(c => c.rep)) throw new Error("cexsales");
    return salesView(all && all.ok ? all : null, per, to);
  });
  if (part === "cexmargin") return cached("cexmargin", 900000, async () => {
    const accs = await accsOf(), seen = {}; for (const a of accs) seen[a.cid] = a.name;
    const m = await deps.cexMargin(to.slice(0, 4) + "-01-01", to, Object.keys(seen).map(Number));
    if (!m || !Object.keys(m).length) throw new Error("cexmargin");
    return marginView(m, seen, to);
  });
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
.cty{border-top:1px solid var(--line)}.cty:first-child{border-top:0}.cty summary{cursor:pointer;display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;list-style:none;padding:6px 0;position:relative;font-variant-numeric:tabular-nums}.cty summary::-webkit-details-marker{display:none}
.cty summary .bar{position:absolute;left:0;right:0;bottom:-1px;height:2px}.cty summary .bar i{display:block;height:100%;border-radius:2px;background:var(--money)}.cty .in{padding:0 0 6px 12px}.cty .in .row{font-size:12.5px;border-top:0;padding:3px 0}.cty summary b{font-weight:600}
.map{width:100%;height:auto;display:block;max-height:300px}.rt{stroke:var(--money);stroke-opacity:.55;stroke-width:1.2;stroke-dasharray:4 4;animation:flow 1.6s linear infinite}@keyframes flow{to{stroke-dashoffset:-16}}
.pl{fill:none;stroke:var(--money);stroke-opacity:.6;transform-box:fill-box;transform-origin:center;animation:ping 2.6s ease-out infinite}@keyframes ping{0%{transform:scale(1);opacity:.75}100%{transform:scale(1.8);opacity:0}}.bb{cursor:default}
.fct{display:flex;gap:9px;padding:6px 0;border-top:1px solid var(--line);font-size:13px;align-items:flex-start}.fct:first-child{border-top:0}.fct .fi{width:18px;text-align:center;flex:none;color:var(--muted)}.fct.warn .fi{color:var(--warn)}.fct.up .fi{color:var(--up)}.fct.down .fi{color:var(--down)}.fct.new .fi{color:var(--accent)}
.hmg{display:grid;grid-template-columns:minmax(0,1fr) repeat(7,24px);gap:3px;align-items:center;font-size:11px}.hmg b{color:var(--muted);font-weight:500;text-align:center}.hmg .hn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink2)}.hmg i{display:grid;place-items:center;height:21px;border-radius:5px;font-style:normal;color:var(--ink);font-size:10.5px;opacity:0;animation:fi .6s .3s forwards}
.ctl{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}.ctl select{font:inherit;font-size:12px;background:var(--soft);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:4px 8px;max-width:190px}
.pod{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:8px}.pd{border:1px solid var(--line);border-radius:11px;padding:9px 10px;background:var(--soft);min-width:0}.pd .md{font-size:18px;line-height:1}.pd .pn{font-weight:500;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:33px;font-size:12.5px;margin-top:3px}
.pd .pv{font-size:19px;font-weight:600;margin:2px 0;font-variant-numeric:tabular-nums}.pd .pb{height:3px;background:var(--line);border-radius:3px;margin-top:6px;overflow:hidden}.pd .pb i{display:block;height:100%;background:var(--money)}.pd.p0{border-color:color-mix(in srgb,var(--warn) 55%,var(--line))}
.row.rc{grid-template-columns:minmax(0,1fr) 52px auto auto}.spk{width:52px;height:16px;display:block}
.alerts{display:flex;gap:7px;flex-wrap:wrap;margin:-4px 0 10px}.al{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:99px;font-size:12.5px;border:1px solid var(--line);background:var(--card);cursor:pointer;max-width:100%;color:var(--ink)}.al span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.al.warn{border-color:color-mix(in srgb,var(--warn) 50%,var(--line));background:color-mix(in srgb,var(--warn) 9%,var(--card))}.al.bad{border-color:color-mix(in srgb,var(--down) 50%,var(--line));background:color-mix(in srgb,var(--down) 9%,var(--card))}.al.ok{border-color:color-mix(in srgb,var(--money) 45%,var(--line));cursor:default}
.rec{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.rc2{background:var(--soft);border-radius:10px;padding:9px 11px;min-width:0}.rc2 .t{font-size:11.5px;color:var(--muted)}.rc2 b{display:block;font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;margin:1px 0}.rc2 .sub{font-size:11.5px}
.fcb{height:8px;border-radius:5px;overflow:hidden;background:repeating-linear-gradient(90deg,var(--line2) 0 5px,transparent 5px 9px)}.fcb i{display:block;height:100%;border-radius:5px}
.chip.ok{background:color-mix(in srgb,var(--money) 16%,transparent);color:var(--money)}.chip.bd{background:color-mix(in srgb,var(--down) 16%,transparent);color:var(--down)}
.lnk{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
@media(prefers-reduced-motion:reduce){.card,.ln,.ar,.gr,.vb .col i,.seq i,.dot,.sk,.rt,.pl,.hmg i{animation:none!important;transition:none!important}.hmg i{opacity:1}.card{opacity:1;transform:none}.ln{stroke-dashoffset:0}.ar{opacity:1}.gr,.vb .col i,.seq i{transform:none}}
`;

const BODY = String.raw`
<div class="wrap">
<div class="top"><h1>Табло</h1><span class="pill"><span class="dot off" id="dot"></span><span id="upd">зареждам…</span></span><button class="pill" id="rf">↻ Обнови</button></div>
<div class="alerts" id="alerts"></div>
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

 <div class="card s7" id="c-mon"><div class="hd"><h2>По месеци</h2><span class="seg" id="seg-mon"><button data-v="point" class="on">Точка</button><button data-v="cex">Цех</button></span></div><div id="mon"><div class="sk" style="height:150px"></div></div><div class="sub" id="mon-sub" style="margin-top:6px"></div></div>
 <div class="card s5" id="c-city"><div class="hd"><h2>Клиенти по градове</h2><span class="seg" id="seg-city"><button data-v="d30" class="on">30 дни</button><button data-v="month">Месец</button></span></div><div id="city"><div class="sk" style="height:150px"></div></div></div>

 <div class="card s5" id="c-map"><div class="hd"><h2>Карта на клиентите</h2><span class="sub">от цеха към градовете</span></div><div id="map"><div class="sk" style="height:230px"></div></div></div>
 <div class="card s7" id="c-facts"><div class="hd"><h2>Забелязано в цеха</h2><span class="sub">30 дни</span></div><div id="facts"><div class="sk" style="height:140px"></div></div></div>

 <div class="card s8" id="c-sales"><div class="hd"><h2>Цех · най-продавани</h2><span class="sub" id="sales-sub">от 1 януари</span></div><div class="ctl" id="sales-ctl"></div><div id="sales"><div class="sk" style="height:220px"></div></div></div>
 <div class="card s4" id="c-hm"><div class="hd"><h2>Кога поръчва всеки</h2><span class="sub">30 дни · брой стокови</span></div><div id="hm"><div class="sk" style="height:200px"></div></div></div>

 <div class="card s7" id="c-margin"><div class="hd"><h2>Печалба по клиент</h2><span class="sub" id="margin-sub">от 1 януари</span></div><div id="margin"><div class="sk" style="height:160px"></div></div></div>
 <div class="card s5" id="c-rec"><div class="hd"><h2>Рекорди</h2><span class="sub">последните ~60 дни</span></div><div id="rec"><div class="sk" style="height:160px"></div></div></div>

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
var C=window.C,D={point:null,cex:null,stock:null,orders:null},ST={who:"both",n:"30",wd:"point",mon:"point",city:"d30",sg:"all"};
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
  mtdCard();lineChart();wdCard();hoursCard(p);mixCard(p);topCard(p);recCard()}
function renderCex(c){
  var cm=c.cmp,sub=cm?delta(cm.today,cm.lastWeek,"спрямо миналата седмица"):"";
  kpi("k-cex","🏭","m","Цех · днес",'<b class="cu">0</b><small>€</small>',sub+"<span>"+c.stokovi_n+" стокови · "+c.today_clients+" клиента</span>",spark(c.series.slice(-30),"var(--money)","c"));
  countUp($("k-cex").querySelector(".cu"),c.today);
  mtdCard();lineChart();wdCard();clCard(c);cityCard();mapCard();factsCard(c);hmCard(c);recCard()}
function mtdRow(t,cur,prev,col,fc){var mx=Math.max(cur,prev,fc?fc.proj:0,1);return '<div class="pair"><div class="sub" style="justify-content:space-between"><b style="color:var(--ink);font-weight:600">'+t+'</b><span>'+delta(cur,prev,"спрямо миналия",50)+'</span></div>'
  +'<div class="r"><span>Този месец</span><div class="t"><i class="gr" style="width:'+(cur/mx*100)+'%;background:'+col+'"></i></div><b>'+eur(cur)+' €</b></div>'
  +'<div class="r"><span>Миналия</span><div class="t"><i class="gr" style="width:'+(prev/mx*100)+'%;background:var(--line2)"></i></div><b>'+eur(prev)+' €</b></div>'
  +(fc&&fc.left>=0?'<div class="r"><span>Прогноза</span><div class="fcb"><i class="gr" style="width:'+(fc.proj/mx*100)+'%;background:color-mix(in srgb,'+col+' 45%,transparent)"></i></div><b>'+eur(fc.proj)+' €</b></div><div class="sub" style="margin-top:1px">до края на месеца · '+delta(fc.proj,fc.prev,"спрямо цял миналия месец ("+eur(fc.prev)+" €)",50)+'</div>':'')+'</div>'}
function w7Row(w){return '<div class="sub" style="margin-top:2px">7 дни: <b style="color:var(--ink);font-weight:500">'+eur(w.cur)+' €</b> '+delta(w.cur,w.prev,"спрямо предишните 7",50)+'</div>'}
function mtdCard(){var h="",p=D.point,c=D.cex;
  if(p)h+=mtdRow("Точка",p.mtd.cur,p.mtd.prev,"var(--accent)",p.fc)+w7Row(p.w7);
  if(c)h+='<div style="height:6px"></div>'+mtdRow("Цех",c.mtd.cur,c.mtd.prev,"var(--money)",c.fc)+w7Row(c.w7);
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
  sets.forEach(function(q){var pts=[];q.data.forEach(function(p,i){if(p.v>0)pts.push({i:i,v:p.v})});if(!pts.length)return;
    var d="";pts.forEach(function(p,k){d+=(k?"L":"M")+X(p.i).toFixed(1)+" "+Y(p.v).toFixed(1)});
    s+='<path class="ar" d="'+d+"L"+X(pts[pts.length-1].i)+" "+Y(0)+"L"+X(pts[0].i)+" "+Y(0)+'Z" fill="url(#lg'+q.id+')"/><path class="ln" pathLength="1" d="'+d+'" style="stroke:'+q.col+'"/>';
    if(n<=31)pts.forEach(function(p){s+='<circle cx="'+X(p.i)+'" cy="'+Y(p.v)+'" r="2" fill="'+q.col+'"/>'});
    var lp=pts[pts.length-1];s+='<circle cx="'+X(lp.i)+'" cy="'+Y(lp.v)+'" r="3.5" fill="'+q.col+'"/>'});
  s+='<line id="vl" y1="'+T+'" y2="'+(H-B)+'" stroke="var(--line2)" style="display:none"/><rect id="hit" x="'+L+'" y="'+T+'" width="'+(W-L-R)+'" height="'+(H-T-B)+'" fill="transparent"/>';
  svg.setAttribute("viewBox","0 0 "+W+" "+H);svg.innerHTML=s;
  var hit=$("hit"),vl=$("vl");
  function at(e){var r=svg.getBoundingClientRect(),cx=e.touches?e.touches[0].clientX:e.clientX,px=(cx-r.left)*(W/r.width),i=Math.round((px-L)/step);return Math.max(0,Math.min(n-1,i))}
  function mv(e){var i=at(e);vl.setAttribute("x1",X(i));vl.setAttribute("x2",X(i));vl.style.display="";var d=base[i].d,h="<b>"+dm(d)+" · "+DOWN[dow(d)]+"</b>";sets.forEach(function(q){h+=q.name+" "+(q.data[i].v>0?nf0.format(Math.round(q.data[i].v))+" €":"няма продажби")+"<br>"});var cx=e.touches?e.touches[0].clientX:e.clientX,cy=e.touches?e.touches[0].clientY:e.clientY;showTip(h,cx,cy)}
  hit.addEventListener("mousemove",mv);hit.addEventListener("touchmove",mv,{passive:true});hit.addEventListener("mouseleave",function(){hideTip();vl.style.display="none"});
  var lg="";sets.forEach(function(q){lg+='<span><i style="background:'+q.col+'"></i>'+q.name+'</span>'});
  var bests="";sets.forEach(function(q){var b=null;q.data.forEach(function(x){if(!b||x.v>b.v)b=x});if(b&&b.v>0)bests+='<span style="color:var(--muted)">най-добър '+q.name.toLowerCase()+': '+dm(b.d)+' · '+eur(b.v)+' €</span>'});
  $("leg").innerHTML=lg+'<span style="color:var(--muted)">€ без ДДС</span>'+bests}
function f1(v){return v>=1000?nf1.format(v/1000)+"k":(v>=100?String(Math.round(v)):nf1.format(v))}
function colsHtml(vals,labels,hiIdx,cls,fmt){var mx=Math.max.apply(null,vals)||1,h='<div class="vb">';vals.forEach(function(v,i){h+='<div class="col '+(cls||"")+(i===hiIdx?" hi":"")+'" data-i="'+i+'"><b>'+(v>0?fmt(v):"")+'</b><i style="height:'+Math.max(v>0?4:0,v/mx*78)+'%"></i><span>'+labels[i]+'</span></div>'});return h+"</div>"}
function wdCard(){
  var src=D[ST.wd];if(!src)return;var wd=src.wd,vals=wd.map(function(x){return x.avg}),today=dow(src.to),mo=ST.wd==="cex"?"mo":"";
  var el=$("wd");el.innerHTML=colsHtml(vals,wd.map(function(x){return DOWN[x.dow]}),today-1,mo,kf);grow(el);
  var cols=el.querySelectorAll(".col");for(var i=0;i<cols.length;i++)(function(c){bindTip(c,function(){var x=wd[+c.getAttribute("data-i")];return "<b>"+DOWN[x.dow]+"</b>средно "+nf0.format(Math.round(x.avg))+" € · "+x.n+" дни с продажби"})})(cols[i]);
  var best=0;wd.forEach(function(x,i){if(x.avg>wd[best].avg)best=i});$("wd-sub").innerHTML='<span>най-силен: <b style="color:var(--ink);font-weight:500">'+(wd[best].avg>0?DOWN[wd[best].dow]+" · "+eur(wd[best].avg)+" €":"—")+'</b></span><span>средно на ден с продажби</span>'}
function hoursCard(p){
  var hs=[];for(var h=8;h<=22;h++)hs.push(h);var vals=hs.map(function(h){return p.hours[h]}),mx=Math.max.apply(null,vals),pk=vals.indexOf(mx),tot=vals.reduce(function(a,b){return a+b},0);
  var el=$("hours");el.innerHTML=colsHtml(vals,hs,pk,"",f1);grow(el);
  var cols=el.querySelectorAll(".col");for(var i=0;i<cols.length;i++)(function(c){bindTip(c,function(){var i=+c.getAttribute("data-i");return "<b>"+hs[i]+":00–"+(hs[i]+1)+":00</b>средно "+nf1.format(vals[i])+" € на ден · "+(tot?Math.round(vals[i]/tot*100):0)+"% от оборота"})})(cols[i]);
  $("h-sub").textContent=mx>0?"средно на ден · най-силен "+hs[pk]+":00":""}
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
  c.clients.slice(0,9).forEach(function(x){var dl=x.delta==null?"":' <span class="dl '+(x.delta>=0?"up":"down")+'">'+(x.delta>=0?"▲":"▼")+Math.abs(x.delta)+'%</span>';
    h+='<div class="row rc"><span class="n" title="'+esc(x.name)+'">'+esc(x.name)+'</span>'+sparkSmall(x.spark)+'<span class="sub">'+(x.today>0?"днес "+eur(x.today)+" € · ":"")+Math.round(x.v/tot*100)+'%'+dl+'</span><b>'+eur(x.v)+' €</b><div class="bar"><i class="gr" style="width:'+(x.v/mx*100)+'%"></i></div></div>'});
  if(c.clients.length>9)h+='<div class="empty">+ още '+(c.clients.length-9)+'</div>';el.innerHTML=h;grow(el)}
var COV=["var(--down)","var(--warn)","color-mix(in srgb,var(--money) 35%,transparent)","color-mix(in srgb,var(--money) 60%,transparent)","var(--money)"];
var MN=["","ян","фев","мар","апр","май","юни","юли","авг","сеп","окт","ное","дек"],MNF=["","януари","февруари","март","април","май","юни","юли","август","септември","октомври","ноември","декември"];
function monCard(){
  var m=D.months;if(!m)return;var who=ST.mon,el=$("mon"),first=0;
  while(first<m.months.length-1&&m.months[first][who]==null)first++;
  var ms=m.months.slice(first),vals=ms.map(function(x){return x[who]});
  if(vals.every(function(v){return v==null})){el.innerHTML='<div class="empty">Няма данни за '+(who==="point"?"точката":"цеха")+' сега.</div>';$("mon-sub").innerHTML="";return}
  var mx=Math.max.apply(null,vals.map(function(v){return v||0}))||1,cur=ms.length-1,h='<div class="vb" style="height:150px">';
  ms.forEach(function(x,i){var v=x[who];h+='<div class="col '+(who==="cex"?"mo ":"")+(i===cur?"hi":"")+'" data-i="'+i+'"><b>'+(v>0?kf(v):"")+'</b><i style="height:'+Math.max(v>0?4:0,(v||0)/mx*76)+'%"></i><span>'+MN[+x.ym.slice(5)]+'</span></div>'});
  el.innerHTML=h+"</div>";grow(el);
  var cols=el.querySelectorAll(".col");for(var i=0;i<cols.length;i++)(function(c){bindTip(c,function(){var i=+c.getAttribute("data-i"),x=ms[i],v=x[who],pv=i>0?ms[i-1][who]:null,t="<b>"+MNF[+x.ym.slice(5)]+" "+x.ym.slice(0,4)+"</b>"+(v==null?"няма данни":nf0.format(Math.round(v))+" € без ДДС");
    if(i===cur)t+="<br>до днес";else if(pv!=null&&pv>0&&v!=null)t+="<br>"+(v>=pv?"▲ ":"▼ ")+Math.abs((v-pv)/pv*100).toFixed(0)+"% спрямо предишния";return t})})(cols[i]);
  var full=ms.slice(0,cur).filter(function(x){return x[who]!=null}),best=null,tot=0;ms.forEach(function(x){tot+=x[who]||0});full.forEach(function(x){if(!best||x[who]>best[who])best=x});
  var since=first>0?' · от '+MNF[+ms[0].ym.slice(5)]:'';
  $("mon-sub").innerHTML='<span>общо'+since+': <b style="color:var(--ink);font-weight:500">'+eur(tot)+' €</b></span>'+(best?'<span>най-добър пълен месец: <b style="color:var(--ink);font-weight:500">'+MNF[+best.ym.slice(5)]+" · "+eur(best[who])+' €</b></span>':'')+'<span>последният е до днес</span>'}
function renderMonths(m){D.months=m;monCard()}
function cityCard(){
  var c=D.cex;if(!c)return;mapCard();var list=c.cities[ST.city]||[],el=$("city");
  if(!list.length){el.innerHTML='<div class="empty">—</div>';return}
  var tot=list.reduce(function(a,x){return a+x.v},0)||1,mx=list[0].v||1,h="";
  list.forEach(function(x,i){h+='<details class="cty"'+(i===0&&list.length>1?"":"")+'><summary><span><b>'+esc(x.city)+'</b> <span class="sub" style="display:inline">'+x.objects+(x.objects===1?" клиент":" клиента")+" · "+Math.round(x.v/tot*100)+'%</span></span><span class="sub">'+x.n+' ст.</span><b>'+eur(x.v)+' €</b><div class="bar"><i class="gr" style="width:'+(x.v/mx*100)+'%"></i></div></summary><div class="in">';
    x.clients.forEach(function(k){h+='<div class="row"><span class="n" title="'+esc(k.name)+'">'+esc(k.name)+'</span><span class="sub">'+k.n+' ст.</span><b>'+eur(k.v)+' €</b></div>'});h+="</div></details>"});
  el.innerHTML=h;grow(el)}
var CITYPOS={"Стара Загора":[42.43,25.62],"Сливен":[42.68,26.32],"Ямбол":[42.48,26.51],"Хасково":[41.93,25.56],"Казанлък":[42.62,25.40],"Нова Загора":[42.48,26.01],"Раднево":[42.30,25.93],"Чирпан":[42.20,25.33]},FAB=[42.449,25.688];
function mapCard(){
  var c=D.cex;if(!c)return;var list=c.cities[ST.city]||[],el=$("map");if(!list.length){el.innerHTML='<div class="empty">—</div>';return}
  var W=400,H=290,la0=41.82,la1=42.85,lo0=25.15,lo1=26.65;
  function X(lo){return 18+(lo-lo0)/(lo1-lo0)*(W-36)}function Y(la){return 14+(la1-la)/(la1-la0)*(H-28)}
  var mx=Math.max.apply(null,list.map(function(x){return x.v}))||1,s="";
  list.forEach(function(x,i){var p=CITYPOS[x.city];if(!p||x.city==="Стара Загора")return;s+='<line class="rt" x1="'+X(FAB[1])+'" y1="'+Y(FAB[0])+'" x2="'+X(p[1])+'" y2="'+Y(p[0])+'" style="animation-delay:'+(i*0.15)+'s"/>'});
  list.forEach(function(x,i){var p=CITYPOS[x.city];if(!p)return;var cx=X(p[1]),cy=Y(p[0]),r=5+Math.sqrt(x.v/mx)*19;
    s+='<g class="bb" data-i="'+i+'"><circle class="pl" cx="'+cx+'" cy="'+cy+'" r="'+r+'"/><circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="color-mix(in srgb,var(--money) 38%,transparent)" stroke="var(--money)" stroke-width="1.5"/><text x="'+cx+'" y="'+(cy+r+11)+'" text-anchor="middle" font-size="10" fill="var(--ink2)">'+esc(x.city)+'</text>'+(r>13?'<text x="'+cx+'" y="'+(cy+3.5)+'" text-anchor="middle" font-size="10" font-weight="600" fill="var(--ink)">'+kf(x.v)+'</text>':'')+'</g>'});
  s+='<rect x="'+(X(FAB[1])-5)+'" y="'+(Y(FAB[0])-5)+'" width="10" height="10" rx="2" fill="var(--accent)"/><text x="'+(X(FAB[1])+9)+'" y="'+(Y(FAB[0])-7)+'" font-size="10" font-weight="600" fill="var(--accent)">цех</text>';
  el.innerHTML='<svg viewBox="0 0 '+W+" "+H+'" class="map" role="img" aria-label="Оборот на цеха по градове">'+s+'</svg>';
  var tot=list.reduce(function(a,x){return a+x.v},0)||1,gs=el.querySelectorAll(".bb");for(var i=0;i<gs.length;i++)(function(g){bindTip(g,function(){var x=list[+g.getAttribute("data-i")];return "<b>"+esc(x.city)+"</b>"+nf0.format(Math.round(x.v))+" € · "+Math.round(x.v/tot*100)+"%<br>"+x.objects+(x.objects===1?" клиент":" клиента")+" · "+x.n+" стокови"})})(gs[i])}
function factsCard(c){var el=$("facts");if(!c.facts.length){el.innerHTML='<div class="empty">—</div>';return}var ic={warn:"⚠",up:"▲",down:"▼",info:"•","new":"✦"},h="";
  c.facts.forEach(function(f){h+='<div class="fct '+f.t+'"><span class="fi">'+(ic[f.t]||"•")+'</span><span>'+esc(f.text)+'</span></div>'});el.innerHTML=h}
var DAYS7=["пн","вт","ср","чт","пт","сб","нд"];
function hmCard(c){var el=$("hm"),r=c.rhythm;if(!r.length){el.innerHTML='<div class="empty">—</div>';return}
  var mx=0;r.forEach(function(x){x.d.forEach(function(v){if(v>mx)mx=v})});mx=mx||1;
  var h='<div class="hmg"><span></span>';DAYS7.forEach(function(d){h+='<b>'+d+'</b>'});
  r.forEach(function(x,ri){h+='<span class="hn" title="'+esc(x.name)+'">'+esc(x.name)+'</span>';x.d.forEach(function(v,i){var a=v>0?Math.max(.14,Math.sqrt(v/mx)):0;h+='<i data-r="'+ri+'" data-c="'+i+'" style="background:'+(v>0?"color-mix(in srgb,var(--money) "+Math.round(a*88)+"%,transparent)":"var(--soft)")+'">'+(x.n[i]||"")+'</i>'})});
  el.innerHTML=h+"</div>";var cs=el.querySelectorAll("i");for(var i=0;i<cs.length;i++)(function(e){bindTip(e,function(){var x=r[+e.getAttribute("data-r")],d=+e.getAttribute("data-c");return "<b>"+esc(x.name)+"</b>"+DAYS7[d]+": "+x.n[d]+" стокови · "+nf0.format(Math.round(x.d[d]))+" €"})})(cs[i])}
function sparkSmall(a){var mx=Math.max.apply(null,a)||1,n=a.length,d="";a.forEach(function(v,i){d+=(i?"L":"M")+(i/(n-1)*52).toFixed(1)+" "+(15-13*(v/mx)).toFixed(1)});return '<svg class="spk" viewBox="0 0 52 16" preserveAspectRatio="none"><path d="'+d+'" fill="none" stroke="var(--money)" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'}
function salesTop(d){
  if(!d||!d.arts.length)return '<div class="empty">—</div>';
  var mx=d.arts[0].rev||1,h='<div class="pod">';
  d.arts.slice(0,3).forEach(function(a,i){h+='<div class="pd p'+i+'"><div class="md">'+["🥇","🥈","🥉"][i]+'</div><div class="pn" title="'+esc(a.n)+'">'+esc(a.n)+'</div><div class="pv">'+eur(a.rev)+' €</div><div class="sub">'+nf0.format(a.units)+' бр'+(a.m!=null?" · марж "+a.m+"%":"")+'</div><div class="pb"><i class="gr" style="width:'+(a.rev/mx*100)+'%"></i></div></div>'});
  h+="</div>";
  d.arts.slice(3).forEach(function(a){h+='<div class="row"><span class="n" title="'+esc(a.n)+'">'+esc(a.n)+'</span><span class="sub">'+nf0.format(a.units)+" бр · "+nf1.format(a.share)+'%'+(a.m!=null?" · марж "+a.m+"%":"")+'</span><b>'+eur(a.rev)+' €</b><div class="bar"><i class="gr" style="width:'+(a.rev/mx*100)+'%"></i></div></div>'});
  return h}
function salesCard(){
  var s=D.sales;if(!s)return;var ctl=$("sales-ctl"),sg=ST.sg,h='<span class="seg" id="seg-sg"><button data-v="all"'+(sg==="all"?' class="on"':"")+'>Всички</button>';
  Object.keys(s.groups).forEach(function(g){h+='<button data-v="'+esc(g)+'"'+(sg===g?' class="on"':"")+'>'+esc(g.replace("Стара Загора и СиБиЕс","Ст. Загора и СиБиЕс"))+'</button>'});
  h+='</span><select id="sel-cl"><option value="">По клиент…</option>';s.clients.forEach(function(c){h+='<option value="c:'+c.id+'"'+(sg==="c:"+c.id?" selected":"")+'>'+esc(c.name)+" · "+eur(c.rev)+' €</option>'});h+="</select>";
  ctl.innerHTML=h;
  var bs=ctl.querySelectorAll("#seg-sg button");for(var i=0;i<bs.length;i++)bs[i].onclick=function(){ST.sg=this.getAttribute("data-v");salesCard()};
  $("sel-cl").onchange=function(){if(this.value){ST.sg=this.value;salesCard()}};
  var d=sg==="all"?s.all:sg.indexOf("c:")===0?s.clients.filter(function(c){return "c:"+c.id===sg})[0]:s.groups[sg];
  $("sales-sub").textContent="от 1 януари · "+(d?eur(d.rev)+" € · "+d.n+" артикула":"")+(s.missing?" · непълно":"");
  var el=$("sales");el.innerHTML=salesTop(d);grow(el)}
function renderSales(s){D.sales=s;salesCard()}
function alertsBar(){
  var a=[],s=D.stock,c=D.cex,p=D.point,el=$("alerts");
  if(s){if(s.zero_n)a.push({t:"bad",x:s.zero_n+" на нула в склада",go:"c-sup"});if(s.risk_n)a.push({t:"warn",x:s.risk_n+" арт. ще свършат преди доставка",go:"c-risk"})}
  if(c)c.facts.forEach(function(f){if(f.t==="warn"||f.t==="down")a.push({t:f.t==="warn"?"warn":"bad",x:f.text,go:"c-facts"})});
  var h=new Date().getHours();
  if(p&&p.cmp&&p.cmp.lastWeek>=100&&p.cmp.today<p.cmp.lastWeek*0.7&&h>=12)a.push({t:"bad",x:"Точката е "+Math.round((1-p.cmp.today/p.cmp.lastWeek)*100)+"% под същия час миналата седмица",go:"k-point"});
  var loaded=(s?1:0)+(c?1:0)+(p?1:0);if(!loaded){el.innerHTML="";return}
  if(!a.length){el.innerHTML='<span class="al ok"><span>✓ Нищо спешно</span></span>';return}
  el.innerHTML="";a.slice(0,6).forEach(function(x){var e=document.createElement("button");e.className="al "+x.t;e.innerHTML="<span>"+(x.t==="bad"?"● ":"▲ ")+esc(x.x)+"</span>";e.onclick=function(){var t=$(x.go);if(t)t.scrollIntoView({behavior:"smooth",block:"center"})};el.appendChild(e)})}
function renderMargin(m){D.margin=m;var el=$("margin");$("margin-sub").textContent="от 1 януари · печалба "+eur(m.profit)+" € · марж "+(m.margin!=null?nf1.format(m.margin)+"%":"—");
  if(!m.rows.length){el.innerHTML='<div class="empty">—</div>';return}
  var mx=m.rows[0].profit||1,h="";
  m.rows.slice(0,10).forEach(function(r){var cls=r.margin==null?"g2":r.margin>=35?"ok":r.margin<20?"bd":"";h+='<div class="row"><span class="n" title="'+esc(r.name)+'">'+esc(r.name)+'</span><span class="sub"><span class="chip '+cls+'">'+(r.margin!=null?nf1.format(r.margin)+"%":"—")+'</span> оборот '+eur(r.rev)+' €</span><b>'+eur(r.profit)+' €</b><div class="bar"><i class="gr" style="width:'+Math.max(2,r.profit/mx*100)+'%"></i></div></div>'});
  if(m.rows.length>10)h+='<div class="empty">+ още '+(m.rows.length-10)+'</div>';
  el.innerHTML=h;grow(el)}
function recCard(){var el=$("rec"),p=D.point,c=D.cex;if(!p&&!c)return;var t="";
  function tile(a,b,c2){return '<div class="rc2"><div class="t">'+a+'</div><b>'+b+'</b><div class="sub">'+c2+'</div></div>'}
  if(p&&p.best)t+=tile("Най-добър ден · точка",eur(p.best.v)+" €",dm(p.best.d)+" · "+DOWN[dow(p.best.d)]);
  if(c&&c.best)t+=tile("Най-добър ден · цех",eur(c.best.v)+" €",dm(c.best.d)+" · "+DOWN[dow(c.best.d)]);
  if(p&&p.best_week)t+=tile("Най-добри 7 дни · точка",eur(p.best_week.v)+" €",dm(p.best_week.from)+"–"+dm(p.best_week.to));
  if(c&&c.best_week)t+=tile("Най-добри 7 дни · цех",eur(c.best_week.v)+" €",dm(c.best_week.from)+"–"+dm(c.best_week.to));
  if(c&&c.big)t+=tile("Най-голяма стокова",eur(c.big.v)+" €",esc(c.big.name)+" · "+dm(c.big.d));
  if(p){var mx=0,pk=0;p.hours.forEach(function(v,i){if(v>mx){mx=v;pk=i}});if(mx>0)t+=tile("Най-силен час · точка",pk+":00",'средно '+nf1.format(mx)+' € на ден')}
  el.innerHTML='<div class="rec">'+t+'</div>'}
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
  var map={point:renderPoint,cex:renderCex,stock:renderStock,orders:renderOrders,months:renderMonths,cexsales:renderSales,cexmargin:renderMargin};
  return getPart(part).then(function(j){if(!j||!j.ok)throw new Error("x");D[part]=j;map[part](j);alertsBar();stamp()})
  .catch(function(){if(part==="point"){fail("k-point","point");fail("mtd","point");fail("hours","point");fail("mix","point");fail("top","point")}else if(part==="cex"){fail("k-cex","cex");fail("cl","cex");fail("city","cex");fail("map","cex");fail("facts","cex");fail("hm","cex")}else if(part==="months"){fail("mon","months")}else if(part==="cexsales"){fail("sales","cexsales")}else if(part==="cexmargin"){fail("margin","cexmargin")}else if(part==="stock"){fail("k-stock","stock");fail("k-order","stock");fail("risk","stock");fail("sup","stock");fail("idle","stock")}else fail("ord","orders")})}
function all(){["point","cex","stock","orders","months","cexsales","cexmargin"].forEach(load)}
$("rf").onclick=function(){$("dot").className="dot off";$("upd").textContent="обновявам…";all()};
function tabs(id,key,fn){var b=$(id).querySelectorAll("button");for(var i=0;i<b.length;i++)b[i].onclick=function(){for(var j=0;j<b.length;j++)b[j].classList.remove("on");this.classList.add("on");ST[key]=this.getAttribute("data-v");fn()}}
tabs("seg-mon","mon",monCard);tabs("seg-city","city",cityCard);tabs("seg-who","who",lineChart);tabs("seg-n","n",lineChart);tabs("seg-wd","wd",wdCard);
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

module.exports = { marginView, forecast, bestWeek, salesView, cexFacts, monthsView, cityOf, cityGroups, ownerKey, keyOk, partData, page, pointView, cexView, stockView, ordersView, series, mtdPair, weekSum, weekdayAvg, plusDays, sofiaDate, prevMonthStart, JS };
