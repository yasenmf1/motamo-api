// lib/payroll.js — РЕАЛНИ фиксирани разходи по месеци (бруто заплати по ведомостите на „ЧОВЕК И БЪДЕЩЕ ЕООД").
// ★ S31 (14.10): собственикът даде ведомостите 01–09.2026 → дашбордите смятат по тях, не по една средна сума.
// Единица: "cex" (цехът) / "shop" (точката Каравелов, от 01.09.2026). Роксана е в точката от 09.2026
// (07–08 е била в цеха). Радостина (01–05) е в цеха. Месец без ведомост (10.2026+) = последният известен (09).
// Осигуровки за сметка на работодателя: ~18,92 % върху бруто, таван на осиг. доход 2300 €/мес (ориентир —
// точната сума чака счетоводителя). Наем/ток на точката: 500 + 250 €/мес от 09.2026.

const EMPLOYER_OSIG_RATE = 0.1892, OSIG_CAP = 2300;
const START = "2026-01";               // първата ведомост
const SHOP_START = "2026-09";          // точката
const SHOP_OTHER = [{ label: "Наем", amount: 500 }, { label: "Ток", amount: 250 }];

// бруто по месеци (null = не е в ведомостта)
const PEOPLE = [
  { label: "Ясен Начев (управител)",   unit: "cex",  m: { "2026-01": 3687.95, "2026-02": 4315.43, "2026-03": 3687.95, "2026-04": 3688.31, "2026-05": 3688.31, "2026-06": 4200.00, "2026-07": 4200.00, "2026-08": 4240.00, "2026-09": 5129.49 } },
  { label: "Румена Тенева",            unit: "cex",  m: { "2026-01": 1420.37, "2026-02": 1420.37, "2026-03": 1170.07, "2026-04": 1420.37, "2026-05": 1420.73, "2026-06": 1420.37, "2026-07": 1420.37, "2026-08": 1420.36, "2026-09": 1420.37 } },
  { label: "Йорданка Янкова",          unit: "cex",  m: { "2026-01": 1091.09, "2026-02": 1264.13, "2026-03": 1091.09, "2026-04": 1091.09, "2026-05": 1220.32, "2026-06": 1091.09, "2026-07": 1091.09, "2026-08": 1198.09, "2026-09": 1588.48 } },
  { label: "Радостина Начева",         unit: "cex",  m: { "2026-01": 901.78,  "2026-02": 1564.98, "2026-03": 1340.97, "2026-04": 1288.26, "2026-05": 1288.62 } },
  { label: "Диана Филипова",           unit: "cex",  m: { "2026-03": 89.55, "2026-04": 940.62, "2026-05": 940.62, "2026-06": 940.26, "2026-07": 940.26, "2026-08": 817.02, "2026-09": 587.10 } },
  { label: "Мария Пейчева",            unit: "cex",  m: { "2026-05": 650.32, "2026-06": 939.92, "2026-07": 939.92, "2026-08": 1068.77, "2026-09": 1250.01 } },
  { label: "Димитър Митев",            unit: "cex",  m: { "2026-05": 460.59, "2026-06": 1390.95, "2026-07": 1390.95, "2026-08": 942.51 } },
  { label: "Митьо Димитров (шофьор)",  unit: "cex",  m: { "2026-06": 278.56, "2026-07": 824.35, "2026-08": 1008.44, "2026-09": 824.35 } },
  { label: "Роксана Панчева",          unit: "cex",  m: { "2026-07": 937.28, "2026-08": 1197.64 } },           // преди точката — в цеха
  { label: "Роксана Панчева",          unit: "shop", m: { "2026-09": 1616.48 } },
  { label: "Станислав Покотилюк",      unit: "cex",  m: { "2026-09": 827.14 } },
  // Лидия (на мястото на Диана, от 10.2026) — още няма ведомост; октомври се смята по септември.
];
const LAST_KNOWN = "2026-09";

function ym(d) { return d.slice(0, 7); }
function addMonth(m) { const [y, mo] = m.split("-").map(Number); const d = new Date(Date.UTC(y, mo, 1)); return d.toISOString().slice(0, 7); }
function daysInMonth(m) { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }
function monthStart(m) { return m + "-01"; }
function monthEnd(m) { return m + "-" + String(daysInMonth(m)).padStart(2, "0"); }

// Заплатите за месец m по единица; месец след последната ведомост → последната известна.
function salariesFor(unit, m) {
  const key = m > LAST_KNOWN ? LAST_KNOWN : m;
  const out = [];
  for (const p of PEOPLE) if (p.unit === unit && p.m[key] != null) out.push({ label: p.label, amount: p.m[key] });
  return out;
}
function osigOf(salaries) { return Math.round(salaries.reduce((s, l) => s + Math.min(l.amount, OSIG_CAP) * EMPLOYER_OSIG_RATE, 0) * 100) / 100; }
function otherFor(unit, m) { return unit === "shop" && m >= SHOP_START ? SHOP_OTHER : []; }

// Фиксирани разходи за [from, to] — по месеци, частичен месец пропорционално по дни.
function fixedFor(unit, from, to) {
  const start = unit === "shop" ? SHOP_START : START;
  const r2 = x => Math.round(x * 100) / 100;
  let m = ym(from) < start ? start : ym(from);
  const byMonth = [], perPerson = {}, perOther = {};
  let total = 0, months = 0, salSum = 0, osigSum = 0, othSum = 0;
  while (m <= ym(to)) {
    const a = from > monthStart(m) ? from : monthStart(m), b = to < monthEnd(m) ? to : monthEnd(m);
    const days = (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000 + 1;
    if (days > 0) {
      const share = days / daysInMonth(m);
      const sal = salariesFor(unit, m), osig = osigOf(sal), oth = otherFor(unit, m);
      const gross = sal.reduce((s, l) => s + l.amount, 0), othM = oth.reduce((s, l) => s + l.amount, 0);
      const mt = (gross + osig + othM) * share;
      byMonth.push({ month: m, gross: r2(gross), osig: osig, other: r2(othM), total: r2(mt), share: Math.round(share * 100) / 100, estimated: m > LAST_KNOWN });
      total += mt; months += share; salSum += gross * share; osigSum += osig * share; othSum += othM * share;
      for (const l of sal) perPerson[l.label] = (perPerson[l.label] || 0) + l.amount * share;
      for (const l of oth) perOther[l.label] = (perOther[l.label] || 0) + l.amount * share;
    }
    m = addMonth(m);
  }
  const salaries = Object.entries(perPerson).map(([label, amount]) => ({ label, amount: r2(amount) }));
  const other = Object.entries(perOther).map(([label, amount]) => ({ label, amount: r2(amount) }));
  return {
    total: r2(total), months: Math.round(months * 100) / 100, monthly: months > 0 ? r2(total / months) : 0,
    salaries, other, salSum: r2(salSum), othSum: r2(othSum), osig: r2(osigSum), byMonth,
    source: `по ведомости 01–${LAST_KNOWN.slice(5)}.2026` + (byMonth.some(x => x.estimated) ? `; след ${LAST_KNOWN.slice(5)}.2026 = по ${LAST_KNOWN.slice(5)}` : "")
  };
}

module.exports = { fixedFor, PEOPLE, LAST_KNOWN, EMPLOYER_OSIG_RATE, OSIG_CAP };
