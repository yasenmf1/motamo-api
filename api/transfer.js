// api/transfer.js — ПРЕХВЪРЛЯНЕ ЦЕХ → ТОЧКА (Фаза 1).
//
// Защо: стоките се заприходяват САМО в цеха (`motamo.barsy.online`). Точката
// (Каравелов, `motamoshop.barsy.online`) е ОТДЕЛЕН Barsy акаунт, който СЛЕДИ
// наличност и вади по рецепта при всяка продажба → без зареждане тя върви на
// минус. За БАБХ всяко движение иска ДОКУМЕНТ.
//
// Потокът (Фаза 1):
//   1. Точката отваря `?view=shop&k=<token>` → 35-те продукта с ТЕКУЩАТА си
//      наличност, въвежда количества → ЗАЯВКА (Supabase `transfer_requests`).
//   2. Цехът отваря `?view=cex&k=<token>` → вижда чакащите заявки, преглежда,
//      натиска „Изпълни" → 2 документа (цех goods-out + шоп goods-in).
//
// Двата документа (цехът и точката са ЕДНА фирма, затова това НЕ е продажба —
// продажбен документ би надул оборота и ДДС):
//   1) ЦЕХ  — прехвърляне Основен(1) → Точка(2), `Storemoves_save`. Документът
//      за БАБХ. Редът иска партида във формат „партида(количество)" (FIFO).
//   2) ТОЧКА — зареждане в `motamoshop` от доставчик „Мотамо - цех",
//      `Storeloads_save`, по мапнатите id-та и по себестойност от цеха.
// „Преглед" сглобява без да пише; „Издай документите" записва (`dry:false`).

const CEX_API = "https://motamo.barsy.online";
const SHOP_API = "https://motamoshop.barsy.online";
const BID = 1;
const TIMEOUT_MS = 9000;

// ── Supabase (същият проект като кухненския snapshot) ────────────────────────
const SB_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0emd4cmVvamZ2ZGx0YmF2bG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjIxNzksImV4cCI6MjEwMTgzODE3OX0.o4i60i2Q9eCEhEOjw8OLmNqAkXVXpnqYYvx9_9BrkPs";
const SB_TABLE = "transfer_requests";
const sbHeaders = () => ({ apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" });

// ── ★ ЗАКЛЮЧЕН МАПИНГ ЦЕХ_ID → ТОЧКА_ID (35 артикула) ────────────────────────
// Двата Barsy-а ползват РАЗЛИЧНИ id-та за един и същ продукт → мапингът е
// фиксирана таблица (решение на собственика — по-сигурно от съвпадение по име).
// Ръчни съответствия (имената се разминават): 165 Тон филе→307 „Риба Тон";
// 85 Уасаби прах→319 „Уасаби Кинджируши"; 166 Сладък чили→298 „Сос Дракон"
// (точката прави драгон соса от чили-базата); 167 Сусамо олио-люто→149
// „Сусамово олио" (потвърдено от собственика 24.09.2026).
const MAP = {
  29: 124, 36: 112, 38: 154, 39: 140, 44: 133, 51: 99, 52: 98, 53: 159,
  54: 163, 56: 111, 59: 283, 60: 147, 61: 155, 64: 135, 65: 289, 67: 287,
  68: 288, 85: 319, 86: 104, 87: 156, 91: 103, 94: 115, 97: 122, 98: 148,
  103: 100, 104: 138, 123: 136, 127: 130, 131: 290, 144: 118, 146: 294,
  148: 151, 165: 307, 166: 298, 167: 149,
  // ★ 24.09: точката ползва ДВА вида соев сос — наливен (39→140) И пакетче
  // 10 мл (145 „Соев сос 10 мл" → 141 „Соев сос САШЕ", беше на −1162).
  145: 141
};
// ★ ОПАКОВКИ. Някои артикули се водят в кг/литри, но в точката се БРОЯТ на
// опаковки (Маки Еби скаридите идват в тарелки по 180 г). Момичетата пишат
// „2 тарелки", а не „0.36 кг" — полето е в опаковки, а в заявката и в
// документите влиза винаги базовата единица, за да не се разминава със склада.
// `size` = колко базови единици е ЕДНА опаковка.
const PACK = {
  51: { name: "тарелка", plural: "тарелки", size: 0.18 } // Бланширани скариди Маки Еби
};

// Кратка бележка до името — само за да знаят момичетата в какво идва продуктът.
// За разлика от PACK тук НЕ се променя единицата за въвеждане: полето си остава
// в кг/л, а текстът само подсказва (собственикът: „сложи го като описание").
const HINT = {
  86: "пакет 500 г",              // Едамаме зърна
  64: "1 кг = 40 бр × 25 г"       // Пържена скарида Торпедо
};

// Ред на показване в листа — заготовките първо, после суровините в реда, който
// собственикът подаде (24.09, по неговия лист): върви по вида продукт, както се
// обикаля хладилникът, а не по азбука или по id. Каквото не е в списъка му, пада
// накрая — така новият артикул се вижда, вместо да изчезне.
const ZAG = [59, 67, 68, 65, 131];
const RAW_ORDER = [
  36,  // Крема сирене
  52,  // Авокадо
  56,  // Краставици
  86,  // Едамаме зърна
  87,  // Уакаме
  127, // Пиле Панирано
  44,  // Пушена сьомга
  51,  // Бланширани скариди Маки Еби
  64,  // Пържена скарида Торпедо
  148, // Сьомга Сурова
  165, // Тон филе - охладено
  123, // Сладка Царевица
  60,  // Сурими/рулца от раци
  144, // Манго кубчета
  53,  // Унаги сос
  54,  // Хайвер масаго червен
  103, // Джинджифил маринов
  98,  // Сусам бял, печен 1
  29,  // Олио
  146, // Фурикаке Микс Мотамо
  97,  // Нори 1/2 половин лист
  167, // Сусамо олио-люто
  91,  // ДЪРВЕНИ Пръчици
  166  // Сладък чили сос → в точката „Сос Дракон"
];
const ORDERED = ZAG
  .concat(RAW_ORDER.filter(id => MAP[id]))
  .concat(Object.keys(MAP).map(Number).filter(id => !ZAG.includes(id) && !RAW_ORDER.includes(id)));

function withTimeout(run) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  return Promise.resolve(run(c.signal)).finally(() => clearTimeout(t));
}
function barsyCall(base, action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${base}/endpoints/json/${action}?bid=${BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
const cexCall = (a, p) => barsyCall(CEX_API, a, p, process.env.BARSY_CEX_USER, process.env.BARSY_CEX_PASS);
const shopCall = (a, p) => barsyCall(SHOP_API, a, p, process.env.BARSY_USER, process.env.BARSY_PASS);

// Недокументираните записващи методи на Barsy се пращат на /endpoints/json (БЕЗ
// действие в пътя), с тяло обвито под ключа на метода — както Storeproductions_save
// и Invoices_create в `cex-plan.js`. Същият канал зарежда и ФОРМИТЕ (…_edit), от
// които се четат очакваните полета.
function callRoot(base, bodyObj, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${base}/endpoints/json?bid=${BID}`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(bodyObj || {}), signal
    });
    const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data: d, raw: text };
  });
}
const cexRoot = (b) => callRoot(CEX_API, b, process.env.BARSY_CEX_USER, process.env.BARSY_CEX_PASS);
const shopRoot = (b) => callRoot(SHOP_API, b, process.env.BARSY_USER, process.env.BARSY_PASS);

// Обхожда формата и събира полетата (name→value); обект-стойност се разгъва.
function formValues(node) {
  const values = {};
  (function walk(n) {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.name === "string" && Object.prototype.hasOwnProperty.call(n, "value")) {
      const v = n.value;
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(values, v);
      else if (!(n.name in values) || values[n.name] == null) values[n.name] = v;
    }
    for (const k in n) if (k !== "data_source" && k !== "elements") walk(n[k]);
  })(node);
  return values;
}

function sofiaToday() {
  const f = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date());
}
function artList(r) {
  const d = (r && r.data) || {};
  let L = d.list || d.data || d;
  if (!Array.isArray(L)) L = (L && typeof L === "object") ? Object.values(L) : [];
  return L.filter(x => x && typeof x === "object" && x.article_id != null);
}

// ── Артикулите за листа: име/мярка от ЦЕХА (той е източникът), наличност от
// ТОЧКАТА (по мапнатото id) + наличност в цеха (има ли изобщо какво да даде).
async function buildList() {
  const [cr, sr] = await Promise.all([
    cexCall("Articles_getlistobject", { extra_properties: ["store_amount"] }),
    shopCall("Articles_getlistobject", { extra_properties: ["store_amount"] })
  ]);
  const cex = {}, shop = {};
  for (const a of artList(cr)) cex[Number(a.article_id)] = a;
  for (const a of artList(sr)) shop[Number(a.article_id)] = a;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return ORDERED.map(id => {
    const c = cex[id] || {}, sid = MAP[id], s = shop[sid] || {};
    return {
      cex_id: id, shop_id: sid,
      name: c.article_name || s.article_name || ("#" + id),
      shop_name: s.article_name || null,
      unit: c.amount_type_name_short || s.amount_type_name_short || "бр",
      shop_stock: num(s.store_amount),
      cex_stock: num(c.store_amount),
      pack: PACK[id] || null,
      hint: HINT[id] || null,
      missing: !cex[id] ? "цех" : (!shop[sid] ? "точка" : null)
    };
  });
}

// ── Supabase helpers ─────────────────────────────────────────────────────────
async function sbInsert(row) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}`, {
      method: "POST", headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify([row]), signal
    });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, row: Array.isArray(d) ? d[0] : null, raw: r.ok ? "" : t.slice(0, 300) };
  });
}
async function sbSelect(qs) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?${qs}`, { headers: sbHeaders(), signal });
    return r.ok ? await r.json() : [];
  });
}
// Атомичен преход на статус: PATCH … WHERE id=… AND status=<from>. Върне 0 реда
// → някой друг вече е взел заявката (двойно натискане) → не правим нищо.
async function sbClaim(id, from, patch) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?id=eq.${encodeURIComponent(id)}&status=eq.${from}`, {
      method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }), signal
    });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
    return { ok: r.ok && Array.isArray(d) && d.length > 0, row: Array.isArray(d) ? d[0] : null, raw: r.ok ? "" : t.slice(0, 300) };
  });
}
async function sbPatch(id, patch) {
  return withTimeout(async (signal) => {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }), signal
    });
    const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
    return { ok: r.ok, row: Array.isArray(d) ? d[0] : null, raw: r.ok ? "" : t.slice(0, 300) };
  });
}


// ── СКЛАДОВО ТАБЛО ───────────────────────────────────────────────────────────
// Кой доставчик носи коя суровина — изведено от редовете на 103 фактури (юни–
// септември 2026); взет е този, който я е носил най-често.
const SUPPLIER = {
  26:"FOODEX", 27:"БРАДЪРС", 28:"БРАДЪРС", 29:"БРАДЪРС", 30:"FOODEX", 31:"ФИШ",
  36:"БРАДЪРС", 37:"БРАДЪРС", 39:"FOODEX", 40:"МЕТРО", 42:"МЕТРО", 44:"АЛЕКС",
  49:"АЛЕКС", 50:"ФИШ", 51:"ФИШ", 52:"АЙСБОКС", 53:"ФИШ", 54:"ФИШ",
  56:"Анонимен", 58:"АЛЕКС", 60:"ФИШ", 61:"ФИШ", 64:"ФИШ", 84:"FOODEX",
  85:"FOODEX", 86:"ФИШ", 87:"ФИШ", 88:"FOODEX", 89:"FOODEX", 90:"FOODEX",
  91:"FOODEX", 92:"FOODEX", 93:"FOODEX", 97:"ФИШ", 98:"ФИШ", 103:"FOODEX",
  110:"FOODEX", 120:"МЕТРО", 121:"МЕТРО", 123:"АЙСБОКС", 125:"Анонимен", 127:"БРАДЪРС",
  144:"АЙСБОКС", 145:"FOODEX", 146:"Анонимен", 148:"ФИШ", 149:"FOODEX", 150:"FOODEX",
  151:"FOODEX", 152:"FOODEX", 153:"FOODEX", 154:"FOODEX", 155:"FOODEX", 156:"FOODEX",
  157:"FOODEX", 158:"FOODEX", 159:"FOODEX", 160:"FOODEX", 161:"FOODEX", 162:"FOODEX",
  163:"FOODEX", 164:"FOODEX", 165:"ФИШ", 166:"АЛЕКС", 167:"АЛЕКС"
};

// Графикът, по който идват.  са дните от седмицата (1=пон … 6=съб);
// доставчик без график се чака  дни (Foodex е внос).
const DELIVERY = {
  "БРАДЪРС":  { n: "Брадърс",        d: [1,2,3,4,5,6] },
  "ФИШ":      { n: "Фиш Експрес",    d: [2,5] },
  "АЛЕКС":    { n: "Алекс Фиш",      d: [1,4] },
  "АЙСБОКС":  { n: "Айсбокс",        d: [3] },
  "МЕТРО":    { n: "Метро",          d: [1,2,3,4,5,6] },
  "FOODEX":   { n: "Foodex (внос)",  d: null, lead: 21 },
  "СИБИЕС":   { n: "Сибиес",         d: [1,2,3,4,5,6] },
  "КЕРАНОВ":  { n: "Керанов",        d: [1,2,3,4,5,6] },
  "ЕМИ":      { n: "Еми Фрут",       d: [1,2,3,4,5,6] },
  "Тони":     { n: "Тони 93",        d: null, lead: 7 },
  "Анонимен": { n: "на място",       d: [1,2,3,4,5,6] }
};
const CEXDATA = require("../lib/_cexdata.js");

