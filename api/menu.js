const SOURCES = {
  point: "https://motamoshop.barsyonline.menu/public/endpoints/json?",
  shop: "https://motamo.barsy.online/public/endpoints/json?"
};

// Barsy's own storefront builds product images from article_id via this endpoint
// (found in the storefront's JS bundle: getArticlesAvatarThumb). It returns the
// uploaded photo when one exists, or a graceful placeholder SVG when it doesn't —
// no dependency on the raw `picture` filename field, which isn't directly servable.
const IMAGE_BASE = {
  point: "https://motamoshop.barsyonline.menu/public/endpoints/res/Articles_getavatar",
  shop: "https://motamo.barsy.online/public/endpoints/res/Articles_getavatar"
};

// The −15% pickup pricelist covers food only. Alcohol is sold across the counter
// but is not offered online: quoting it at −15% makes Barsy reject the whole order
// („Подадената цена … се различава от очакваната"), and quoting it at full price next to
// discounted food is a different price rule on one screen. The owner's call: keep it
// off the site entirely.
// „ПРОМОЦИИ" holds the gift articles, priced 0.00 in Barsy. They must never appear
// as a menu tab — a category of free food is an invitation to fill a basket with it.
// They are hidden from the *catalogue* only: when the offers feature lands, the gift
// will reach the browser through its own field, granted by the server once the offer's
// condition is met, and never as something the customer can browse and add.
// Note this regex is menu.js's alone. `order.js` keeps its own, narrower one — adding
// ПРОМОЦИИ there would make the gift unorderable, which is the opposite of the point.
const HIDDEN_CATEGORY = /алкохол|промоции/i;

const { sortByProfit } = require("./costs");
const { allergensFor } = require("./allergens");
const { parseDescription } = require("./describe");

// Подредбата по печалба важи само за точката. Магазинният каталог е друг —
// други article_id, друг ценоразпис, себестойности за него няма — така че там
// редът остава този от касата, вместо да го подреждаме по налучкан разход.
const SORT_BY_PROFIT = { point: true, shop: false };

// Алергените са ключирани по article_id на точката. Магазинният каталог е друг —
// други id-та — така че там таблицата не важи и мълчанието е по-честно от чужд
// списък, залепен по съвпадащ номер.
const HAS_ALLERGENS = { point: true, shop: false };

const ALLOWED_ORIGIN = "https://motamo.bg";
const CACHE_SECONDS = 300;

// How long the CDN may keep serving the last good menu after it goes stale, while
// it refreshes in the background. It was 60s, which meant a Barsy outage longer
// than a minute left the site with no menu at all. A day of stale prices is a
// worse menu; an empty page is no menu — and Barsy is read fresh every 5 minutes
// anyway, so a customer sees a stale one only while Barsy is actually unreachable.
// The error paths below deliberately set no Cache-Control, so a failure is never
// what gets cached.
const STALE_SECONDS = 86400;

// The Каравелов 101 point runs a −15% pricelist that Barsy applies to guest
// orders, so the public catalogue price is not what such an order actually
// costs. api/order.js sends Barsy the discounted figure and Barsy rejects
// anything else, so the site has to display the same number or customers would
// be quoted a price the POS refuses. Mirrored here rather than imported because
// the two functions are deployed independently.
//
// Barsy rounds half-up at two decimals; the arithmetic stays in integer cents
// because 4.675 * 100 is 467.49999… in binary floating point.
// 0 от 24.08.2026 — виж бележката в order.js. `pickup_price` вече излиза null,
// така че картите показват една цена, което е и истината.
const DISCOUNT_PCT = { point: 0, shop: 0 };

function discounted(price, source) {
  const pct = DISCOUNT_PCT[source] || 0;
  const cents = Math.round(Number(price) * 100);
  if (!pct) return cents / 100;
  return Math.floor((cents * (100 - pct) + 50) / 100) / 100;
}

