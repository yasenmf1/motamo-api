// ★ S25 — Маршрут на буса (собственикът, 29.09). Ред на спирките; ключ = обектът в Barsy на
// цеха („client_id:person_id", празен person = клиент без под-обект). Спирка без стокова за
// деня се СКРИВА. Адресът е за Google Maps навигацията (търси се по адрес, с жив трафик).
// Хасково (Хай Левел) с буса е САМО в понеделник — в сряда и петък отива с външен транспорт.
// Сливен (Мерканто) — вторник и петък; редът там е по сайта, докато собственикът не даде свой.
// Чирпан, Раднево и Нова Загора ги зарежда СиБиЕс — не са в маршрута на буса (02.10).
// geo = точката на обекта (от собственика, Google Maps, 02.10): по нея ботът разбира пристигане/тръгване и води навигацията.
// ★ S31 — zone (собственикът, 13.10): Запад (университета, Траки) · Център (Стенли, Тара, Винил, Athletic) · СиБиЕс Запад/Изток (ВИНАГИ отделно от другите) · Сливен · Хасково. Обектите се листват на ОТДЕЛНИ МАРШРУТИ (по зони, в същия ред) и всеки има
// бутон Waze (Waze води само до ЕДНА точка — няма маршрут с много спирки; Google остава за целия).
const ROUTE = [
  // ── Стара Загора (ред на собственика, окончателен) ──
  { keys: ["5:18"], zone: "Запад", name: "Кафене Медицински (Тракийски у-т)", addr: "42.424960,25.608623", geo: [42.42496, 25.608623] },
  { keys: ["4:"], zone: "Запад", name: "Траки Магазин (А шоп)", addr: "ул. Армейска 13, Стара Загора", geo: [42.42282487376506, 25.607724085252933] },
  { keys: ["5:17"], zone: "Запад", name: "Кафене Академика (Тракийски у-т)", addr: "42.401847,25.571918", geo: [42.401847, 25.571918] },
  { keys: ["5:16"], zone: "Запад", name: "Кафене Форум (Тракийски у-т)", addr: "42.400816,25.571797", geo: [42.400816, 25.571797] },
  { keys: ["2:7"], zone: "СиБиЕс Запад", name: "СиБиЕс Три чучура 13А", addr: "ж.к. Три чучура 13А, Стара Загора", geo: [42.4186839555064, 25.605311491676204] },
  { keys: ["2:11"], zone: "СиБиЕс Запад", name: "СиБиЕс Железник", addr: "ул. Старозагорско въстание 49, Стара Загора", geo: [42.41215707540321, 25.59147766678746] },
  { keys: ["2:8"], zone: "СиБиЕс Изток", name: "СиБиЕс Христо Ботев 26", addr: "ул. Христо Ботев 26, Стара Загора", geo: [42.42036277416872, 25.61950719675141] },
  { keys: ["2:9"], zone: "СиБиЕс Изток", name: "СиБиЕс Ген. Столетов 36 (Енергото)", addr: "ул. Генерал Столетов 36, Стара Загора", geo: [42.42692448606355, 25.620966641408412] },
  { keys: ["2:6"], zone: "СиБиЕс Изток", name: "СиБиЕс Св. Г. Клисаров 2 (Стадиона)", addr: "ул. Свещеник Георги Клисаров 2, Стара Загора", geo: [42.42934636102516, 25.617300276375044] },
  { keys: ["2:5"], zone: "СиБиЕс Изток", name: "СиБиЕс Димитър Наумов 100 (Руслан)", addr: "ул. Димитър Наумов 100, Стара Загора", geo: [42.4300677451653, 25.62736038900887] },
  { keys: ["2:2"], zone: "СиБиЕс Изток", name: "СиБиЕс Ген. Столетов 149", addr: "ул. Генерал Столетов 149, Стара Загора", geo: [42.429809124911436, 25.63389714164644] },
  { keys: ["2:3"], zone: "СиБиЕс Изток", name: "СиБиЕс Патриарх Евтимий 80а", addr: "бул. Свети Патриарх Евтимий 80А, Стара Загора", geo: [42.42231007977909, 25.63606772721764] },
  { keys: ["2:1"], zone: "СиБиЕс Изток", name: "СиБиЕс Ангел Кънчев 68", addr: "ул. Ангел Кънчев 68, Стара Загора", geo: [42.42458155635037, 25.641821969423926] },
  { keys: ["2:4"], zone: "СиБиЕс Изток", name: "СиБиЕс Граф Игнатиев 59 (Бедечка)", addr: "ул. Граф Игнатиев 59, Стара Загора", geo: [42.43003467691411, 25.64324436190712] },
  { keys: ["7:"], zone: "Център", name: "Магазин Сити (СТЕНЛЛИ СЗ)", addr: "бул. Руски 38А, Стара Загора", geo: [42.425885109964625, 25.627762908305545] },
  { keys: ["10:"], zone: "Център", name: "Тара Шуус", addr: "бул. Руски 38А, Стара Загора", geo: [42.42446534211362, 25.628145672548076] },
  { keys: ["5:19"], zone: "Център", name: "Кафе Винил (Пламен Петров)", addr: "42.426128983069646,25.625284245584727", geo: [42.426128983069646, 25.625284245584727] },
  { keys: ["8:22", "8:"], zone: "Център", name: "Athletic Fitness (Mall)", addr: "Mall Galleria Stara Zagora", geo: [42.43832167896169, 25.631937219878665] },
  { keys: ["8:21"], zone: "Център", name: "Athletic Fitness Универсален", addr: "Универсален магазин, Стара Загора", geo: [42.42446534211362, 25.628145672548076] },
  // ── Сливен (Вт, Пт) — ред по сайта, да се потвърди ──
  { keys: ["11:23"], zone: "Сливен", name: "Мерканто Дружба", addr: "ж.к. Дружба 20, Сливен", geo: [42.67697374886367, 26.34998995637594] },
  { keys: ["11:32"], zone: "Сливен", name: "Мерканто пл. Левски", addr: "пл. Васил Левски, Сливен", geo: [42.6818836635775, 26.322416188746665] },
  { keys: ["11:25"], zone: "Сливен", name: "Мерканто Хитов", addr: "бул. Панайот Хитов 20, Сливен", geo: [42.6872677582563, 26.332210985818833] },
  { keys: ["11:26"], zone: "Сливен", name: "Мерканто Клуцохор", addr: "ул. Георги Икономов 19, Сливен", geo: [42.67756750041798, 26.30559322368353] },
  { keys: ["11:27"], zone: "Сливен", name: "Мерканто Стамболийски", addr: "ул. Александър Стамболийски 8, Сливен", geo: [42.6814131226668, 26.325013124684705] },
  { keys: ["11:28"], zone: "Сливен", name: "Мерканто Пехливанов", addr: "ул. Димитър Пехливанов 2А, Сливен", geo: [42.681025519163384, 26.311319877563516] },
  { keys: ["11:29"], zone: "Сливен", name: "Мерканто Заимов", addr: "кв. Стоян Заимов 99, Сливен", geo: [42.67304853754508, 26.336808104524046] },
  { keys: ["11:30"], zone: "Сливен", name: "Мерканто Сини камъни", addr: "бул. Стефан Стамболов 50, Сливен", geo: [42.68841054101318, 26.341907259121783] },
  { keys: ["11:31"], zone: "Сливен", name: "Мерканто 10", addr: "бул. Бургаско шосе 61, Сливен", geo: [42.67402834791774, 26.348849051821112] },
  // ── Хасково (само понеделник с буса) ──
  { keys: ["9:"], zone: "Хасково", name: "Хай Левел Хасково", addr: "ул. Дунав 19А, Хасково", geo: [41.94033124284026, 25.558398613081085], onlyDow: [1] }
];
const stopKey = s => s.keys[0];
for (const s of ROUTE) if (s.geo) { s.place = s.addr; s.addr = s.geo.join(","); } // навигацията води до точката, не до адреса по име