// Дни до следващата доставка от този доставчик (0 не се връща — днешният ден е
// изпуснат). Доставчик без седмичен график чака фиксиран срок.
function daysToDelivery(key, from) {
  const s = DELIVERY[key];
  if (!s) return 3;
  if (!s.d) return s.lead || 14;
  const dow = from.getDay();
  for (let i = 1; i <= 7; i++) if (s.d.includes((dow + i) % 7)) return i;
  return 7;
}

// Разходът се смята от РЕАЛНИТЕ производства, разгънати по рецепта — същият
// метод, който одитът на 22.09 свери срещу реално изписаното. Анулираните
// производства не влизат. Две скорости: 7 дни (какво става сега) и 28 дни
// (стабилната база); покритието е по по-бързата, защото е по-скъпо да закъснееш.
async function stockReport() {
  const [ar, pr] = await Promise.all([
    cexCall("Articles_getlistobject", { extra_properties: ["store_amount", "avg_delivery_price"] }),
    cexCall("Storeproductions_getlist", { filters: {}, extra_properties: ["all", "details"], length: 5000, limit: 5000 })
  ]);
  const A = {}; for (const a of artList(ar)) A[Number(a.article_id)] = a;
  let P = (pr && pr.data) || [];
  if (!Array.isArray(P)) P = P && typeof P === "object" ? Object.values(P) : [];

  const now = new Date();
  const d7 = new Date(now - 7 * 864e5), d28 = new Date(now - 28 * 864e5);
  const u7 = {}, u28 = {}; let prods = 0, annulled = 0; const days = new Set();
  for (const p of P) {
    if (Number(p.anulate_flag)) { annulled++; continue; }
    const raw = String(p.doc_date || p.date || "").replace(" ", "T");
    const dt = new Date(raw);
    if (isNaN(dt) || dt < d28) continue;
    prods++; days.add(raw.slice(0, 10));
    for (const it of (p.details || [])) {
      const rec = CEXDATA.articles[String(it.article_id)];
      if (!rec || !rec.components) continue;
      for (const c of rec.components) {
        const q = Number(c.qty) * Number(it.amount);
        if (!(q > 0)) continue;
        u28[c.id] = (u28[c.id] || 0) + q;
        if (dt >= d7) u7[c.id] = (u7[c.id] || 0) + q;
      }
    }
  }

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const raw = [], made = [];
  for (const key of Object.keys(u28)) {
    const id = Number(key), a = A[id] || {}, rec = CEXDATA.articles[key] || {};
    const cat = rec.cat || "";
    const v28 = u28[id] / 28, v7 = (u7[id] || 0) / 7, v = Math.max(v28, v7);
    const stock = num(a.store_amount), cost = num(a.avg_delivery_price);
    const base = {
      id, n: rec.name || a.article_name || ("#" + id), u: a.amount_type_name_short || "",
      s: r3(stock), v7: r3(v7), v28: r3(v28), c: v > 0 ? Math.round(stock / v * 10) / 10 : null,
      val: Math.round(stock * cost)
    };
    if (cat === "Суровини" || cat === "Консумативи") {
      const k = SUPPLIER[id] || null;
      raw.push({ ...base, sup: k ? (DELIVERY[k] || {}).n || k : "—", lead: k ? daysToDelivery(k, now) : 3 });
    } else if (cat === "Заготовки" || cat === "МЕНЮ") {
      made.push({ n: base.n, u: base.u, s: base.s, v: Math.round(v * 100) / 100, c: base.c });
    }
  }

  // Наличност без НИТО грам разход за 28 дни: или наистина стои, или се движи
  // извън рецептите. Тези, които се прехвърлят в точката, се отделят — там
  // разходът им е реален, просто не минава през цехово производство.
  const moving = new Set(Object.keys(u28).map(Number));
  const toPoint = [], rest = [];
  for (const a of artList(ar)) {
    const id = Number(a.article_id), rec = CEXDATA.articles[String(id)] || {};
    if (rec.cat !== "Суровини" && rec.cat !== "Консумативи") continue;
    if (moving.has(id)) continue;
    const stock = num(a.store_amount);
    if (stock <= 0) continue;
    const row = { n: rec.name || a.article_name, s: r3(stock), u: a.amount_type_name_short || "", val: Math.round(stock * num(a.avg_delivery_price)) };
    (MAP[id] ? toPoint : rest).push(row);
  }
  const byVal = (x, y) => y.val - x.val;
  toPoint.sort(byVal); rest.sort(byVal);

  return { for_date: sofiaToday(), prods, annulled, work_days: days.size, raw, made, toPoint, rest };
}

// ── ПАРТИДИ ──────────────────────────────────────────────────────────────────
// Прехвърлянето в цеха иска партида на реда, във формата „партида(количество)"
// (виж ръчното прехвърляне №2). Партидите с наличност се четат от
// `Lots_GetListAvailability` — същия източник, който UI-ят ползва за полето.
// Артикулите БЕЗ следене на партида (заготовките) просто не връщат редове →
// редът минава с празно `lot_value`.
const CEX_DEPOT_FROM = 1;   // Основен
const CEX_DEPOT_TO = 2;     // Точка
const SHOP_DEPOT = 1;       // Основен (точката има само един)
const SHOP_SUPPLIER_ID = 4; // „Мотамо - цех" (вече заведен от собственика)

async function lotsByArticle(ids) {
  const out = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 8) chunks.push(ids.slice(i, i + 8));
  for (const ch of chunks) {
    const rs = await Promise.all(ch.map(id =>
      cexRoot({ Lots_GetListAvailability: { filters: { has_amount_real_or_reserved: 1, article_id: id }, params: { bid: BID, article_id: id } } })
        .then(r => ({ id, rows: (r.data && r.data.Lots_GetListAvailability) || [] }))
        .catch(() => ({ id, rows: [] }))
    ));
    for (const r of rs) {
      // само партидите в склада, от който даваме, и само с реална наличност
      out[r.id] = (Array.isArray(r.rows) ? r.rows : [])
        .filter(x => Number(x.depot_id) === CEX_DEPOT_FROM && Number(x.amount_real) > 0)
        // FIFO: първо изтичащите, после по номер на партида
        .sort((a, b) => String(a.lot_exp_date || "9999").localeCompare(String(b.lot_exp_date || "9999"))
          || String(a.lot_value).localeCompare(String(b.lot_value)));
    }
  }
  return out;
}

// Разпределя исканото количество по партиди (FIFO) → по ЕДИН ред на партида,
// както прави и ръчното прехвърляне. Без партиди → един ред с празно lot_value.
//
// ⚠ `lot_value` при ЗАПИС е САМО номерът на партидата („04032026"). Видът
// „партида(количество)", с който Barsy ВРЪЩА реда при четене, е форматиране за
// екрана — подаден обратно при запис дава „не съществува партида
// „04032026(0.0095)"" (пада и с точната стойност, значи не е закръгляване).
// Количеството си живее в `amount`. Полето е autocomplete към
// `Lots_GetListAvailability` с field_key `lot_value` — пак самият номер.
function allocate(qty, lots) {
  if (!lots || !lots.length) return { rows: [{ lot_value: "", amount: fmtQty(qty) }], short: 0 };
  const rows = []; let left = Number(qty);
  for (const l of lots) {
    if (left <= 1e-9) break;
    const real = Number(l.amount_real);
    const take = left >= real ? real : left; // цялата партида → точната ѝ стойност
    if (take <= 1e-9) continue;
    rows.push({ lot_value: String(l.lot_value), amount: fmtQty(take), lot_exp: l.lot_exp_date || null });
    left = Number((left - take).toFixed(9));
  }
  return { rows, short: round3(Math.max(0, left)) };
}
const round3 = (n) => Math.round(Number(n) * 1000) / 1000;
// Число за Barsy: без научна нотация, без влачещи нули, без закръгляне нагоре.
function fmtQty(n) {
  const s = Number(n).toFixed(9);
  return s.indexOf(".") < 0 ? s : s.replace(/0+$/, "").replace(/\.$/, "");
}

