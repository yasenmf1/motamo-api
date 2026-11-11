// tools/owner_dry.js — суха проба на lib/ownerdash.js: известни числа → очаквани отговори (без Barsy, без мрежа).
// Пуска се: node tools/owner_dry.js
process.env.PEEK_TOKEN = "dry";
const OD = require("../lib/ownerdash.js");
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("✗", m); } else console.log("✓", m); };

// ── ключ ──
ok(OD.keyOk(OD.ownerKey()) && !OD.keyOk("x".repeat(24)) && !OD.keyOk(undefined), "ключът: верен минава, чужд и празен не");

// ── редове по дни: липсващ ден = 0 ──
const s = OD.series({ "2026-11-09": 100.126, "2026-11-11": 50 }, "2026-11-09", "2026-11-11");
ok(s.length === 3 && s[0].v === 100.13 && s[1].v === 0 && s[2].v === 50, "дни: 09=100,13; 10=0 (няма продажби); 11=50");

// ── точка ──
const p = OD.pointView({ by_day: { "2026-10-20": 10, "2026-11-02": 200, "2026-11-11": 300 }, accounts: 7, avg_check: 12.345, cmp: { today: 300, lastWeek: 250, hm: "14:30" } }, "2026-10-13", "2026-11-11");
ok(p.series.length === 30 && p.today === 300 && p.month === 500 && p.total30 === 510 && p.cmp.lastWeek === 250, "точка: днес 300, месец 500 (ноември), 30 дни 510");

// ── цех ──
const c = OD.cexView({ by_day: { "2026-11-11": 1000, "2026-11-10": 800, "2026-10-31": 50 } },
  { total_neto: 1000, accounts: 3, clients: [{ client_id: 1, name: "Б", turnover: 300, accounts: 1 }, { client_id: 2, name: "А", turnover: 700, accounts: 2 }, { client_id: 3, name: "Нула", turnover: 0, accounts: 0 }] }, "2026-10-13", "2026-11-11");
ok(c.today === 1000 && c.stokovi_n === 3 && c.month === 1800 && c.total30 === 1850, "цех: днес 1000, 3 стокови, месец 1800");
ok(c.clients.length === 2 && c.clients[0].name === "А" && c.clients[0].v === 700, "стокови: най-големият първи, нулевият клиент се скрива");

// ── склад: известни числа ──
const rep = {
  for_date: "2026-11-11",
  raw: [
    { n: "А", u: "кг", s: 10, c: 2, lead: 3, v28: 5, v7: 4, vp: 0, sup: "Фиш", val: 100 },     // gap −1 → риск; нужно (3+7)*5 − 10 = 40
    { n: "Б", u: "кг", s: 50, c: 10, lead: 2, v28: 5, v7: 5, vp: 0, sup: "Фиш", val: 200 },     // ок
    { n: "В", u: "бр", s: 0, c: 0, lead: 1, v28: 0, v7: 2, vp: 0, sup: "Брадърс", val: 0 },     // нула → риск; нужно (1+7)*2 − 0 = 16
    { n: "Г", u: "л", s: 5, c: null, lead: 2, v28: 0, v7: 0, vp: 0, sup: "Брадърс", val: 50 }, // без разход → не е риск
    { n: "Д", u: "кг", s: 20, c: 1, lead: 4, v28: 10, v7: 12, vp: 1, sup: "—", val: 80 }       // gap −3 → риск, без доставчик; нужно (4+7)*(12+1) − 20 = 123
  ],
  toPoint: [{ n: "Т", s: 3, u: "кг", val: 30 }], rest: [{ n: "Р", s: 9, u: "кг", val: 70 }, { n: "Р2", s: 1, u: "кг", val: 5 }]
};
const st = OD.stockView(rep);
ok(st.risk_n === 3 && st.sup_n === 3, "склад: 3 артикула под риск при 3 „доставчика“ (с „—“)");
ok(st.value === 100 + 200 + 0 + 50 + 80 + 30 + 70 + 5, "склад в пари = " + st.value + " (535)");
ok(st.zero_n === 1, "на нула: 1 (В)");
ok(st.groups[0].sup === "—" && st.groups[0].worst === -3, "групите: най-лошата първа (без доставчик, −3 дни)");
const g = Object.fromEntries(st.groups.map(x => [x.sup, x]));
ok(g["Фиш"].items.length === 1 && g["Фиш"].items[0].need === 40 && g["Брадърс"].items[0].need === 16 && g["—"].items[0].need === 123, "предложени количества 40 / 16 / 123");
ok(st.idle[0].n === "Р" && st.idle_value === 105, "залежало: най-скъпото първо, общо 105");

// ── поръчки ──
const o = OD.ordersView([{ at: "2026-11-11T10:00:00Z", supplier: "Фиш", body: "🛒 Поръчка към Фиш (пусната към доставчика):\n- 5 кг А\n- 3 кг Б" }]);
ok(o.items[0].sup === "Фиш" && o.items[0].n === 2, "поръчки: доставчик „Фиш“, 2 реда");

// ── страницата: синтаксис на скрипта, няма тайни ──
const html = OD.page("KEY123", { order: "/api/transfer?view=order&k=abc" });
const m = html.match(/<script>([\s\S]*)<\/script>/);
let syntax = true; try { new Function(m[1]); } catch (e) { syntax = false; console.log(e.message); }
ok(syntax, "скриптът на страницата няма синтактична грешка");
ok(!/dry/.test(html), "страницата не съдържа PEEK_TOKEN");

console.log(fails ? "\nПРОВАЛИ: " + fails : "\nВСИЧКО МИНА");
process.exit(fails ? 1 : 0);