function mapArticle(a, source) {
  const base = Number(a.current_price);
  const pickup = discounted(base, source);
  // The avatar endpoint is keyed only by article_id, so replacing a product photo
  // in Barsy leaves the URL identical and browsers keep showing the old picture
  // for hours. Barsy stamps every article with `last_update`, which moves whenever
  // the article does — hanging it on the URL makes a new photo a new address.
  const stamp = typeof a.last_update === "string" ? a.last_update.replace(/\D/g, "") : "";
  const item = {
    id: a.article_id,
    name: a.article_name_public,
    // The menu deliberately quotes the full price. Showing the discounted one
    // everywhere would quietly turn it into the normal price — the discount
    // stops reading as a discount, and it is the number competitors see. The
    // saving belongs at checkout, as its own line.
    price: base,
    pickup_price: pickup === base ? null : pickup,
    // `description` остава суровото поле от Барси заради всичко, което вече го
    // чете. Разборът се добавя до него, а не вместо него.
    description: (a.description_ml && a.description_ml.bg_BG) || "",
    // Едни и същи полета за всеки артикул, извлечени от свободния текст в касата.
    // Липсващото е `null` — сайтът пропуска реда, вместо да рисува празен етикет.
    spec: parseDescription((a.description_ml && a.description_ml.bg_BG) || "", a.article_name_public),
    image: `${IMAGE_BASE[source]}?article_id=${a.article_id}&mode=fix&width=550`
      + (stamp ? `&v=${stamp}` : "")
  };
  // Три различни отговора, три различни стойности, защото сайтът ги показва
  // различно: масив = обявени; `null` = има ред, но неустановени → „попитай ни";
  // липсващ ключ = този каталог изобщо не носи алергени, така че сайтът не
  // изписва нищо. Слети в едно, магазинът щеше да пише „неустановени" на всеки
  // артикул — шум, който обезсмисля същото изречение там, където значи нещо.
  if (HAS_ALLERGENS[source]) item.allergens = allergensFor(a.article_id);
  return item;
}

function hasName(a) {
  return typeof a.article_name_public === "string" && a.article_name_public.trim().length > 0;
}