// ── СТРАНИЦИ ─────────────────────────────────────────────────────────────────
// Фирменият вид на MOTAMO: червеното слънце (#FF0000 / #CC0000), мастилено
// #111, мача зелено за „готово", дърво за акценти; шрифтове Unbounded (заглавия)
// и Manrope (текст) — същите като на motamo.bg. Светла и тъмна тема според
// настройката на телефона (решение на собственика).
// Хоризонталното лого на MOTAMO — същият SVG, който стои и на motamo.bg
// (изваден от вградения там base64). Бялото е сменено с `currentColor`, за да
// работи и на светъл, и на тъмен фон.
const LOGO = `<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 409.6 110.1" style="enable-background:new 0 0 409.6 110.1;" xml:space="preserve"> <style type="text/css"> .st0{fill:currentColor;} .st1{fill:#E30613;} </style> <g> <path class="st0" d="M124.4,81.1c-0.4-0.4-0.8-0.7-1.3-1c-0.5-0.3-1-0.5-1.6-0.8c-0.8-0.3-1.4-0.5-1.9-0.7 c-0.5-0.2-0.9-0.5-1.2-0.8c-0.3-0.3-0.4-0.6-0.4-1c0-0.4,0.1-0.7,0.4-0.9c0.3-0.2,0.7-0.4,1.3-0.4c0.4,0,0.8,0.1,1.2,0.2 c0.4,0.2,0.7,0.4,1,0.7c0.3,0.3,0.6,0.6,0.8,1l3-1.7c-0.3-0.6-0.7-1.1-1.2-1.6c-0.5-0.5-1.2-1-2-1.3c-0.8-0.4-1.7-0.5-2.8-0.5 c-1.1,0-2,0.2-2.9,0.5c-0.9,0.4-1.5,0.9-2,1.6c-0.5,0.7-0.8,1.5-0.8,2.5c0,0.8,0.1,1.5,0.4,2.1c0.3,0.6,0.7,1,1.1,1.4 c0.4,0.4,0.9,0.7,1.4,1c0.5,0.2,0.9,0.4,1.3,0.6c0.8,0.3,1.4,0.6,1.9,0.8c0.5,0.2,0.8,0.5,1,0.7c0.2,0.3,0.3,0.6,0.3,1 c0,0.5-0.2,0.9-0.6,1.2c-0.4,0.3-0.8,0.4-1.4,0.4c-0.5,0-1.1-0.1-1.5-0.3c-0.5-0.2-0.9-0.6-1.3-1c-0.4-0.4-0.8-0.9-1.1-1.5l-2.7,2 c0.4,0.8,0.9,1.5,1.6,2.1c0.7,0.6,1.5,1.2,2.4,1.5c0.9,0.4,1.9,0.6,2.9,0.6c0.8,0,1.5-0.1,2.2-0.3c0.7-0.2,1.4-0.6,1.9-1 c0.6-0.4,1-1,1.3-1.6c0.3-0.6,0.5-1.4,0.5-2.2c0-0.7-0.1-1.3-0.3-1.8C125.1,82,124.8,81.5,124.4,81.1z"/> <path class="st0" d="M137.3,83.3c0,0.8-0.2,1.5-0.6,2c-0.4,0.5-1.1,0.8-2,0.8c-0.9,0-1.5-0.3-1.9-0.8c-0.4-0.5-0.6-1.2-0.6-2V72.7 h-3.9v10.9c0,1,0.2,1.9,0.5,2.7c0.3,0.8,0.8,1.4,1.4,1.9c0.6,0.5,1.3,0.9,2.1,1.1c0.8,0.2,1.6,0.4,2.6,0.4c0.9,0,1.8-0.1,2.6-0.4 c0.8-0.2,1.5-0.6,2.1-1.1c0.6-0.5,1.1-1.1,1.4-1.9c0.3-0.8,0.5-1.6,0.5-2.7V72.7h-3.9V83.3z"/> <path class="st0" d="M155.2,81.1c-0.4-0.4-0.8-0.7-1.3-1c-0.5-0.3-1-0.5-1.6-0.8c-0.8-0.3-1.4-0.5-1.9-0.7 c-0.5-0.2-0.9-0.5-1.2-0.8c-0.3-0.3-0.4-0.6-0.4-1c0-0.4,0.1-0.7,0.4-0.9c0.3-0.2,0.7-0.4,1.3-0.4c0.4,0,0.8,0.1,1.2,0.2 c0.4,0.2,0.7,0.4,1,0.7c0.3,0.3,0.6,0.6,0.8,1l3-1.7c-0.3-0.6-0.7-1.1-1.2-1.6c-0.5-0.5-1.2-1-2-1.3c-0.8-0.4-1.7-0.5-2.8-0.5 c-1.1,0-2,0.2-2.9,0.5c-0.9,0.4-1.5,0.9-2,1.6c-0.5,0.7-0.8,1.5-0.8,2.5c0,0.8,0.1,1.5,0.4,2.1c0.3,0.6,0.7,1,1.1,1.4 c0.4,0.4,0.9,0.7,1.4,1c0.5,0.2,0.9,0.4,1.3,0.6c0.8,0.3,1.4,0.6,1.9,0.8c0.5,0.2,0.8,0.5,1,0.7c0.2,0.3,0.3,0.6,0.3,1 c0,0.5-0.2,0.9-0.6,1.2c-0.4,0.3-0.8,0.4-1.4,0.4c-0.5,0-1.1-0.1-1.5-0.3c-0.5-0.2-0.9-0.6-1.3-1c-0.4-0.4-0.8-0.9-1.1-1.5l-2.7,2 c0.4,0.8,0.9,1.5,1.6,2.1c0.7,0.6,1.5,1.2,2.4,1.5c0.9,0.4,1.9,0.6,2.9,0.6c0.8,0,1.5-0.1,2.2-0.3c0.7-0.2,1.4-0.6,1.9-1 c0.6-0.4,1-1,1.3-1.6c0.3-0.6,0.5-1.4,0.5-2.2c0-0.7-0.1-1.3-0.3-1.8C155.8,82,155.5,81.5,155.2,81.1z"/> <polygon class="st0" points="169.9,78.6 162.9,78.6 162.9,72.7 159,72.7 159,88.9 162.9,88.9 162.9,82.1 169.9,82.1 169.9,88.9 173.8,88.9 173.8,72.7 169.9,72.7 "/> <rect x="177.3" y="72.7" class="st0" width="4" height="16.2"/> <path class="st0" d="M204.6,85.1c0.7-0.8,1.3-1.5,1.8-2.2L204,81c-0.5,0.7-1,1.4-1.5,2c-0.2,0.2-0.3,0.4-0.5,0.5l-2.9-3.1 c0.4-0.3,0.7-0.5,1.1-0.7c0.5-0.3,0.9-0.7,1.3-1c0.3-0.3,0.6-0.7,0.8-1.1c0.2-0.4,0.3-0.9,0.3-1.4c0-0.6-0.2-1.3-0.5-1.9 c-0.4-0.6-0.9-1.1-1.6-1.5c-0.7-0.4-1.6-0.6-2.6-0.6s-1.9,0.2-2.7,0.6c-0.8,0.4-1.3,0.9-1.7,1.5c-0.4,0.6-0.6,1.3-0.6,1.9 c0,0.6,0.1,1.1,0.3,1.5c0.2,0.4,0.5,0.9,0.9,1.3c0.2,0.3,0.5,0.6,0.8,0.9c-0.3,0.1-0.6,0.3-0.9,0.4c-0.5,0.3-1,0.6-1.5,1 c-0.5,0.4-0.8,0.8-1.1,1.4c-0.3,0.5-0.4,1.2-0.4,1.9c0,1,0.3,1.8,0.8,2.5c0.5,0.7,1.2,1.2,2.1,1.6c0.9,0.4,1.8,0.6,2.8,0.6 c1.1,0,2.2-0.2,3.2-0.6c0.7-0.3,1.4-0.6,2.1-1.1l1.2,1.3h4l-3-3.2C204.2,85.5,204.4,85.3,204.6,85.1z M196.6,75.5 c0.3-0.3,0.7-0.5,1.2-0.5c0.3,0,0.6,0.1,0.8,0.2c0.2,0.1,0.4,0.3,0.5,0.5c0.1,0.2,0.2,0.4,0.2,0.7c0,0.4-0.2,0.9-0.7,1.3 c-0.3,0.3-0.7,0.6-1.1,0.9c-0.3-0.3-0.5-0.6-0.7-0.8c-0.4-0.5-0.6-0.9-0.6-1.4C196.2,76.2,196.4,75.8,196.6,75.5z M198.9,85.9 c-0.6,0.3-1.3,0.4-2,0.4c-0.5,0-1-0.1-1.3-0.3c-0.4-0.2-0.6-0.4-0.8-0.7c-0.2-0.3-0.3-0.6-0.3-1c0-0.5,0.1-0.9,0.4-1.2 c0.3-0.3,0.6-0.6,1-0.8c0.2-0.1,0.4-0.2,0.7-0.4l3.2,3.5C199.5,85.6,199.2,85.7,198.9,85.9z"/> <path class="st0" d="M225.2,73.3c-0.9-0.4-2.1-0.6-3.5-0.6H220h-1.5h-2.5v16.2h3.9v-5.6h1.7c1.4,0,2.5-0.2,3.5-0.6 c0.9-0.4,1.6-1,2.1-1.8c0.5-0.8,0.7-1.7,0.7-2.8c0-1.1-0.2-2.1-0.7-2.9C226.8,74.4,226.1,73.7,225.2,73.3z M223.6,79.5 c-0.4,0.4-1.1,0.5-1.9,0.5H220v-4.2h1.7c0.8,0,1.4,0.2,1.9,0.5c0.4,0.4,0.7,0.9,0.7,1.6C224.2,78.7,224,79.2,223.6,79.5z"/> <path class="st0" d="M244.6,74.7c-0.8-0.8-1.7-1.3-2.8-1.8c-1.1-0.4-2.2-0.6-3.5-0.6c-1.2,0-2.4,0.2-3.5,0.6c-1.1,0.4-2,1-2.8,1.8 c-0.8,0.8-1.4,1.7-1.8,2.7c-0.4,1-0.7,2.2-0.7,3.4c0,1.3,0.2,2.4,0.6,3.5c0.4,1.1,1,2,1.8,2.7c0.8,0.8,1.7,1.4,2.8,1.8 c1.1,0.4,2.2,0.6,3.5,0.6c1.3,0,2.4-0.2,3.5-0.6c1.1-0.4,2-1,2.8-1.8c0.8-0.8,1.4-1.7,1.8-2.7c0.4-1.1,0.6-2.2,0.6-3.5 c0-1.3-0.2-2.4-0.6-3.4C246,76.3,245.4,75.4,244.6,74.7z M242.3,83.4c-0.4,0.7-0.9,1.3-1.6,1.7c-0.7,0.4-1.5,0.6-2.4,0.6 c-0.9,0-1.7-0.2-2.4-0.6c-0.7-0.4-1.2-1-1.6-1.7c-0.4-0.7-0.6-1.6-0.6-2.5c0-1,0.2-1.8,0.6-2.5c0.4-0.7,0.9-1.3,1.6-1.7 c0.7-0.4,1.5-0.6,2.4-0.6c0.9,0,1.8,0.2,2.4,0.6c0.7,0.4,1.2,1,1.6,1.7c0.4,0.7,0.6,1.6,0.6,2.5C242.9,81.8,242.7,82.6,242.3,83.4z "/> <polygon class="st0" points="263.8,72.7 259.2,72.7 253.6,79.1 253.6,72.7 249.6,72.7 249.6,88.9 253.6,88.9 253.6,81.8 259.3,88.9 264.1,88.9 257.2,80.3 "/> <polygon class="st0" points="276.6,75.9 276.6,72.7 269.6,72.7 268.4,72.7 265.8,72.7 265.8,88.9 268.4,88.9 269.6,88.9 276.6,88.9 276.6,85.7 269.6,85.7 269.6,82 276.1,82 276.1,78.8 269.6,78.8 269.6,75.9 "/> </g> <g> <path class="st0" d="M143.6,41.9l-11.4,15.2L121,41.9v20.5h-9V24.1h7.1l13.1,19.2l13.3-19.2h7.1v38.3h-9V41.9z"/> </g> <g> <path class="st0" d="M185.1,63.5c-3.4,0-6.5-0.5-9.3-1.5c-2.8-1-5.2-2.5-7.2-4.3c-2-1.8-3.6-4-4.7-6.4c-1.1-2.5-1.7-5.1-1.7-8 c0-2.9,0.6-5.6,1.7-8c1.1-2.4,2.7-4.5,4.7-6.3c2-1.8,4.5-3.2,7.2-4.2c2.8-1,5.9-1.5,9.3-1.5c3.4,0,6.5,0.5,9.3,1.5 c2.8,1,5.3,2.4,7.3,4.1c2,1.8,3.6,3.9,4.7,6.3c1.1,2.5,1.7,5.2,1.7,8.1s-0.6,5.6-1.7,8.1c-1.1,2.5-2.7,4.6-4.7,6.4 c-2,1.8-4.5,3.2-7.3,4.2C191.6,63,188.5,63.5,185.1,63.5z M185.1,31.8c-2.1,0-4,0.3-5.7,0.9c-1.7,0.6-3.1,1.4-4.2,2.5 c-1.1,1.1-2,2.3-2.6,3.6c-0.6,1.4-0.9,2.8-0.9,4.3c0,1.6,0.3,3.1,0.9,4.5c0.6,1.4,1.5,2.6,2.6,3.7c1.1,1.1,2.5,1.9,4.2,2.5 c1.7,0.6,3.6,0.9,5.7,0.9c2.2,0,4.1-0.3,5.8-1c1.7-0.6,3.1-1.5,4.2-2.5c1.1-1,2-2.2,2.6-3.6c0.6-1.4,0.9-2.9,0.9-4.5 c0-1.5-0.3-3-0.9-4.3c-0.6-1.4-1.5-2.6-2.6-3.6c-1.2-1-2.6-1.9-4.2-2.5C189.1,32.1,187.2,31.8,185.1,31.8z"/> </g> <g> <path class="st0" d="M330.5,41.9l-11.4,15.2l-11.2-15.2v20.5h-9V24.1h7.1l13.1,19.2l13.3-19.2h7.1v38.3h-9V41.9z"/> </g> <g> <path class="st0" d="M371.9,63.5c-3.4,0-6.5-0.5-9.3-1.5c-2.8-1-5.2-2.5-7.2-4.3c-2-1.8-3.6-4-4.7-6.4c-1.1-2.5-1.7-5.1-1.7-8 c0-2.9,0.6-5.6,1.7-8c1.1-2.4,2.7-4.5,4.7-6.3c2-1.8,4.4-3.2,7.2-4.2c2.8-1,5.9-1.5,9.3-1.5c3.4,0,6.5,0.5,9.3,1.5 c2.8,1,5.2,2.4,7.3,4.1c2,1.8,3.6,3.9,4.7,6.3c1.1,2.5,1.7,5.1,1.7,8.1c0,2.9-0.6,5.6-1.7,8.1c-1.1,2.5-2.7,4.6-4.7,6.4 c-2,1.8-4.5,3.2-7.3,4.2C378.4,63,375.3,63.5,371.9,63.5z M371.9,31.8c-2.1,0-4,0.3-5.7,0.9c-1.7,0.6-3.1,1.4-4.2,2.5 c-1.1,1.1-2,2.3-2.6,3.6c-0.6,1.4-0.9,2.8-0.9,4.3c0,1.6,0.3,3.1,0.9,4.5c0.6,1.4,1.5,2.6,2.6,3.7c1.1,1.1,2.5,1.9,4.2,2.5 c1.7,0.6,3.6,0.9,5.7,0.9c2.2,0,4.1-0.3,5.8-1c1.7-0.6,3.1-1.5,4.2-2.5c1.1-1,2-2.2,2.6-3.6c0.6-1.4,0.9-2.9,0.9-4.5 c0-1.5-0.3-3-0.9-4.3c-0.6-1.4-1.5-2.6-2.6-3.6c-1.2-1-2.6-1.9-4.2-2.5C375.9,32.2,374,31.8,371.9,31.8z"/> </g> <g> <path class="st1" d="M185.1,36.4c-1.3,0-2.5,0.2-3.5,0.6c-1,0.4-1.9,0.9-2.6,1.5c-0.7,0.7-1.2,1.4-1.6,2.2 c-0.4,0.8-0.6,1.7-0.6,2.7c0,1,0.2,1.9,0.6,2.7c0.4,0.9,0.9,1.6,1.6,2.3c0.7,0.7,1.5,1.2,2.6,1.5c1,0.4,2.2,0.6,3.5,0.6 c1.3,0,2.5-0.2,3.5-0.6c1-0.4,1.9-0.9,2.6-1.5c0.7-0.6,1.2-1.4,1.6-2.2c0.4-0.9,0.6-1.8,0.6-2.7c0-0.9-0.2-1.8-0.6-2.7 c-0.4-0.8-0.9-1.6-1.6-2.2c-0.7-0.6-1.6-1.1-2.6-1.5C187.6,36.5,186.4,36.4,185.1,36.4z"/> </g> <g> <path class="st1" d="M371.9,36.4c-1.3,0-2.5,0.2-3.5,0.6c-1,0.4-1.9,0.9-2.6,1.5c-0.7,0.7-1.2,1.4-1.6,2.2 c-0.4,0.8-0.6,1.7-0.6,2.7c0,1,0.2,1.9,0.6,2.7c0.4,0.9,0.9,1.6,1.6,2.3c0.7,0.7,1.5,1.2,2.6,1.5c1,0.4,2.2,0.6,3.5,0.6 c1.3,0,2.5-0.2,3.5-0.6c1-0.4,1.9-0.9,2.6-1.5c0.7-0.6,1.2-1.4,1.6-2.2c0.4-0.9,0.6-1.8,0.6-2.7c0-0.9-0.2-1.8-0.6-2.7 c-0.4-0.8-0.9-1.6-1.6-2.2c-0.7-0.6-1.6-1.1-2.6-1.5C374.4,36.6,373.2,36.4,371.9,36.4z"/> </g> <g> <path class="st0" d="M235.3,62.4h-9.4V33h-14.5v-8.8h38.4V33h-14.5V62.4z"/> </g> <g> <path class="st0" d="M278.2,54.1h-16l-4.2,8.3h-10.3l19.6-38.3h5.8l19.7,38.3h-10.4L278.2,54.1z M266.1,46.4h8.2l-4.1-8.6 L266.1,46.4z"/> </g> <g> <path class="st0" d="M33.9,57.1l8.7,0c0-8.9,7.3-16.1,16.2-16s16.1,7.3,16,16.2l8.7,0c0.1-13.7-11-24.9-24.7-24.9 S34,43.4,33.9,57.1z"/> </g> <g> <path class="st0" d="M33.7,73c9.3,0,18.1-3.4,25-9.6c6.8,6.3,15.5,9.8,24.9,9.9l0-8.7c-7.5,0-14.5-3-19.7-8.3l-5.1-5.2l-5.2,5.1 c-5.3,5.3-12.4,8.1-19.8,8.1L33.7,73z"/> </g> <g> <path class="st0" d="M19.7,56c0.1-21.5,17.7-38.9,39.2-38.8s38.9,17.7,38.8,39.2l-0.2,31.5l-78-0.4L19.7,56z M89,56.3 C89.1,39.6,75.6,26,58.9,25.9C42.2,25.8,28.5,39.3,28.4,56l-0.1,22.8l60.6,0.3L89,56.3z"/> </g> </svg>`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;800&family=Unbounded:wght@600;700&display=swap" rel="stylesheet">`;