// Google Maps навигация (без origin = от текущото място; жив трафик). До 9 междинни спирки.
function mapsLinks(stops) {
  const out = [];
  stops = stops.filter(s => s && s.addr);   // нов обект без адрес не влиза в навигацията
  for (let i = 0; i < stops.length; i += 10) {
    const part = stops.slice(i, i + 10);
    const dest = part[part.length - 1].addr, wps = part.slice(0, -1).map(s => s.addr);
    out.push({ from: i + 1, to: i + part.length, url: "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + encodeURIComponent(dest)
      + (wps.length ? "&waypoints=" + encodeURIComponent(wps.join("|")) : "") });
  }
  return out;
}
// Waze — само до една точка (ll=lat,lng; navigate=yes отваря навигацията направо).
function wazeLink(stop) { return stop && stop.addr ? "https://www.waze.com/ul?ll=" + encodeURIComponent(stop.addr) + "&navigate=yes&zoom=17" : null; }
function googleLink(stop) { return stop && stop.addr ? "https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + encodeURIComponent(stop.addr) : null; }
// Спирките за деня → маршрути (собственикът, 13.10). Зоните са в СЕМЕЙСТВА:
//   „Стара Загора" = Запад + Център (всички НЕ-СиБиЕс магазини в града);
//   „СиБиЕс" = СиБиЕс Запад + СиБиЕс Изток — ВИНАГИ отделен маршрут от другите;
//   Сливен, Хасково — сами.
// В едно семейство: общо ≤ FAMILY_ONE_ROUTE_MAX обекта → ЕДИН маршрут с името на семейството;
// иначе (пълен ден): по зони, ако всяка има ≥ 3 обекта; иначе на равни части по реда на собственика (запад → изток).
// Редът вътре = редът на собственика (ROUTE). Ред на маршрутите = ZONE_ORDER.
const ZONE_ORDER = ["Запад", "Център", "СиБиЕс Запад", "СиБиЕс Изток", "Сливен", "Хасково"];
const FAMILY = { "Запад": "Стара Загора", "Център": "Стара Загора", "СиБиЕс Запад": "СиБиЕс", "СиБиЕс Изток": "СиБиЕс" };
const FAMILY_ONE_ROUTE_MAX = 8, MIN_PER_ZONE = 3;
const routeIdx = s => { const i = ROUTE.findIndex(r => stopKey(r) === s.key); return i < 0 ? 999 : i; };
const RANK_ALIAS = { "Стара Загора": "Запад", "СиБиЕс": "СиБиЕс Запад" };   // имената на семействата се редят като първата им зона
const rank = z => { const z0 = String(z).split(" + ")[0]; const i = ZONE_ORDER.indexOf(RANK_ALIAS[z0] || z0); return i < 0 ? 99 : i; };
function splitRoutes(stops, fixed) {
  // fixed = записан план от собственика: групираме по името на маршрута, в реда на появата, без смесване.
  if (fixed) {
    const out = [];
    for (const s of stops) { let g = out.find(x => x.zone === s.zone); if (!g) { g = { zone: s.zone, zones: [s.zone], stops: [] }; out.push(g); } g.stops.push(s); }
    return out;
  }
  const byZone = [];
  for (const s of stops) {
    const z = s.zone || "Маршрут";
    let g = byZone.find(x => x.zone === z);
    if (!g) { g = { zone: z, zones: [z], stops: [] }; byZone.push(g); }
    g.stops.push(s);
  }
  const out = [];
  const families = [...new Set(byZone.map(g => FAMILY[g.zone] || g.zone))];
  for (const fam of families) {
    const members = byZone.filter(g => (FAMILY[g.zone] || g.zone) === fam);
    const total = members.reduce((n, g) => n + g.stops.length, 0);
    if (members.length === 1) { out.push(members[0]); continue; }
    const all = members.flatMap(g => g.stops).sort((a, b) => routeIdx(a) - routeIdx(b));
    if (total <= FAMILY_ONE_ROUTE_MAX) { out.push({ zone: fam, zones: members.map(g => g.zone), stops: all }); continue; }
    // Пълен ден: ако зоните са пълни (всяка ≥ MIN_PER_ZONE) — по зони (Запад / Център); иначе (напр.
    // СиБиЕс Запад само 2) — на равни части по реда на собственика (той е и географски: запад → изток).
    if (members.every(g => g.stops.length >= MIN_PER_ZONE)) { out.push(...members); continue; }
    const k = Math.ceil(total / FAMILY_ONE_ROUTE_MAX), size = Math.ceil(total / k);
    for (let i = 0; i < k; i++) {
      const part = all.slice(i * size, (i + 1) * size);
      const name = (fam === "СиБиЕс" && k === 2) ? (i === 0 ? "СиБиЕс Запад" : "СиБиЕс Изток") : `${fam} ${i + 1}/${k}`;
      out.push({ zone: name, zones: members.map(g => g.zone), stops: part, order: rank(members[0].zone) + i / 10 });
    }
  }
  for (const g of out) g.stops.sort((a, b) => routeIdx(a) - routeIdx(b));
  return out.sort((a, b) => (a.order != null ? a.order : rank(a.zone)) - (b.order != null ? b.order : rank(b.zone)));
}
// Разстояние в метри (хаверсинус).
function distM(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLa = r(b.lat - a.lat), dLo = r(b.lng - a.lng);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
module.exports = { ROUTE, stopKey, mapsLinks, distM, wazeLink, googleLink, splitRoutes };