// ── „Учи менюто" (интерактивна обучителна страница за екипа) ──────────────────
function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }
function escH(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
// нормализирано име за съпоставяне (сет-описание ↔ артикул): маха пунктуация/интервали, слива MOTA/МОТА
function normName(s) { return String(s || "").toLowerCase().replace(/mota/g, "мота").replace(/[^a-zа-я0-9]/g, ""); }
function imgOf(a, source) {
  const stamp = typeof a.last_update === "string" ? a.last_update.replace(/\D/g, "") : "";
  return `${IMAGE_BASE[source]}?article_id=${a.article_id}&mode=fix&width=550` + (stamp ? `&v=${stamp}` : "");
}
// Сосове/подправки, разпознати от свободния текст (за „с кои сосове се прави")
const SAUCE_DICT = [
  ["спайси майонеза", "Спайси майонеза"], ["чеснов", "Чеснова майонеза"], ["японска майонеза", "Японска майонеза"],
  ["унаги", "Унаги сос"], ["терияки", "Терияки"], ["сладко чили", "Сладко чили"], ["сладък чили", "Сладко чили"],
  ["манго", "Манго сос"], ["икура", "Икура сос"], ["васаби", "Васаби"], ["шрирача", "Шрирача"], ["срирача", "Шрирача"],
  ["соев сос", "Соев сос"], ["теримайо", "Теримайо"], ["спайси", "Спайси сос"], ["майонеза", "Майонеза"]
];
function detectSauces(text) {
  const t = " " + String(text || "").toLowerCase() + " ";
  const out = [];
  for (const [k, label] of SAUCE_DICT) { if (t.includes(k) && !out.includes(label)) out.push(label); }
  // ако има конкретна майонеза, махни родовите „Майонеза"/„Спайси сос"
  const specific = out.some(l => /майонеза/.test(l) && l !== "Майонеза");
  return out.filter(l => !(specific && (l === "Майонеза")));
}
// „с/със" по правилото за благозвучие (със сьомга, със скарида; с пиле, с тон)
function withPrep(w) { return /^[сзСЗ]/.test(w) ? "със " + w : "с " + w; }
// Авто-обобщение на сет: разчита пълнежите на ролките → „6 вида, 3 с пиле, всички с крема сирене".
function buildSetSummary(components) {
  const n = components.length;
  const bites = components.reduce((a, c) => a + (c.count || 0), 0);
  const textOf = c => ((c.name || "") + " " + (c.lead || "") + " " + (c.composition || "")).toLowerCase();
  const PROT = [["пиле", "пиле"], ["сьомга", "сьомга"], ["тон", "тон"], ["скарид", "скарида"], ["рак", "раци"], ["змиорк", "змиорка"]];
  const COMM = [["крема сирене", "крема сирене"], ["крем сирене", "крема сирене"], ["авокадо", "авокадо"], ["краставиц", "краставица"], ["едамаме", "едамаме"], ["манго", "манго"]];
  const countLabel = (defs) => { const m = {}; for (const c of components) { const t = textOf(c); const hit = new Set(); for (const [k, l] of defs) { if (t.includes(k)) hit.add(l); } for (const l of hit) m[l] = (m[l] || 0) + 1; } return m; };
  const prot = countLabel(PROT), comm = countLabel(COMM);
  const out = [];
  out.push(`Сетът е от ${n} вида ролки · ${bites} хапки.`);
  const protParts = Object.keys(prot).sort((a, b) => prot[b] - prot[a]).map(l => `${prot[l]} ${withPrep(l)}`);
  if (protParts.length) out.push(`Протеини: ${protParts.join(", ")}.`);
  const commParts = [];
  for (const l of Object.keys(comm)) { const c = comm[l]; if (c === n && n > 1) commParts.push(`всички ${withPrep(l)}`); else if (c >= Math.ceil(n * 0.6) && c > 1) commParts.push(`повечето ${withPrep(l)}`); }
  if (commParts.length) { const s = commParts.join(", "); out.push(s.charAt(0).toUpperCase() + s.slice(1) + "."); }
  const sauces = []; for (const c of components) for (const s of (c.sauces || [])) if (!sauces.includes(s)) sauces.push(s);
  if (sauces.length) out.push(`Сосове в сета: ${sauces.join(", ")}.`);
  return out;
}
// Разбива „Състав: Х - 8 бр. Y - 4 бр. …" от описанието на сет → [{name,count}]
function parseSetComponents(rawDesc) {
  const txt = stripTags(rawDesc);
  const m = txt.match(/[Сс][ъь]?став\s*:?(.+?)(?:[Тт]егло|[Аа]лерг|$)/);
  const seg = m ? m[1] : txt;
  const out = [];
  const re = /([A-Za-zА-Яа-я][A-Za-zА-Яа-я .()/]*?)\s*[-–—]\s*(\d+)\s*бр/g;
  let x;
  while ((x = re.exec(seg)) !== null) { const name = x[1].replace(/\s+/g, " ").trim(); const count = parseInt(x[2], 10); if (name && count) out.push({ name, count }); }
  return out;
}
// Строи данните за обучителната страница от суровото дърво на каталога.
function buildLearn(categories, rootArticles, source) {
  const all = []; const seen = new Set();
  const push = (a, catName) => {
    if (!a || seen.has(a.article_id) || !hasName(a)) return;
    if (HIDDEN_CATEGORY.test(catName || "")) return;
    seen.add(a.article_id);
    const raw = (a.description_ml && a.description_ml.bg_BG) || a.description || "";
    const spec = parseDescription(raw, a.article_name_public);
    all.push({
      id: a.article_id, name: a.article_name_public, cat: catName || "Други",
      price: Number(a.current_price) || 0, image: imgOf(a, source),
      lead: spec.lead || "", composition: spec.composition || "", weight: spec.weight || null, count: spec.count || null,
      raw, allergens: (HAS_ALLERGENS[source] ? allergensFor(a.article_id) : null),
      sauces: detectSauces((spec.lead || "") + " " + (spec.composition || "") + " " + stripTags(raw))
    });
  };
  for (const e of categories) { const cn = (e.category && e.category.cat_name) || ""; for (const a of (e.articles || [])) push(a, cn); }
  for (const a of rootArticles) push(a, "Други");
  // индекс по нормализирано име
  const byNorm = {}; for (const it of all) { const n = normName(it.name); if (n && !byNorm[n]) byNorm[n] = it; }
  const findRoll = (name) => {
    const n = normName(name); if (byNorm[n]) return byNorm[n];
    // частично съвпадение (описанието понякога съкращава)
    let best = null; for (const it of all) { const in2 = normName(it.name); if (!in2) continue; if (in2.includes(n) || n.includes(in2)) { if (!best || Math.abs(in2.length - n.length) < Math.abs(normName(best.name).length - n.length)) best = it; } }
    return best;
  };
  // СЕТОВЕ = категория „Комбо" или име съдържа „сет"
  const isSet = (it) => /комбо/i.test(it.cat) || /сет/i.test(it.name);
  const sets = all.filter(isSet).map(s => {
    const comps = parseSetComponents(s.raw).map(c => {
      const r = findRoll(c.name);
      return { name: c.name, count: c.count, id: r ? r.id : null, image: r ? r.image : null,
        lead: r ? r.lead : "", composition: r ? r.composition : "", sauces: r ? r.sauces : [], allergens: r ? r.allergens : null };
    });
    const bites = comps.reduce((a, c) => a + (c.count || 0), 0);
    return { id: s.id, name: s.name, image: s.image, price: s.price, lead: s.lead, weight: s.weight, bites, components: comps, allergens: s.allergens, summary: buildSetSummary(comps) };
  }).sort((a, b) => b.price - a.price);
  // РОЛКИ = единичните артикули (не сетове), от ролковите категории
  const rollCats = /хосомаки|урамаки|футомаки|нигири|сашими/i;
  const rolls = all.filter(it => !isSet(it) && rollCats.test(it.cat)).sort((a, b) => a.name.localeCompare(b.name, "bg"));
  return { sets, rolls };
}
function learnPage(data) {
  const J = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO · Учи менюто</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;font:16px system-ui,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#14171a}
header{background:linear-gradient(135deg,#c8151f,#7a0c12);color:#fff;padding:14px 16px;position:sticky;top:0;z-index:10;box-shadow:0 2px 10px rgba(122,12,18,.3)}
header h1{margin:0;font-size:19px;font-weight:800}header .d{font-size:13px;opacity:.9;margin-top:2px}
.tabs{display:flex;gap:8px;margin-top:10px}
.tabs button{font:15px system-ui;font-weight:700;border:0;border-radius:20px;padding:8px 16px;cursor:pointer;background:rgba(255,255,255,.18);color:#fff}
.tabs button.on{background:#fff;color:#b3121b}
.wrap{max-width:1000px;margin:0 auto;padding:14px}
.search{width:100%;padding:11px 14px;border:0;border-radius:10px;font-size:16px;margin-top:10px;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.search:focus{outline:2px solid #fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(20,23,26,.08);cursor:pointer;transition:transform .1s}
.card:hover{transform:translateY(-2px)}
.card img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#eee}
.card .b{padding:9px 11px}.card .n{font-weight:800;font-size:15px;line-height:1.2}
.card .s{font-size:12px;color:#7a8087;margin-top:3px}
.back{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #d7dade;border-radius:20px;padding:8px 14px;font-weight:700;cursor:pointer;margin-bottom:12px;font-size:15px}
.hero{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(20,23,26,.1);margin-bottom:16px}
.hero img{width:100%;max-height:340px;object-fit:cover;display:block}
.hero .b{padding:14px 16px}.hero h2{margin:0 0 4px;font-size:22px}
.hero .meta{color:#b3121b;font-weight:800;font-size:15px}.hero p{color:#374151;line-height:1.4;margin:8px 0 0}
.sec{font-size:14px;font-weight:800;color:#7a8087;text-transform:uppercase;letter-spacing:.4px;margin:6px 2px 10px}
.roll{display:flex;gap:12px;background:#fff;border-radius:14px;box-shadow:0 2px 8px rgba(20,23,26,.08);padding:10px;margin-bottom:10px;align-items:flex-start}
.roll img{width:96px;height:96px;border-radius:10px;object-fit:cover;flex:0 0 auto;background:#eee}
.roll .rb{flex:1;min-width:0}.roll .rn{font-weight:800;font-size:16px}
.roll .cnt{display:inline-block;background:#fdecec;color:#b3121b;font-weight:800;font-size:13px;border-radius:8px;padding:1px 8px;margin-left:6px}
.roll .lead{color:#374151;font-size:14px;line-height:1.35;margin:4px 0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
.chip{background:#fff3e0;color:#b06a00;border:1px solid #f0d9b5;border-radius:14px;padding:3px 10px;font-size:12px;font-weight:700}
.chip.al{background:#eef3f8;color:#2b6ca3;border-color:#d3e2f0}
.tip{background:#eaf6ee;border:1px solid #bfe3c9;border-left:5px solid #0a6b2e;border-radius:12px;padding:12px 14px;margin-bottom:16px}
.tip .th{font-weight:800;color:#0a6b2e;margin-bottom:6px}
.tip ul{margin:0;padding-left:20px}.tip li{margin:3px 0;line-height:1.4}
.empty{color:#7a8087;text-align:center;padding:30px}
.lb{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:100;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}
.lb[hidden]{display:none}
.lb img{max-width:96%;max-height:88%;transform-origin:center center;user-select:none;-webkit-user-drag:none;touch-action:none}
.lb .x{position:absolute;top:14px;right:14px;width:50px;height:50px;border-radius:50%;border:0;background:rgba(255,255,255,.92);font-size:22px;font-weight:800;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.lb .ctrl{position:absolute;bottom:26px;left:50%;transform:translateX(-50%);display:flex;gap:14px}
.lb .ctrl button{width:58px;height:58px;border-radius:50%;border:0;background:rgba(255,255,255,.92);font-size:28px;font-weight:800;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4);line-height:1}
@media(max-width:520px){.hero img{max-height:260px}.roll img{width:76px;height:76px}}
</style></head><body>
<header><h1>🍣 MOTAMO · Учи менюто</h1><div class="d">Сетове и ролки · състав и сосове · за екипа</div>
<div class="tabs"><button id="tSets" class="on" onclick="tab('sets')">Сетове</button><button id="tRolls" onclick="tab('rolls')">Всички ролки</button></div>
<input class="search" id="q" placeholder="🔎 търси сет, ролка или съставка (напр. пиле, унаги, скарида)…" oninput="onSearch()"></header>
<div class="wrap"><div id="view"></div></div>
<div id="lb" class="lb" hidden><button class="x" onclick="closeLB()">✕</button><img id="lbimg" src="" alt=""><div class="ctrl"><button onclick="zoomLB(-0.5)">−</button><button onclick="zoomLB(0,true)" title="нулирай">⟳</button><button onclick="zoomLB(0.5)">+</button></div></div>
<script>
var SETS=${J(data.sets)};var ROLLS=${J(data.rolls)};var MODE='sets';var CUR=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function chips(sauces,al){var h='';(sauces||[]).forEach(function(s){h+='<span class="chip">🥢 '+esc(s)+'</span>'});(al||[]).forEach(function(a){h+='<span class="chip al">⚠ '+esc(a)+'</span>'});return h?'<div class="chips">'+h+'</div>':''}
function rollCard(r,count){var lead=r.lead||r.composition||'';var img=r.image?'<img src="'+esc(r.image)+'" loading="lazy" style="cursor:zoom-in" onclick="openLB(this.src)" onerror="this.style.visibility=\\'hidden\\'">':'<img>';
 return '<div class="roll">'+img+'<div class="rb"><div class="rn">'+esc(r.name||'?')+(count?'<span class="cnt">×'+count+'</span>':'')+'</div>'+(lead?'<div class="lead">'+esc(lead)+'</div>':'')+chips(r.sauces,r.allergens)+'</div></div>'}
function setDetail(s){var h='<button class="back" onclick="CUR=null;render()">‹ Назад</button>';
 h+='<div class="hero"><img src="'+esc(s.image)+'" style="cursor:zoom-in" onclick="openLB(this.src)" onerror="this.style.display=\\'none\\'"><div class="b"><h2>'+esc(s.name)+'</h2><div class="meta">'+(s.bites?s.bites+' хапки · ':'')+(s.weight?s.weight+' · ':'')+(s.price?s.price.toFixed(2)+' €':'')+'</div>'+(s.lead?'<p>'+esc(s.lead)+'</p>':'')+'</div></div>';
 if(s.summary&&s.summary.length){h+='<div class="tip"><div class="th">💡 За сета — кажи на клиента</div><ul>'+s.summary.map(function(t){return '<li>'+esc(t)+'</li>'}).join('')+'</ul></div>'}
 h+='<div class="sec">Ролки в сета ('+(s.components?s.components.length:0)+')</div>';
 if(s.components&&s.components.length){s.components.forEach(function(c){h+=rollCard(c,c.count)})}else{h+='<div class="empty">Няма разбивка на ролките за този сет.</div>'}
 return h}
function grid(items,isSet){if(!items.length)return '<div class="empty">Няма съвпадения.</div>';var h='<div class="grid">';items.forEach(function(it,i){var sub=isSet?((it.bites?it.bites+' хапки':'')+(it.price?' · '+it.price.toFixed(2)+' €':'')):(it.sauces&&it.sauces.length?it.sauces.slice(0,2).join(', '):(it.cat||''));
  h+='<div class="card" onclick="open'+(isSet?'Set':'Roll')+'('+i+')"><img src="'+esc(it.image)+'" loading="lazy" onerror="this.style.visibility=\\'hidden\\'"><div class="b"><div class="n">'+esc(it.name)+'</div><div class="s">'+esc(sub)+'</div></div></div>'});return h+'</div>'}
var FSETS=SETS,FROLLS=ROLLS;
function openSet(i){CUR=FSETS[i];render()}
function openRoll(i){CUR={roll:FROLLS[i]};render()}
function tab(m){MODE=m;CUR=null;document.getElementById('tSets').className=m==='sets'?'on':'';document.getElementById('tRolls').className=m==='rolls'?'on':'';render()}
function onSearch(){CUR=null;render()}
// ── Лайтбокс (уголемяване/зуум на снимка при клик) ──
var LBs=1,LBx=0,LBy=0,LBdrag=null,LBtap=0;
function lbApply(){var im=document.getElementById('lbimg');im.style.transform='translate('+LBx+'px,'+LBy+'px) scale('+LBs+')';im.style.cursor=LBs>1?'grab':'zoom-in'}
function openLB(src){if(!src)return;var lb=document.getElementById('lb');document.getElementById('lbimg').src=src;LBs=1;LBx=0;LBy=0;lbApply();lb.hidden=false}
function closeLB(){document.getElementById('lb').hidden=true}
function zoomLB(d,reset){if(reset){LBs=1;LBx=0;LBy=0}else{LBs=Math.round(Math.max(1,Math.min(4,LBs+d))*10)/10;if(LBs<=1){LBx=0;LBy=0}}lbApply()}
(function(){var lb=document.getElementById('lb'),im=document.getElementById('lbimg');
 lb.addEventListener('click',function(e){if(e.target===lb)closeLB()});
 lb.addEventListener('wheel',function(e){e.preventDefault();zoomLB(e.deltaY<0?0.4:-0.4)},{passive:false});
 im.addEventListener('click',function(){var n=Date.now();if(n-LBtap<300){if(LBs>1)zoomLB(0,true);else zoomLB(1)}LBtap=n});
 im.addEventListener('pointerdown',function(e){if(LBs<=1)return;LBdrag={x:e.clientX,y:e.clientY,ox:LBx,oy:LBy};try{im.setPointerCapture(e.pointerId)}catch(_){}});
 im.addEventListener('pointermove',function(e){if(!LBdrag)return;LBx=LBdrag.ox+(e.clientX-LBdrag.x);LBy=LBdrag.oy+(e.clientY-LBdrag.y);lbApply()});
 im.addEventListener('pointerup',function(){LBdrag=null});
 document.addEventListener('keydown',function(e){if(e.key==='Escape')closeLB()});
})();
function render(){var q=(document.getElementById('q').value||'').toLowerCase().trim();
 var v=document.getElementById('view');
 if(CUR&&CUR.roll){v.innerHTML='<button class="back" onclick="CUR=null;render()">‹ Назад</button><div class="hero"><img src="'+esc(CUR.roll.image)+'" style="cursor:zoom-in" onclick="openLB(this.src)" onerror="this.style.display=\\'none\\'"><div class="b"><h2>'+esc(CUR.roll.name)+'</h2>'+(CUR.roll.lead?'<p>'+esc(CUR.roll.lead)+'</p>':'')+(CUR.roll.composition?'<p><b>Състав:</b> '+esc(CUR.roll.composition)+'</p>':'')+chips(CUR.roll.sauces,CUR.roll.allergens)+'</div></div>';return}
 if(CUR){v.innerHTML=setDetail(CUR);return}
 function match(it){if(!q)return true;var s=(it.name||'')+' '+(it.lead||'')+' '+(it.composition||'')+' '+((it.sauces||[]).join(' '))+' '+((it.components||[]).map(function(c){return c.name}).join(' '));return s.toLowerCase().indexOf(q)>=0}
 if(MODE==='sets'){FSETS=SETS.filter(match);v.innerHTML=grid(FSETS,true)}else{FROLLS=ROLLS.filter(match);v.innerHTML=grid(FROLLS,false)}}
render();
</script></body></html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const source = req.query.source;
  const baseUrl = SOURCES[source];

  if (!baseUrl) {
    res.status(400).json({ error: 'Invalid or missing "source" parameter. Use "point" or "shop".' });
    return;
  }

  let barsyRes;
  try {
    barsyRes = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Categories_getalltree: {} })
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Barsy", details: err.message });
    return;
  }

  if (!barsyRes.ok) {
    res.status(502).json({ error: `Barsy responded with status ${barsyRes.status}` });
    return;
  }

  let data;
  try {
    data = await barsyRes.json();
  } catch (err) {
    res.status(502).json({ error: "Invalid JSON from Barsy" });
    return;
  }

  const tree = (data && data.Categories_getalltree) || {};
  const categories = tree.categories || [];
  const rootArticles = tree.articles || [];

  // „Учи менюто" — интерактивна обучителна страница (сет → ролки → състав/сосове).
  if (req.query.view === "learn") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`);
    res.status(200).send(learnPage(buildLearn(categories, rootArticles, source)));
    return;
  }

  // The root `category.cat_name` (e.g. "Меню Мотамо SHOP") is Barsy's internal
  // parent-container label, not a real menu category — only usable as an actual
  // category name when there ARE no subcategories (root articles are then the
  // whole menu). When subcategories exist, any leftover root-only article is an
  // uncategorized outlier and goes into a generic bucket instead.
  const rootCatName = categories.length > 0
    ? "Други"
    : (tree.category && tree.category.cat_name) || "Други";

  // Barsy repeats subcategory products inside the root `articles[]` array too,
  // but on sources with no subcategories at all (e.g. "shop") root articles
  // are the *only* place the catalog exists — so both must be read, deduped by id.
  const seenIds = new Set();
  const menu = [];

  categories.forEach(function (entry) {
    const cat = entry.category || {};
    const articles = entry.articles || [];
    // Hidden articles are still marked as seen, or Barsy's duplicate copies of them
    // in the root list would resurface under the generic bucket.
    const hidden = HIDDEN_CATEGORY.test(cat.cat_name || "");
    const items = [];
    articles.forEach(function (a) {
      if (seenIds.has(a.article_id)) return;
      seenIds.add(a.article_id);
      if (hidden) return;
      if (!hasName(a)) return;
      items.push(mapArticle(a, source));
    });
    if (items.length) {
      const name = cat.cat_name || "";
      menu.push({
        category: name,
        items: SORT_BY_PROFIT[source] ? sortByProfit(items, name) : items
      });
    }
  });

  const extraItems = [];
  rootArticles.forEach(function (a) {
    if (seenIds.has(a.article_id)) return;
    seenIds.add(a.article_id);
    if (!hasName(a)) return;
    extraItems.push(mapArticle(a, source));
  });
  if (extraItems.length) {
    menu.push({
      category: rootCatName,
      items: SORT_BY_PROFIT[source] ? sortByProfit(extraItems, rootCatName) : extraItems
    });
  }

  res.setHeader("Cache-Control", `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${STALE_SECONDS}`);
  res.status(200).json(menu);
};