// Слагане на началния екран: с манифеста иконата се отваря като приложение — без
// адресна лента и без ключа пред очите. Ключът пътува в `start_url`, затова
// манифестът се генерира за всеки ключ поотделно.
const PWA = (k) => `<link rel="manifest" href="?view=manifest&k=${encodeURIComponent(k)}">
<link rel="apple-touch-icon" href="https://motamo.bg/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="MOTAMO Цех">
<meta name="theme-color" content="#FF0000">`;

function manifest(k, owner) {
  return {
    name: owner ? "MOTAMO Цех" : "Заявка към цеха",
    short_name: owner ? "Цех" : "Заявка",
    description: owner
      ? "Заявки от точката, складът на цеха, производство и стокови."
      : "Заявка към цеха — какво да донесат в точката.",
    start_url: "/api/transfer?k=" + encodeURIComponent(k) + (owner ? "" : "&view=shop"),
    scope: "/api/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FBF8F3",
    theme_color: "#FF0000",
    lang: "bg",
    icons: [
      { src: "https://motamo.bg/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "https://motamo.bg/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
    ],
    shortcuts: owner ? [
      { name: "Складът на цеха", url: "/api/transfer?view=stock&k=" + encodeURIComponent(k) },
      { name: "Заявки от точката", url: "/api/transfer?view=cex&k=" + encodeURIComponent(k) }
    ] : []
  };
}

const CSS = `
:root{
  --sun:#FF0000;--sun-deep:#CC0000;--wood:#C8A46A;--matcha:#2E7D53;
  --bg:#FAF8F5;--card:#FFFFFF;--line:#E6E1DA;--fg:#111111;--dim:#6B6B6B;
  --field:#FFFFFF;--zebra:#FBF9F6;--bar:#FFFFFF;--chip:#F1EDE7;
  --okbg:#E9F7EE;--okfg:#0E5A28;--errbg:#FDECEC;--errfg:#B3160E;
  --infbg:#FFF6E5;--inffg:#7A4E00;--veil:rgba(250,248,245,.92);
  --font-d:"Unbounded",system-ui,sans-serif;--font-b:"Manrope",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0E0F12;--card:#16181D;--line:#272A31;--fg:#F2F2F3;--dim:#9A9DA5;
  --field:#0A0B0E;--zebra:#131519;--bar:#16181D;--chip:#232730;
  --okbg:#0F2E1E;--okfg:#7EE2A8;--errbg:#33100F;--errfg:#FF8A80;
  --infbg:#2A2010;--inffg:#F0C889;--veil:rgba(10,11,14,.92);
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 var(--font-b)}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line);
  padding:10px 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;
  box-shadow:0 1px 0 rgba(0,0,0,.04)}
header .logo{height:26px;width:97px;flex:0 0 auto;color:var(--fg);display:block}
header .logo svg{height:100%;width:100%;display:block}
h1{font-family:var(--font-d);font-size:17px;margin:0;letter-spacing:-.01em;flex:1 1 auto}
h1 small{display:block;font-family:var(--font-b);font-size:12px;color:var(--dim);font-weight:400;letter-spacing:0;margin-top:2px}
.wrap{padding:12px 14px 96px;max-width:900px;margin:0 auto}
table{width:100%;border-collapse:collapse}
th,td{padding:11px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
tbody tr:nth-child(even) td,table tr:nth-child(even) td{background:var(--zebra)}
th{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;font-weight:800;background:transparent!important}
td{font-size:16px}
td.num,th.num{text-align:right;white-space:nowrap}
input[type=number]{width:96px;padding:10px;font-size:17px;font-family:var(--font-b);font-weight:600;
  border-radius:10px;border:1.5px solid var(--line);background:var(--field);color:var(--fg);text-align:right}
input[type=number]:focus{outline:none;border-color:var(--sun);box-shadow:0 0 0 3px rgba(255,0,0,.16)}
button{padding:11px 18px;border-radius:12px;border:0;font-family:var(--font-b);font-size:15px;font-weight:800;
  cursor:pointer;background:var(--sun);color:#fff;letter-spacing:.01em}
button:active{background:var(--sun-deep)}
button.ghost{background:var(--chip);color:var(--fg)}
button:disabled{opacity:.45;cursor:default}
.neg{color:var(--sun);font-weight:800}.zero{color:var(--dim)}
.msg{padding:11px 13px;border-radius:12px;margin:10px 0;font-size:14px;display:none;font-weight:600}
.msg.ok{display:block;background:var(--okbg);color:var(--okfg)}
.msg.err{display:block;background:var(--errbg);color:var(--errfg)}
.msg.info{display:block;background:var(--infbg);color:var(--inffg)}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--bar);border-top:1px solid var(--line);
  padding:10px 14px;display:flex;gap:10px;align-items:center;justify-content:space-between;
  box-shadow:0 -2px 12px rgba(0,0,0,.06)}
/* Заглавие на група — с червена чертичка, за да личи (беше почти невидимо). */
.grp{font-family:var(--font-d);font-size:12px;color:var(--fg);text-transform:uppercase;letter-spacing:.1em;
  padding:22px 0 6px!important;background:transparent!important;border-bottom:0!important}
.grp span{border-left:3px solid var(--sun);padding-left:9px;display:inline-block}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin:12px 0}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:800}
.pill.pending{background:var(--infbg);color:var(--inffg)}
.pill.done{background:var(--okbg);color:var(--okfg)}
.pill.partial{background:var(--infbg);color:var(--inffg)}
.pill.failed{background:var(--errbg);color:var(--errfg)}
.pill.processing{background:var(--chip);color:var(--dim)}
.pill.cancelled{background:var(--chip);color:var(--dim)}
.days{display:flex;gap:8px;overflow-x:auto;padding:4px 0 10px;-webkit-overflow-scrolling:touch}
.days button{flex:0 0 auto;background:var(--chip);color:var(--dim);font-weight:700;padding:9px 16px;border-radius:999px;font-size:14px}
.days button.on{background:var(--sun);color:#fff}
.days button .b{display:inline-block;margin-left:6px;background:#fff;color:var(--sun);border-radius:999px;padding:0 7px;font-size:11px;font-weight:800}
.days button:not(.on) .b{background:var(--sun);color:#fff}
.head{display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;flex-wrap:wrap}
.head .t{font-family:var(--font-d);font-size:16px}
.head .s{color:var(--dim);font-size:13px;font-weight:600}
.body{display:none;margin-top:10px}.open .body{display:block}
.head .caret{color:var(--dim);font-size:13px}
.docs{margin-top:10px;color:var(--dim);font-size:13px;border-top:1px dashed var(--line);padding-top:8px}
.sent{color:var(--matcha);font-weight:800}.cut{color:var(--sun);font-weight:800}
.tabs{display:flex;gap:6px}
.tabs button{background:var(--chip);color:var(--dim);padding:9px 15px;font-size:14px;font-weight:700}
.tabs button.on{background:var(--sun);color:#fff}
/* Докато Barsy работи (няколко секунди при много редове) целият екран се
   заключва — иначе се натиска пак и пак. */
#busy{position:fixed;inset:0;z-index:99;background:var(--veil);display:none;
  align-items:center;justify-content:center;flex-direction:column;gap:18px;padding:24px;text-align:center}
#busy.on{display:flex}
#busy .sp{width:56px;height:56px;border:5px solid var(--line);border-top-color:var(--sun);border-radius:50%;animation:spin .9s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#busy .tx{font-family:var(--font-d);font-size:19px}
#busy .sub{font-size:14px;color:var(--dim);max-width:320px;font-weight:600}
.pk{display:inline-block;background:var(--chip);color:var(--dim);border-radius:7px;padding:2px 7px;font-size:12px;margin-left:6px;white-space:nowrap;font-weight:700}
.conv{font-size:12px;color:var(--matcha);margin-top:4px;height:15px;font-weight:700}
.sub2{display:block;font-size:12px;color:var(--dim);font-weight:600;margin-top:2px}
/* Телефон: лентата долу трябва да остане НА ЕДИН ред — иначе изяжда екрана. */
@media (max-width:430px){
  .bar{padding:8px 10px;gap:8px}
  .bar button{padding:12px 14px;font-size:14px}
  .bar #cnt{font-size:12px;line-height:1.25}
  .hidesm{display:none}
  h1{font-size:14px}
  header{padding:9px 12px;gap:9px}
  header .logo{height:21px;width:78px}
  td{font-size:15px}
  th,td{padding:10px 6px}
  input[type=number]{width:84px;padding:9px}
}
`;

function shopPage(k) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Заявка към цеха</title>
${FONTS}${PWA(k)}<style>${CSS}${HUB_CSS}</style></head><body>
<header><span class="logo" role="img" aria-label="MOTAMO">${LOGO}</span>
<h1>Заявка към цеха<small>точка Каравелов · какво да донесат</small></h1>
<span class="tabs"><button id="t1" class="on" onclick="tab(1)">Нова заявка</button><button id="t2" onclick="tab(2)">История</button></span></header>
<div class="wrap">
  ${navBar(k, "shop")}
  <div id="msg" class="msg info">Зареждам наличностите…</div>
  <div id="p1"><table id="tbl"></table></div>
  <div id="p2" style="display:none"><div id="days" class="days"></div><div id="hist"></div></div>
</div>
<div class="bar" id="bar">
  <span id="cnt" style="color:var(--dim);font-size:14px">—</span>
  <span style="display:flex;gap:8px;align-items:center"><button class="ghost" onclick="reload()">↻<span class="hidesm"> Наличности</span></button>
  <button id="send" onclick="send()" disabled>Изпрати</button></span>
</div>
<div id="busy"><div class="sp"></div><div class="tx">Изпраща се…</div><div class="sub" id="busysub">Не натискай пак.</div></div>
<script>
var K=${JSON.stringify(k)},items=[],DRAFT='motamo-transfer-draft';
function $(i){return document.getElementById(i)}
function msg(t,c){var m=$('msg');m.className='msg '+(c||'info');m.textContent=t}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(b){return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:K},b))}).then(function(r){return r.json()})}
function draft(){try{return JSON.parse(localStorage.getItem(DRAFT)||'{}')}catch(e){return{}}}
function saveDraft(){var d={};document.querySelectorAll('input.q').forEach(function(i){if(i.value)d[i.dataset.id]=i.value});try{localStorage.setItem(DRAFT,JSON.stringify(d))}catch(e){}conv();count()}
function count(){var n=0;document.querySelectorAll('input.q').forEach(function(i){if(Number(i.value)>0)n++});$('cnt').textContent=n?(n+' продукта в заявката'):'нищо не е въведено';$('send').disabled=!n}
function render(){var d=draft(),h='<tr><th>Продукт</th><th class="num">Имам</th><th class="num">Искам</th></tr>',lastZ=null;
items.forEach(function(it){var z=it.zag?'Заготовки':'Суровини и други';if(z!==lastZ){lastZ=z;h+='<tr><td colspan="3" class="grp"><span>'+z+'</span></td></tr>'}
var st=it.shop_stock,cls=st<0?'neg':(st===0?'zero':''),p=it.pack;
var have=p?(Math.round(st/p.size*10)/10+' '+p.plural):(Math.round(st*1000)/1000+' '+esc(it.unit));
h+='<tr><td>'+esc(it.name)+(p?' <span class="pk">по '+esc(p.name)+' '+(p.size*1000)+' г</span>':'')+(it.hint?' <span class="pk">'+esc(it.hint)+'</span>':'')+(it.missing?' <span class="pk" style="color:var(--sun)">липсва в '+esc(it.missing)+'</span>':'')+'</td>'+
'<td class="num '+cls+'">'+have+'</td>'+
'<td class="num"><input class="q" type="number" min="0" step="any" inputmode="decimal" data-id="'+it.cex_id+'" data-size="'+(p?p.size:'')+'" value="'+(d[it.cex_id]||'')+'" oninput="saveDraft()">'+
(p?'<div class="conv" id="cv'+it.cex_id+'"></div>':'')+'</td></tr>'});
$('tbl').innerHTML=h;conv();count()}
/* Полето е в опаковки — под него се изписва колко прави в кг, за да няма съмнение. */
function conv(){items.forEach(function(it){if(!it.pack)return;var i=document.querySelector('input.q[data-id="'+it.cex_id+'"]'),e=$('cv'+it.cex_id);if(!i||!e)return;
var n=Number(i.value);e.textContent=n>0?('= '+(Math.round(n*it.pack.size*1000)/1000)+' '+it.unit):''})}
function reload(){msg('Зареждам наличностите…','info');api({action:'list'}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}items=j.items||[];render();msg('Наличности от точката \\u00b7 '+j.for_date+'. Червено = на минус. Въведи колко искаш и натисни „Изпрати".','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
/* Полето може да е в опаковки — тук се превръща в базовата единица, защото
   заявката и документите работят само с нея. */
function send(){var rows=[];document.querySelectorAll('input.q').forEach(function(i){var v=Number(i.value);if(!(v>0))return;
var sz=Number(i.dataset.size);rows.push({cex_id:Number(i.dataset.id),qty:sz>0?Math.round(v*sz*1000)/1000:v})});
if(!rows.length){msg('Нищо не е въведено.','err');return}
if(!confirm('Изпращам заявка с '+rows.length+' продукта към цеха. Продължавам?'))return;
busy('Изпраща се…','Заявката тръгва към цеха. Не натискай пак.');
api({action:'create_request',items:rows,note:null}).then(function(j){free();if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}
try{localStorage.removeItem(DRAFT)}catch(e){}
document.querySelectorAll('input.q').forEach(function(i){i.value=''});count();
msg('\\u2713 Заявката е изпратена ('+(j.items_count||rows.length)+' продукта). Цехът я вижда.','ok')}).catch(function(e){free();msg('Мрежова грешка: '+e,'err')})}
function busy(t,s){var b=$('busy');b.querySelector('.tx').textContent=t;$('busysub').textContent=s||'';b.className='on';
document.querySelectorAll('button').forEach(function(x){x.disabled=true})}
function free(){$('busy').className='';document.querySelectorAll('button').forEach(function(x){x.disabled=false});count()}

/* ── История: същата лента с дати като в цеха, но тук се чете „поиска / дойде" ── */
var ALL=[],DATES=[],SEL=null,OPEN={},TODAY='';
var LBL={pending:'чака цеха',processing:'в процес',done:'донесена',partial:'частична',failed:'пропадна',cancelled:'отказана'};
function n3(v){return Math.round(Number(v)*1000)/1000}
function hhmm(s){var d=new Date(s);return isNaN(d)?'':('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}
function dlabel(d){if(d===TODAY)return 'Днес';var y=new Date(Date.parse(TODAY)-864e5).toISOString().slice(0,10);if(d===y)return 'Вчера';var p=d.split('-');return p[2]+'.'+p[1]}
function tab(n){$('t1').className=n===1?'on':'';$('t2').className=n===2?'on':'';
$('p1').style.display=n===1?'':'none';$('p2').style.display=n===2?'':'none';$('bar').style.display=n===1?'':'none';
if(n===2)hist()}
function pick(d){SEL=d;drawDays();drawHist()}
function drawDays(){var h='';DATES.forEach(function(x){h+='<button class="'+(x.date===SEL?'on':'')+'" onclick="pick(&quot;'+x.date+'&quot;)">'+dlabel(x.date)+'</button>'});$('days').innerHTML=h}
function drawHist(){var rs=ALL.filter(function(r){return r.for_date===SEL});
if(!rs.length){$('hist').innerHTML='<div class="card" style="color:var(--dim)">Няма заявки за този ден.</div>';return}
var h='';rs.forEach(function(r){var it=r.items||[],op=OPEN[r.id];
h+='<div class="card'+(op?' open':'')+'"><div class="head" onclick="tg(&quot;'+esc(r.id)+'&quot;)">'+
'<span><span class="t">'+hhmm(r.created_at)+'</span> <span class="s">'+it.length+' продукта'+(r.parent_id?' · остатък':'')+'</span></span>'+
'<span><span class="pill '+esc(r.status)+'">'+esc(LBL[r.status]||r.status)+'</span> <span class="caret">'+(op?'▲':'▼')+'</span></span></div>'+
'<div class="body"><table><tr><th>Продукт</th><th class="num">Поиска</th><th class="num">Дойде</th></tr>';
it.forEach(function(x){var s=x.sent,p=x.pack;
h+='<tr><td>'+esc(x.name)+(p?'<span class="sub2">'+n3(p.count)+' '+esc(p.plural)+'</span>':'')+'</td><td class="num">'+n3(x.qty)+' '+esc(x.unit||'')+'</td>'+
'<td class="num '+(s==null?'':(Number(s)<Number(x.qty)?'cut':'sent'))+'">'+(s==null?'—':n3(s))+'</td></tr>'});
h+='</table>';
if(r.status==='done')h+='<div class="docs">зареждане №'+esc(r.shop_doc_id||'?')+'</div>';
if(r.error)h+='<div class="msg err" style="display:block">'+esc(r.error)+'</div>';
h+='</div></div>'});
$('hist').innerHTML=h}
function tg(id){OPEN[id]=!OPEN[id];drawHist()}
function hist(){msg('Зареждам историята…','info');api({action:'list_requests',days:14}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}
ALL=j.requests||[];DATES=j.dates||[];TODAY=j.today;
if(!DATES.length){$('days').innerHTML='';$('hist').innerHTML='';msg('Няма заявки в последните 14 дни.','info');return}
if(!SEL||!DATES.some(function(x){return x.date===SEL}))SEL=DATES[0].date;
drawDays();drawHist();msg('Последните 14 дни. Клик на заявка я отваря.','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
reload();
</script></body></html>`;
}

function cexPage(k) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Заявки от точката</title>
${FONTS}${PWA(k)}<style>${CSS}${HUB_CSS}</style></head><body>
<header><span class="logo" role="img" aria-label="MOTAMO">${LOGO}</span>
<h1>Заявки от точката<small>цех · прехвърляне към Каравелов</small></h1>
<button class="ghost" id="bell" onclick="bell()">🔔<span class="hidesm"> Известия</span></button>
<button class="ghost" onclick="load()">↻<span class="hidesm"> Опресни</span></button></header>
<div class="wrap">${navBar(k, "cex")}<div id="days" class="days"></div><div id="msg" class="msg info">Зареждам…</div><div id="list"></div></div>
<div id="busy"><div class="sp"></div><div class="tx">Обработва се…</div><div class="sub" id="busysub">Не натискай пак — Barsy записва документите.</div></div>
<script>
var K=${JSON.stringify(k)};
function $(i){return document.getElementById(i)}
/* Съобщението е най-горе, а бутоните са долу в разгънатата карта — без това
   скролване изглежда, че натискаш и „нищо не става". */
function msg(t,c,scroll){var m=$('msg');m.className='msg '+(c||'info');m.textContent=t;
if(scroll){try{m.scrollIntoView({behavior:'smooth',block:'center'})}catch(e){window.scrollTo(0,0)}}}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function api(b){return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:K},b))}).then(function(r){return r.json()})}
var ALL=[],DATES=[],SEL=null,OPEN={};
var LBL={pending:'чака',processing:'в процес',done:'изпълнена',partial:'частична',failed:'пропадна',cancelled:'отказана'};
function n3(v){return Math.round(Number(v)*1000)/1000}
function hhmm(s){var d=new Date(s);return isNaN(d)?'':('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2)}
function dlabel(d,today){if(d===today)return 'Днес';var y=new Date(Date.parse(today)-864e5).toISOString().slice(0,10);if(d===y)return 'Вчера';var p=d.split('-');return p[2]+'.'+p[1]}
function renderDays(today){var h='';DATES.forEach(function(x){h+='<button class="'+(x.date===SEL?'on':'')+'" onclick="pick(&quot;'+x.date+'&quot;)">'+dlabel(x.date,today)+(x.pending?'<span class="b">'+x.pending+'</span>':'')+'</button>'});$('days').innerHTML=h}
function pick(d){SEL=d;renderDays(TODAY);renderList()}
function renderList(){
var rs=ALL.filter(function(r){return r.for_date===SEL});
if(!rs.length){$('list').innerHTML='<div class="card" style="color:var(--dim)">Няма заявки за този ден.</div>';return}
var h='';rs.forEach(function(r){var it=r.items||[],op=OPEN[r.id];
var sum=0;it.forEach(function(x){sum+=Number(x.sent!=null?x.sent:x.qty)});
h+='<div class="card'+(op?' open':'')+'"><div class="head" onclick="tog(&quot;'+esc(r.id)+'&quot;)">'+
'<span><span class="t">'+hhmm(r.created_at)+'</span> <span class="s">'+it.length+' продукта'+(r.parent_id?' · остатък':'')+'</span></span>'+
'<span><span class="pill '+esc(r.status)+'">'+esc(LBL[r.status]||r.status)+'</span> <span class="caret">'+(op?'▲':'▼')+'</span></span></div>'+
'<div class="body">';
var edit=(r.status==='pending');
h+='<table><tr><th>Продукт</th><th class="num">Искат</th><th class="num">'+(edit?'Изпращам':'Тръгна')+'</th><th class="num">В цеха</th></tr>';
it.forEach(function(x){
var stock=x.cex_stock,low=(stock!=null&&stock<x.qty),p=x.pack;
h+='<tr><td>'+esc(x.name)+(p?'<span class="sub2">'+n3(p.count)+' '+esc(p.plural)+' по '+(p.size*1000)+' г</span>':'')+'</td><td class="num">'+n3(x.qty)+' '+esc(x.unit||'')+'</td>';
if(edit){h+='<td class="num"><input class="q" type="number" min="0" step="any" inputmode="decimal" data-r="'+esc(r.id)+'" data-id="'+x.cex_id+'" data-max="'+(stock==null?'':stock)+'" value="'+n3(Math.min(x.qty,stock==null?x.qty:Math.max(0,stock)))+'" oninput="chk(this)"></td>'}
else{var s=x.sent;h+='<td class="num '+(s==null?'':(Number(s)<Number(x.qty)?'cut':'sent'))+'">'+(s==null?'—':n3(s))+'</td>'}
h+='<td class="num'+(low?' neg':'')+'">'+(stock==null?'—':n3(stock))+'</td></tr>'});
h+='</table>';
if(r.error)h+='<div class="msg err" style="display:block">'+esc(r.error)+'</div>';
if(r.status==='done')h+='<div class="docs">цех прехвърляне №'+esc(r.cex_doc_id||'?')+' · точка зареждане №'+esc(r.shop_doc_id||'?')+'</div>';
if(edit)h+='<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap"><button onclick="run(&quot;'+esc(r.id)+'&quot;,true)">Издай документите</button><button class="ghost" onclick="cancelReq(&quot;'+esc(r.id)+'&quot;)">Откажи</button></div>';
if(r.status==='partial')h+='<div style="margin-top:12px"><button onclick="run(&quot;'+esc(r.id)+'&quot;,true)">Опитай пак точката</button></div>';
h+='</div></div>'});
$('list').innerHTML=h}
function tog(id){OPEN[id]=!OPEN[id];renderList()}
function chk(i){var mx=i.dataset.max;if(mx!==''&&Number(i.value)>Number(mx)){i.value=n3(mx);i.style.borderColor='#d97706'}else{i.style.borderColor=''}}
function sendMap(id){var m={};document.querySelectorAll('input.q[data-r="'+id+'"]').forEach(function(i){m[i.dataset.id]=Number(i.value)||0});return m}
var TODAY='';
function load(){msg('Зареждам…','info');api({action:'list_requests',days:14}).then(function(j){if(!j.ok){msg('Грешка: '+(j.error||''),'err');return}
ALL=j.requests||[];DATES=j.dates||[];TODAY=j.today;
SEEN=ALL.filter(function(r){return r.status==='pending'}).map(function(r){return r.id});
if(!DATES.length){$('days').innerHTML='';$('list').innerHTML='';msg('Няма заявки в последните 14 дни.','info');return}
if(!SEL||!DATES.some(function(x){return x.date===SEL}))SEL=DATES[0].date;
renderDays(TODAY);renderList();
var p=ALL.filter(function(r){return r.status==='pending'}).length;
msg(p?(p+' чакащи заявки.'):'Няма чакащи заявки.',p?'ok':'info')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
function run(id,write){
var send=sendMap(id),n=0;for(var k in send)if(send[k]>0)n++;
if(!n){msg('Всички количества са 0 — няма какво да се изпрати.','err',1);return}
if(!confirm('ИЗДАВАМ двата документа за '+n+' продукта:\\n1) цех прехвърляне Основен → Точка\\n2) зареждане в точката\\n\\nПродължавам?'))return;
busy('Издавам документите…','Правя цех прехвърлянето и зареждането в точката. Не натискай пак.');
api({action:'process_request',id:id,dry:false,send:send}).then(function(j){
free();if(!j.ok){msg('Грешка: '+(j.error||''),'err',1);load();return}
msg(j.message||'Готово.','ok',1);load()}).catch(function(e){free();msg('Мрежова грешка: '+e,'err',1);load()})}
function busy(t,s){var b=$('busy');b.querySelector('.tx').textContent=t;$('busysub').textContent=s||'';b.className='on';
document.querySelectorAll('button').forEach(function(x){x.disabled=true})}
function free(){$('busy').className='';document.querySelectorAll('button').forEach(function(x){x.disabled=false})}
function cancelReq(id){if(!confirm('Отказвам тази заявка?'))return;api({action:'cancel_request',id:id}).then(function(){load()})}

/* ── ИЗВЕСТИЯ ────────────────────────────────────────────────────────────────
   Цех екранът стои отворен на таблета: сам се опреснява и щом от точката дойде
   НОВА заявка — звъни, показва известие и мига в заглавието. Нула разходи,
   вместо платен Viber Business (там месечният минимум е в пъти над нуждата). */
var SEEN=null,ARMED=false,AC=null,TITLE=document.title,BLINK=null;
function bell(){
  // Едно натискане прави две неща: иска разрешение за известия И отключва звука
  // (браузърът пуска аудио само след докосване от потребителя).
  try{AC=AC||new (window.AudioContext||window.webkitAudioContext)();AC.resume()}catch(e){}
  if(window.Notification&&Notification.permission==='default'){Notification.requestPermission().then(mark)}else{mark()}
  ARMED=true;try{localStorage.setItem('motamo-transfer-bell','1')}catch(e){}
  ding();msg('Известията са включени. Екранът се опреснява сам на 20 секунди.','ok');
}
function mark(){var b=$('bell');if(!b)return;
var okN=(window.Notification&&Notification.permission==='granted');
b.innerHTML=(ARMED?'🔔':'🔕')+'<span class="hidesm"> '+(ARMED?(okN?'Включено':'Само звук'):'Известия')+'</span>'}
function ding(){try{if(!AC)return;var t=AC.currentTime;[880,1174,1568].forEach(function(f,i){
var o=AC.createOscillator(),g=AC.createGain();o.type='sine';o.frequency.value=f;
g.gain.setValueAtTime(0,t+i*0.16);g.gain.linearRampToValueAtTime(0.32,t+i*0.16+0.02);
g.gain.exponentialRampToValueAtTime(0.001,t+i*0.16+0.38);
o.connect(g);g.connect(AC.destination);o.start(t+i*0.16);o.stop(t+i*0.16+0.4)})}catch(e){}}
function blink(n){clearInterval(BLINK);var on=false,c=0;
BLINK=setInterval(function(){on=!on;document.title=on?('\\u25cf '+n+' нова заявка'):TITLE;
if(++c>40){clearInterval(BLINK);document.title=TITLE}},900);
window.addEventListener('focus',function(){clearInterval(BLINK);document.title=TITLE},{once:true})}
function alarm(fresh){
  ding();blink(fresh.length);
  var names=fresh.map(function(r){return (r.items||[]).length+' продукта'}).join(', ');
  try{if(window.Notification&&Notification.permission==='granted')
    new Notification('Нова заявка от точката',{body:names+' · отвори цех екрана',tag:'motamo-transfer',renotify:true})}catch(e){}
  msg('\\u25cf Нова заявка от точката ('+names+')','ok',1);
}
/* Проверява тихо; при промяна пререндира и алармира само за НОВИТЕ чакащи. */
function poll(){api({action:'list_requests',days:14}).then(function(j){if(!j.ok)return;
var rs=j.requests||[],pend=rs.filter(function(r){return r.status==='pending'});
var ids=pend.map(function(r){return r.id});
if(SEEN===null){SEEN=ids;return}
var fresh=pend.filter(function(r){return SEEN.indexOf(r.id)<0});
var changed=(ids.join()!==SEEN.join())||rs.length!==ALL.length;
SEEN=ids;
if(changed){ALL=rs;DATES=j.dates||[];TODAY=j.today;
  if(!SEL||!DATES.some(function(x){return x.date===SEL}))SEL=(DATES[0]||{}).date;
  renderDays(TODAY);renderList()}
if(fresh.length&&ARMED)alarm(fresh)}).catch(function(){})}
try{if(localStorage.getItem('motamo-transfer-bell')==='1')ARMED=true}catch(e){}
mark();load();setInterval(poll,20000);
</script></body></html>`;
}

// ── ХЪБ: един вход към трите екрана ──────────────────────────────────────────
// Ключът пътува в линковете, за да се сложи ЕДНА икона на началния екран.
// Два ключа, два изгледа. `TRANSFER_TOKEN` е у момичетата в точката — той отваря
// САМО заявката. `OWNER_TOKEN` е на собственика: освен трите екрана, показва и
// цех инструмента (производство, сметки, стокови), чийто ключ се вмъква от
// сървъра — така по-силният ключ никога не стига до телефона в точката.
const isOwner = (k) => !!(process.env.OWNER_TOKEN && k === process.env.OWNER_TOKEN)
  || [process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET, process.env.CEX_VIEW_TOKEN]
    .some(t => t && k === t);
// ⚠ Редът тук има значение. Цех инструментът дели токените на ЧЕТЯЩИ и ПИШЕЩИ:
// `CEX_VIEW_TOKEN` отваря страницата и смята, но „② Артикули" (`produce_plan`),
// „③ Сметки" и „④ Стокова" ПИШАТ и искат силен ключ — с четящия връщат
// „Грешка: forbidden". Затова плочката носи силния. Вижда я само собственикът
// (`isOwner`), така че до телефона в точката не стига.
const cexToolKey = () => process.env.RECONCILE_TOKEN || process.env.PAY_HMAC_SECRET
  || process.env.PREVIEW_TOKEN || process.env.CEX_VIEW_TOKEN || "";

const NAV = [
  { v: "shop", t: "Заявка към цеха", own: false },
  { v: "cex", t: "Заявки от точката", own: true },
  { v: "stock", t: "Складът на цеха", own: true }
];
function navBar(k, cur) {
  const own = isOwner(k);
  const items = NAV.filter(x => own || !x.own).map(x =>
    x.v === cur ? `<span class="on">${x.t}</span>`
      : `<a href="?view=${x.v}&k=${encodeURIComponent(k)}">${x.t}</a>`);
  if (own && cexToolKey()) items.push(`<a href="/api/cex-plan?view=tool&k=${encodeURIComponent(cexToolKey())}">Производство</a>`);
  return items.length > 1 ? `<nav class="nav">${items.join("")}</nav>` : "";
}

const HUB_CSS = `
.hub{display:grid;gap:14px;margin-top:18px}
.hub a{display:flex;align-items:center;justify-content:space-between;gap:14px;text-decoration:none;
  background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px 22px;color:var(--fg)}
.hub a:active{border-color:var(--sun)}
.hub b{font-family:var(--font-d);font-size:19px;display:block}
.hub span{font-size:13.5px;color:var(--dim)}
.hub .go{font-size:26px;color:var(--sun);font-weight:800;line-height:1}
.hub .badge{background:var(--sun);color:#fff;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:800}
.nav{display:flex;gap:6px;overflow-x:auto;padding:8px 0 0;-webkit-overflow-scrolling:touch}
.nav a,.nav span{flex:0 0 auto;font-size:13px;font-weight:700;padding:7px 13px;border-radius:999px;text-decoration:none}
.nav a{background:var(--chip);color:var(--dim)}
.nav span.on{background:var(--sun);color:#fff}
`;

function hubPage(k) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO цех</title>
${FONTS}${PWA(k)}<style>${CSS}${HUB_CSS}</style></head><body>
<header><span class="logo" role="img" aria-label="MOTAMO">${LOGO}</span>
<h1>Цех и точка<small>всичко на едно място</small></h1></header>
<div class="wrap">
  <div class="hub">
    <a href="?view=shop&k=${encodeURIComponent(k)}"><span><b>Заявка към цеха</b><span>точката поръчва какво да донесат</span></span><span class="go">→</span></a>
    ${isOwner(k) ? `
    <a href="?view=cex&k=${encodeURIComponent(k)}"><span><b>Заявки от точката</b><span>цехът изпълнява и издава документите</span></span><span id="pend" class="go">→</span></a>
    <a href="?view=stock&k=${encodeURIComponent(k)}"><span><b>Складът на цеха</b><span>какво няма да стигне до доставката</span></span><span id="short" class="go">→</span></a>
    ${cexToolKey() ? `<a href="/api/cex-plan?view=tool&k=${encodeURIComponent(cexToolKey())}"><span><b>Производство и стокови</b><span>заготовки, артикули, сметки, стокови разписки</span></span><span class="go">→</span></a>
    <a href="/api/cex-plan?view=reports&k=${encodeURIComponent(cexToolKey())}"><span><b>Отчети</b><span>оборот и себестойност — цех и точка</span></span><span class="go">→</span></a>` : ``}
    ` : ``}
  </div>
  <div id="msg" class="msg info" style="margin-top:16px">${isOwner(k) ? "Проверявам…" : "Натисни, за да поръчаш от цеха."}</div>
</div>
<script>
var K=${JSON.stringify(k)},OWN=${isOwner(k) ? "true" : "false"};
function $(i){return document.getElementById(i)}
function api(b){return fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({token:K},b))}).then(function(r){return r.json()})}
if(OWN){
Promise.all([api({action:'list_requests',days:14}),api({action:'stock_report'})]).then(function(r){
var q=r[0],s=r[1],bits=[];
if(q.ok){var p=(q.requests||[]).filter(function(x){return x.status==='pending'}).length;
 if(p){$('pend').className='badge';$('pend').textContent=p;bits.push(p+' чакащи заявки')}}
if(s.ok){var raw=s.raw||[],n=raw.filter(function(x){return x.c!==null&&(x.c-x.lead)<0}).length;
 if(n){$('short').className='badge';$('short').textContent=n;bits.push(n+' суровини няма да стигнат')}}
var m=$('msg');m.className='msg '+(bits.length?'err':'ok');
m.textContent=bits.length?bits.join(' · '):'Няма чакащи заявки, всички суровини стигат до доставката.';
}).catch(function(){$('msg').className='msg err';$('msg').textContent='Мрежова грешка'});
}
</script></body></html>`;
}

// ── СКЛАДОВОТО ТАБЛО (жив екран) ─────────────────────────────────────────────
// Същият разрез като еднократния отчет, но данните се четат от Barsy при всяко
// отваряне: наличности, себестойности и производствата за последните 28 дни.
const STOCK_CSS = `
.sum{display:flex;flex-wrap:wrap;border-top:2px solid var(--fg);border-bottom:1px solid var(--line);margin:4px 0 8px}
.sum div{flex:1 1 150px;padding:14px 16px 13px;border-right:1px solid var(--line)}
.sum div:last-child{border-right:0}
.sum b{display:block;font-family:var(--font-d);font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}
.sum span{display:block;font-size:12px;color:var(--dim);margin-top:4px}
.sum .r b{color:var(--sun)} .sum .a b{color:#C08A2E}
.tw{overflow-x:auto;margin-top:10px}
.tw table{min-width:700px}
.tw td{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tw td:first-child,.tw td.l{text-align:left}
.tw td:first-child{white-space:normal;border-left:3px solid transparent;padding-left:11px}
.tw th{text-align:right}.tw th:first-child,.tw th.l{text-align:left}
tr.now td:first-child{border-left-color:var(--sun)}
tr.soon td:first-child{border-left-color:#C08A2E}
tr.over td:first-child{border-left-color:#7C8B99}
.cov{font-family:var(--font-d);font-size:15px}
tr.now .cov{color:var(--sun)} tr.soon .cov{color:#C08A2E} tr.over .cov{color:#7C8B99}
.pl{display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:3px;white-space:nowrap}
.pl.now{background:var(--sun);color:#fff}
.pl.soon{color:#C08A2E;border:1px solid currentColor}
.pl.ok{color:var(--dim)}
.pl.over{color:#7C8B99;border:1px solid currentColor}
.tw i{font-style:normal;color:var(--dim);font-size:12.5px}
.sup{font-size:13px;color:var(--dim)}
.sup em{font-style:normal;color:var(--dim);opacity:.75;font-size:12px;display:block}
h2{font-family:var(--font-d);font-size:16px;margin:34px 0 4px}
.nt{color:var(--dim);font-size:13.5px;margin:0 0 10px;max-width:70ch}
.sched{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));border-top:1px solid var(--line);margin-top:8px}
.sched div{padding:11px 14px;border-bottom:1px solid var(--line);border-right:1px solid var(--line)}
.sched b{display:block;font-size:14px}.sched span{font-size:12.5px;color:var(--dim)}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:24px}
ul.lst{list-style:none;margin:6px 0 0;padding:0}
ul.lst li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:14px}
ul.lst li b{font-variant-numeric:tabular-nums;white-space:nowrap}
ul.lst li em{font-style:normal;color:var(--dim);font-size:12.5px;display:block}
.meta{margin-top:36px;padding-top:14px;border-top:1px solid var(--line);color:var(--dim);font-size:12.5px}
`;

function stockPage(k) {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Складът на цеха</title>
${FONTS}${PWA(k)}<style>${CSS}${HUB_CSS}${STOCK_CSS}</style></head><body>
<header><span class="logo" role="img" aria-label="MOTAMO">${LOGO}</span>
<h1>Складът на цеха<small>какво няма да стигне до следващата доставка</small></h1>
<button class="ghost" onclick="load()">↻<span class="hidesm"> Опресни</span></button></header>
<div class="wrap">
  ${navBar(k, "stock")}
  <div id="msg" class="msg info">Чета от Barsy…</div>
  <div class="sum">
    <div class="r"><b id="sNow">–</b><span>няма да стигнат</span></div>
    <div class="a"><b id="sSoon">–</b><span>на ръба</span></div>
    <div><b id="sVal">–</b><span>€ в суровини</span></div>
    <div><b id="sDead">–</b><span>€ без движение</span></div>
  </div>
  <h2>Суровини</h2>
  <p class="nt">Подредени по <b>запас</b> — дните покритие минус дните до следващата доставка от този доставчик. Отрицателно значи, че ще свърши преди камионът да дойде.</p>
  <div class="tw"><table id="tRaw"><thead><tr><th>Суровина</th><th>Стига за</th><th class="l">Доставчик</th><th class="l">Състояние</th><th>Налично</th><th>Разход / ден</th><th>Стойност</th></tr></thead><tbody></tbody></table></div>
  <h2>Графикът на доставчиците</h2>
  <div class="sched">
    <div><b>Брадърс Комерс</b><span>всеки ден · крема сирене, майонеза, пиле, олио, захар, сол</span></div>
    <div><b>Фиш Експрес</b><span>вторник и петък · риба, скариди, сурими, нори, унаги, сусам</span></div>
    <div><b>Алекс Фиш</b><span>понеделник и четвъртък · пушена сьомга, чили сос, сусамо олио</span></div>
    <div><b>Айсбокс</b><span>веднъж седмично · авокадо, царевица, манго</span></div>
    <div><b>Метро</b><span>на място · зеле, чесън, уни сос</span></div>
    <div><b>Foodex</b><span>внос, рядко · ориз, оцет, кутии, соев сос, гьози</span></div>
  </div>
  <h2>Заготовки и ролки</h2>
  <p class="nt">Тези не се купуват — правят се всяка сутрин. Ниското покритие тук е нормално; показани са заради дневния разход.</p>
  <div class="tw"><table id="tMade"><thead><tr><th>Артикул</th><th>Дни</th><th>Налично</th><th>Разход / ден</th></tr></thead><tbody></tbody></table></div>
  <div class="cols">
    <section><h2>Отиват в точката</h2><p class="nt">Нула разход в цеха, защото се прехвърлят на Каравелов.</p><ul class="lst" id="lPoint"></ul></section>
    <section><h2>Без движение 28 дни</h2><p class="nt">По пари. Част са оборудване, част за преглед.</p><ul class="lst" id="lRest"></ul></section>
  </div>
  <p class="meta" id="meta"></p>
</div>
<script>
var K=${JSON.stringify(k)};
function $(i){return document.getElementById(i)}
function msg(t,c){var m=$('msg');m.className='msg '+(c||'info');m.textContent=t}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmt(n){return Number(n).toLocaleString('bg-BG')}
function slack(r){return r.c===null?999:(r.c-r.lead)}
function st(r){return slack(r)<0?'now':slack(r)<4?'soon':(r.c!==null&&r.c>120)?'over':'ok'}
var LBL={now:'няма да стигне',soon:'на ръба',ok:'добре',over:'презапас'};
function load(){msg('Чета от Barsy…','info');
fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:K,action:'stock_report'})})
.then(function(r){return r.json()}).then(function(d){
if(!d.ok){msg('Грешка: '+(d.error||''),'err');return}
var raw=(d.raw||[]).slice().sort(function(a,b){return slack(a)-slack(b)});
$('tRaw').tBodies[0].innerHTML=raw.map(function(r){var s=st(r);
return '<tr class="'+s+'"><td>'+esc(r.n)+'</td>'+
'<td class="cov">'+(r.c===null?'—':r.c)+' <i>дни</i></td>'+
'<td class="l"><span class="sup">'+esc(r.sup)+'<em>идва след '+r.lead+' дни</em></span></td>'+
'<td class="l"><span class="pl '+s+'">'+LBL[s]+'</span></td>'+
'<td>'+fmt(r.s)+' <i>'+esc(r.u)+'</i></td>'+
'<td>'+fmt(r.v28)+' <i>7дн '+fmt(r.v7)+'</i></td>'+
'<td><i>'+fmt(r.val)+' €</i></td></tr>'}).join('');
$('tMade').tBodies[0].innerHTML=(d.made||[]).slice().sort(function(a,b){return (a.c===null?1e9:a.c)-(b.c===null?1e9:b.c)})
.map(function(r){return '<tr><td>'+esc(r.n)+'</td><td class="cov">'+(r.c===null?'—':r.c)+'</td><td>'+fmt(r.s)+' <i>'+esc(r.u)+'</i></td><td><i>'+fmt(r.v)+'</i></td></tr>'}).join('');
function li(a){return a.map(function(x){return '<li><span>'+esc(x.n)+'<em>'+fmt(x.s)+' '+esc(x.u)+'</em></span><b>'+fmt(x.val)+' €</b></li>'}).join('')}
$('lPoint').innerHTML=li(d.toPoint||[]);$('lRest').innerHTML=li((d.rest||[]).slice(0,14));
function sum(a){return a.reduce(function(s,x){return s+x.val},0)}
$('sNow').textContent=raw.filter(function(r){return st(r)==='now'}).length;
$('sSoon').textContent=raw.filter(function(r){return st(r)==='soon'}).length;
$('sVal').textContent=fmt(sum(d.raw||[]));
$('sDead').textContent=fmt(sum(d.rest||[]));
$('meta').textContent='Живо от Barsy · '+d.for_date+' · разходът е от '+d.prods+' производства за 28 дни ('+d.work_days+' работни дни), разгънати по рецепта; '+d.annulled+' анулирани не влизат. Всички суми са в евро.';
msg('Готово · '+raw.length+' суровини','ok')}).catch(function(e){msg('Мрежова грешка: '+e,'err')})}
load();
</script></body></html>`;
}

// ── HANDLER ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  // `TRANSFER_TOKEN` е собственият ключ на този инструмент (точката го ползва от
  // телефона си); старите ключове също се приемат, за да работи един и същ линк.
  const viewTokens = [process.env.OWNER_TOKEN, process.env.TRANSFER_TOKEN, process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].filter(Boolean);

  // Манифестът се сервира от същия адрес, за да е в обхвата на страницата.
  if (req.method === "GET" && q.view === "manifest") {
    if (!viewTokens.some(t => q.k === t)) { res.status(403).json({ error: "forbidden" }); return; }
    res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    res.status(200).json(manifest(q.k, isOwner(q.k)));
    return;
  }

  const VIEWS = ["shop", "cex", "stock", "hub"];
  if (req.method === "GET" && (VIEWS.includes(q.view) || (!q.view && q.k))) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const okTok = viewTokens.some(t => q.k === t) || (q.view === "stock" && process.env.PEEK_TOKEN && q.k === process.env.PEEK_TOKEN);
    if (!okTok) {
      res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:24px'>Няма достъп — липсва или грешен ключ (?k=).</body>");
      return;
    }
    // Цех екраните искат ключа на собственика. С ключа от телефона в точката се
    // отваря само заявката — там не бива да се пуска производство или да се
    // гледа себестойност.
    if ((q.view === "cex" || q.view === "stock") && !isOwner(q.k)
      && !(q.view === "stock" && process.env.PEEK_TOKEN && q.k === process.env.PEEK_TOKEN)) {
      res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:24px'>Този екран е само за цеха.</body>");
      return;
    }
    const view = q.view || "hub";
    res.status(200).send(
      view === "shop" ? shopPage(q.k)
      : view === "stock" ? stockPage(q.k)
      : view === "cex" ? cexPage(q.k)
      : hubPage(q.k));
    return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};
  const token = body.token != null ? body.token : q.token;
  // Четящите/диагностичните действия приемат и PEEK_TOKEN (read-only прозорецът за
  // разработка); всичко, което пише, иска пълния токен.
  const readOnly = ["list", "list_requests", "inspect", "stock_report"].includes(body.action);
  const allowed = readOnly ? viewTokens.concat([process.env.PEEK_TOKEN].filter(Boolean)) : viewTokens;
  if (!allowed.some(t => token === t)) { res.status(403).json({ ok: false, error: "forbidden" }); return; }
  if (!process.env.BARSY_CEX_USER || !process.env.BARSY_USER) { res.status(500).json({ ok: false, error: "not_configured" }); return; }

  try {
    // ── СКРИЙ/ПОКАЖИ АРТИКУЛ В ОНЛАЙН МЕНЮТО ────────────────────────────────
    // Сайтът чете менюто направо от публичния Barsy, затова `is_public: 0` го
    // маха от motamo.bg, а на касата си остава. Артикулът се ЧЕТЕ цял (54 полета)
    // и се връща непокътнат с едно сменено поле — `Articles_save` иска пълния
    // запис и частичен би изтрил цена, снимка или описание.
    // DRY по подразбиране: пише само при `dry:false`.
    if (body.action === "set_public") {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean);
      if (!ids.length) { res.status(400).json({ ok: false, error: "no_ids" }); return; }
      const want = body.visible === true ? 1 : 0;
      const field = body.field === "is_for_sale" ? "is_for_sale" : "is_public";
      const write = body.dry === false;
      const readOne = async (id) => {
        const r = await shopRoot({ articles_edit: { id, action_type: "values", active_struct_id: "eStructForm_1", params: { bid: BID, id } } });
        return (r.data && r.data.articles_edit) || null;
      };
      const out = [];
      for (const id of ids) {
        const a = await readOne(id);
        if (!a || a.article_id == null) { out.push({ id, ok: false, error: "не се прочете" }); continue; }
        const was = Number(a[field]);
        if (was === want) { out.push({ id, name: a.article_name, ok: true, skipped: "вече е такъв" }); continue; }
        if (!write) { out.push({ id, name: a.article_name, ok: true, dry: true, from: was, to: want }); continue; }
        // Себестойността се смята от рецептата — върнеш ли я, Barsy отказва целия
        // запис с „Не може да се редактира ръчно себестойност, когато артикула има
        // рецепта". Махаме я и оставяме Barsy да си я изчисли.
        const values = { ...a, [field]: want };
        delete values.avg_delivery_price;
        delete values.delivery_price;
        const sv = await shopRoot({ Articles_save: { id, action_type: "save", values } });
        const after = await readOne(id);
        const now = after ? Number(after[field]) : null;
        out.push({
          id, name: a.article_name, ok: now === want, from: was, to: now,
          error: now === want ? undefined : String(sv.raw || "").slice(0, 200)
        });
      }
      res.status(200).json({ ok: out.every(x => x.ok), dry: !write, field, want, items: out });
      return;
    }

    // ── складовото табло (чете живо от Barsy при всяко отваряне) ──
    if (body.action === "stock_report") {
      const rep = await stockReport();
      res.status(200).json({ ok: true, ...rep });
      return;
    }

    // ── списъкът с 35-те продукта + наличности (за формата на точката) ──
    if (body.action === "list") {
      const items = await buildList();
      res.status(200).json({ ok: true, for_date: sofiaToday(), items: items.map(x => ({ ...x, zag: ZAG.includes(x.cex_id) })) });
      return;
    }

    // ── ДИАГНОСТИКА (само четене): зарежда формата на записващ метод, за да се
    // видят полетата, които Barsy очаква. `what`: "move" = прехвърляне в цеха
    // (Основен→Точка), "load" = зареждане в точката. Нищо не се записва.
    if (body.action === "inspect") {
      const what = body.what || "move";
      const call = what === "load" ? shopRoot : cexRoot;
      const payload = body.payload || (what === "load"
        ? { Storeloads_edit: { params: { bid: BID } } }
        : { Storemoves_edit: { params: { bid: BID } } });
      const r = await call(payload);
      const inner = r.data && (r.data.Storemoves_edit || r.data.Storeloads_edit || r.data);
      const actions = [];
      (function w(n) {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(w);
        if (n.type === "action" && n.target) actions.push({ title: n.title || null, target: n.target });
        for (const k in n) w(n[k]);
      })(inner);
      res.status(200).json({
        ok: r.ok, what, status: r.status,
        values: inner ? formValues(inner) : null,
        actions: actions.slice(0, 20),
        raw: String(r.raw || "").slice(0, Number(body.raw_chars) || 1500)
      });
      return;
    }

    // ── точката праща заявка ──
    if (body.action === "create_request") {
      const raw = Array.isArray(body.items) ? body.items : [];
      const want = new Map();
      for (const r of raw) {
        const id = Number(r && r.cex_id), qty = Number(r && r.qty);
        if (!MAP[id] || !(qty > 0)) continue;
        want.set(id, (want.get(id) || 0) + qty); // един ред на артикул
      }
      if (!want.size) { res.status(200).json({ ok: false, error: "празна заявка — няма нито едно количество > 0" }); return; }
      const list = await buildList();
      const byId = {}; for (const x of list) byId[x.cex_id] = x;
      // `qty` е ВИНАГИ в базовата единица (кг/л/бр) — така документите и складът
      // не се разминават. При артикул с опаковка пазим и колко опаковки е поискала
      // точката, за да се покаже пак като „2 тарелки".
      const items = [...want.entries()].map(([id, qty]) => {
        const p = PACK[id];
        return {
          cex_id: id, shop_id: MAP[id], name: (byId[id] || {}).name || ("#" + id),
          unit: (byId[id] || {}).unit || "бр", qty,
          pack: p ? { name: p.name, plural: p.plural, size: p.size, count: Math.round((qty / p.size) * 1000) / 1000 } : null,
          shop_stock: (byId[id] || {}).shop_stock, cex_stock: (byId[id] || {}).cex_stock
        };
      });
      const ins = await sbInsert({ for_date: sofiaToday(), status: "pending", items, note: body.note || null });
      if (!ins.ok) { res.status(200).json({ ok: false, error: "не се записа: " + ins.raw }); return; }
      res.status(200).json({ ok: true, id: ins.row && ins.row.id, items_count: items.length });
      return;
    }

    // ── историята: последните N дни, групирана по дата (за двата екрана) ──
    if (body.action === "list_requests") {
      const days = Math.min(Math.max(Number(body.days) || 14, 1), 90);
      const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
      const rows = await sbSelect(`for_date=gte.${from}&order=created_at.desc&limit=500`);
      // по дата, най-новата отгоре — лентата с дати се строи от това
      const byDate = {};
      for (const r of rows) (byDate[r.for_date] = byDate[r.for_date] || []).push(r);
      const dates = Object.keys(byDate).sort().reverse().map(d => ({
        date: d, count: byDate[d].length,
        pending: byDate[d].filter(x => x.status === "pending").length
      }));
      res.status(200).json({ ok: true, today: sofiaToday(), days, dates, requests: rows });
      return;
    }

    if (body.action === "cancel_request") {
      const id = String(body.id || ""); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
      const c = await sbClaim(id, "pending", { status: "cancelled" });
      res.status(200).json({ ok: c.ok, error: c.ok ? undefined : "заявката вече не е чакаща" });
      return;
    }

    // ── цехът изпълнява: 2 документа ──
    // ⚠ ЗАСЕГА DRY: взема заявката атомично (pending→processing) — така двойно
    // натискане НЕ прави втори комплект документи — проверява наличността в цеха,
    // сглобява редовете за двата документа и ВРЪЩА статуса обратно на pending.
    // НИЩО не се пише в Barsy, докато не се избере документният модел
    // (вътрешен трансфер vs продажба на вътрешен клиент).
    if (body.action === "process_request") {
      const id = String(body.id || ""); if (!id) { res.status(400).json({ ok: false, error: "no_id" }); return; }
      const write = body.dry === false;
      const claim = await sbClaim(id, "pending", { status: write ? "processing" : "pending" });
      if (!claim.ok) { res.status(200).json({ ok: false, error: "заявката вече се изпълнява или е изпълнена (двойно натискане)" }); return; }
      const reqRow = claim.row || {};
      const items = (Array.isArray(reqRow.items) ? reqRow.items : []).filter(it => MAP[it.cex_id] && Number(it.qty) > 0);
      if (!items.length) {
        await sbPatch(id, { status: "failed", error: "празна заявка" });
        res.status(200).json({ ok: false, error: "празна заявка" }); return;
      }

      // пресни данни: наличност + себестойност (цех) и партидите по артикул
      const [cr, lots] = await Promise.all([
        cexCall("Articles_getlistobject", { extra_properties: ["store_amount", "avg_delivery_price"] }),
        lotsByArticle(items.map(it => it.cex_id))
      ]);
      const cexA = {}; for (const a of artList(cr)) cexA[Number(a.article_id)] = a;
      const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

      // Цехът може да КОРИГИРА количествата преди да издаде документите
      // (`send` = {cex_id: количество}). Липсващ ключ = изпраща се исканото;
      // 0 = редът се пропуска. Никога повече от наличното в цеха.
      const override = (body.send && typeof body.send === "object") ? body.send : null;

      // редовете на двата документа
      const moveRows = [], loadRows = [], short = [], sentBy = {};
      for (const it of items) {
        const a = cexA[it.cex_id] || {};
        const have = num(a.store_amount);
        let want = Number(it.qty);
        if (override && Object.prototype.hasOwnProperty.call(override, String(it.cex_id))) {
          const v = Number(override[String(it.cex_id)]);
          if (Number.isFinite(v) && v >= 0) want = v;
        }
        const qty = round3(Math.min(want, Math.max(0, have))); // не даваме повече, отколкото има
        sentBy[it.cex_id] = qty;
        if (qty < Number(it.qty)) short.push(`${it.name}: искат ${it.qty}, тръгват ${qty}`);
        if (qty <= 0) continue;
        const alloc = allocate(qty, lots[it.cex_id]);
        if (alloc.short > 0) short.push(`${it.name}: ${alloc.short} ${it.unit || ""} без партида в склада`);
        for (const r of alloc.rows) {
          // Редът е точно какъвто го праща самият Barsy UI (снето от Network):
          // article_id е ЧИСЛО, без current_price/ref_num/lot_type_id.
          moveRows.push({
            row_id: "", article_id: it.cex_id, article_name: it.name,
            amount: r.amount, notes: "", lot_value: r.lot_value
          });
        }
        const cost = num(a.avg_delivery_price);
        void it.shop_id; // мапингът е водещ: MAP[cex_id], не запазеното в заявката
        // ★ Партидите в точката НЕ могат да се включат като истинско следене:
        // всичките 186 артикула там са „Без партида", а включи ли се, Barsy ще
        // иска избор на партида при ВСЯКА продажба и касата засяда. Затова
        // партидите от цеха се записват в „Бележки" на реда — БАБХ ги вижда в
        // документа, а истинското следене си остава в цеха (прехвърлянето носи
        // партида на всеки ред).
        const lotNote = alloc.rows
          .filter(r => r.lot_value)
          .map(r => r.lot_value + " (" + r.amount + " " + (it.unit || "") + ")" + (r.lot_exp ? ", годно до " + String(r.lot_exp).slice(0, 10) : ""))
          .join(" · ");
        loadRows.push({
          store_load_row_id: "", article_id: String(MAP[it.cex_id]),
          original_article_name: it.name, amount: String(qty),
          current_price: String(cost), delivery_price: String(cost),
          delivery_total: String(Math.round(cost * qty * 100) / 100),
          delivery_tax_id: "100", actual_tax_id: "100", tax: "0", tax_sum: "0",
          discount: "0", lot_value: "", lot_exp_date: null, lot_detail_id: "",
          notes: lotNote ? "Партида: " + lotNote : "", amount_unit: "1", is_group_art: 0
        });
      }

      if (!moveRows.length) {
        await sbPatch(id, { status: "pending", error: "няма нито един ред с наличност в цеха" });
        res.status(200).json({ ok: false, error: "няма нито един ред с наличност в цеха: " + short.join(" · ") }); return;
      }

      const today = sofiaToday();
      // Точният формат, снет от Network на самия Barsy UI (24.09): складовете са
      // `depot_id_left` / `depot_id_right` (НЕ from_/to_depot_id — с тях Barsy
      // отговаря „Не е подаден склад от който да се тегли"), а `doc_date` е null
      // (Barsy слага текущия момент).
      // ★ `action_type` = КЛЮЧЪТ на бутона в `global_actions`, не суфиксът след
      // „@". Проверено на живо: „Запиши" → `save` оставя ЧЕРНОВА (наличността не
      // мърда), „Запиши и изпрати" → `save_and_send` праща документа към другия
      // склад, но той чака ПРИЕМАНЕ (статус 2, стоката още не е там).
      // За нас е „Запиши и премести" = `save_and_close` — директното местене
      // (складът позволява: `allow_direct_move:1`).
      const movePayload = { Storemoves_save: {
        id: null, action_type: "save_and_close",
        values: {
          user_name: null, doc_date: null,
          description: "Прехвърляне към точка Каравелов (заявка " + id.slice(0, 8) + ")",
          deal_id: null, deal_title: "",
          depot_id_left: String(CEX_DEPOT_FROM), depot_id_right: String(CEX_DEPOT_TO)
        }, rows: moveRows } };
      // Същата логика в точката: „Запиши и вкарай в склада" = `save_and_close`.
      const loadPayload = { Storeloads_save: {
        id: null, action_type: "save_and_close",
        values: {
          // Типът е „Друго" (3), не „Фактура" (1): прехвърлянето е ВЪТРЕШНО, в
          // една фирма, и фактура би твърдяла продажба. В списъка на Barsy няма
          // „Приемно-предавателен протокол", затова типът е „Друго", а името на
          // документа се носи от `doc_num` и от бележките.
          store_load_id: null, operation_type: "1", depot_id: String(SHOP_DEPOT), doc_type_id: "3",
          doc_date: today + " 00:00:00", doc_num: null,
          supplier_id: String(SHOP_SUPPLIER_ID), has_tax: 0, price_mode: 0, fill_delivery_price: 0,
          currency_id: "1", currency_rate: "1", store_load_cat_id: "1", discount: "0",
          total_costs: 0, description: "Прехвърляне от цеха (заявка " + id.slice(0, 8) + ")"
        }, rows: loadRows } };

      if (write) {
        // ── 1) ЦЕХ: прехвърляне Основен → Точка (документът за БАБХ) ──
        const mv = await cexRoot(movePayload);
        const mvSave = mv.data && mv.data.Storemoves_save;
        let mvId = (mvSave && (mvSave.id || mvSave.store_move_id)) || null;
        // Отговорът на Barsy не винаги носи id → вземаме най-новия документ.
        // Четем и СТАТУСА: 0 = чернова, 2 = изпратено (чака приемане, стоката
        // още не е преместена), 1 = приключено. Само 1 е истински успех — иначе
        // инструментът щеше да рапортува „готово" на документ, който нищо не е
        // преместил (точно това се случи на първия опит).
        let mvStatus = null;
        try {
          const lst = await cexCall("Storemoves_getlist", { filters: {} });
          const rows = Array.isArray(lst.data) ? lst.data : [];
          const last = rows.map(x => Number(x.store_move_id)).filter(Boolean).sort((a, b) => b - a)[0];
          if (last && !mvId) mvId = last;
          if (mvId) {
            const g = await cexCall("Storemoves_get", { id: mvId, store_move_id: mvId });
            mvStatus = g.data && g.data.status;
          }
        } catch (e) {}
        if (mv.ok && Number(mvStatus) !== 1) {
          const what = Number(mvStatus) === 2 ? "остана ИЗПРАТЕНО (чака приемане в склад Точка)" : "остана ЧЕРНОВА";
          await sbPatch(id, { status: "failed", cex_doc_id: mvId ? String(mvId) : null, error: "цех прехвърляне №" + mvId + " " + what + " — стоката НЕ е преместена" });
          res.status(200).json({ ok: false, step: "cex", cex_doc_id: mvId, error: "Цех прехвърляне №" + mvId + " " + what + ". Стоката НЕ е преместена и точката НЕ е заредена." });
          return;
        }
        if (!mv.ok || (mv.data && mv.data.error)) {
          await sbPatch(id, { status: "failed", error: "цех прехвърляне падна: " + String(mv.raw || "").slice(0, 300) });
          res.status(200).json({ ok: false, step: "cex", error: String(mv.raw || "").slice(0, 400) }); return;
        }
        // Връзката между двата документа — БАБХ тръгва оттук към прехвърлянето,
        // където всеки ред носи партидата си.
        if (mvId) {
          loadPayload.Storeloads_save.values.doc_num = "ППП-" + mvId;
          loadPayload.Storeloads_save.values.description =
            "Приемно-предавателен протокол №ППП-" + mvId
            + " · вътрешно прехвърляне цех → точка Каравелов (една фирма, не е продажба)"
            + " · цех прехвърляне №" + mvId + " · заявка " + id.slice(0, 8);
        }
        // ── 2) ТОЧКА: зареждане от „Мотамо - цех" ──
        // Цех документът вече е издаден; при провал тук заявката остава „partial"
        // и НЕ се трие автоматично — за БАБХ следата е по-важна от чистотата.
        const ld = await shopRoot(loadPayload);
        const ldSave = ld.data && ld.data.Storeloads_save;
        let ldId = (ldSave && (ldSave.id || ldSave.store_load_id)) || null;
        let ldStatus = null;
        try {
          const lst = await shopCall("Storeloads_getlist", { length: 5, order_by: "store_load_id desc", extra_properties: ["all"] });
          const rows = Array.isArray(lst.data) ? lst.data : [];
          const last = rows.sort((a, b) => Number(b.store_load_id) - Number(a.store_load_id))[0];
          if (last) { if (!ldId) ldId = last.store_load_id; if (Number(last.store_load_id) === Number(ldId)) ldStatus = last.status; }
        } catch (e) {}
        if (ld.ok && Number(ldStatus) !== 1) {
          await sbPatch(id, { status: "partial", cex_doc_id: mvId ? String(mvId) : null, shop_doc_id: ldId ? String(ldId) : null, processed_at: new Date().toISOString(), error: "точка зареждане №" + ldId + " остана ЧЕРНОВА — наличността в точката НЕ е вдигната" });
          res.status(200).json({ ok: false, step: "shop", cex_doc_id: mvId, shop_doc_id: ldId, error: "Цехът е преместен (№" + mvId + "), но зареждане №" + ldId + " в точката остана ЧЕРНОВА — наличността там НЕ е вдигната." });
          return;
        }
        if (!ld.ok || (ld.data && ld.data.error)) {
          await sbPatch(id, { status: "partial", cex_doc_id: mvId ? String(mvId) : "?", processed_at: new Date().toISOString(), error: "цехът е изписан, точката НЕ е заредена: " + String(ld.raw || "").slice(0, 300) });
          res.status(200).json({ ok: false, step: "shop", cex_doc_id: mvId, error: "Цехът е изписан (прехвърляне " + (mvId || "?") + "), но зареждането в точката падна: " + String(ld.raw || "").slice(0, 300) }); return;
        }
        // Записваме КОЛКО реално е тръгнало на всеки ред (точката вижда
        // „поиска 10, дойде 6") и отваряме НОВА заявка с остатъка, за да не се
        // забрави — решение на собственика.
        const itemsSent = items.map(it => ({ ...it, sent: sentBy[it.cex_id] != null ? sentBy[it.cex_id] : 0 }));
        const rest = itemsSent
          .map(it => ({ ...it, qty: round3(Number(it.qty) - Number(it.sent)) }))
          .filter(it => it.qty > 0.0005)
          .map(it => { const o = { ...it }; delete o.sent; return o; });
        let restId = null;
        if (rest.length) {
          const ins = await sbInsert({ for_date: today, status: "pending", items: rest, parent_id: id, note: "остатък от предишна заявка" });
          restId = ins.row && ins.row.id;
        }
        await sbPatch(id, { status: "done", items: itemsSent, cex_doc_id: mvId ? String(mvId) : null, shop_doc_id: ldId ? String(ldId) : null, processed_at: new Date().toISOString(), error: null });
        res.status(200).json({
          ok: true, dry: false, id, cex_doc_id: mvId, shop_doc_id: ldId, short, rest_id: restId, rest_count: rest.length,
          message: "✓ Готово: цех прехвърляне " + (mvId || "") + " (" + moveRows.length + " реда) → точка зареждане " + (ldId || "") + " (" + loadRows.length + " реда)."
            + (short.length ? " ⚠ " + short.join(" · ") : "")
            + (rest.length ? " Остатъкът (" + rest.length + " продукта) е в нова заявка." : "")
        });
        return;
      }

      res.status(200).json({
        ok: true, dry: true, id, move_rows: moveRows.length, load_rows: loadRows.length, short,
        message: "ПРЕГЛЕД: цех прехвърляне " + moveRows.length + " реда, точка зареждане " + loadRows.length + " реда."
          + (short.length ? " \u26a0 НЕДОСТИГ в цеха: " + short.join(" · ") : "")
          + " Натисни пак с Издай документите, за да се запише.",
        payloads: { move: movePayload, load: loadPayload }
      });
      return;
    }

    res.status(400).json({ ok: false, error: "unknown_action" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
};
