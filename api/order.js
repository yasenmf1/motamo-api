// Guest PICKUP checkout → Barsy POS (Каравелов 101).
//
// The browser never talks to Barsy directly. It posts a minimal cart here
// ({article_id, amount} only) and this function decides what the order costs:
// it re-fetches the live menu and prices every line server-side. Anything the
// client says about money is ignored.
//
// Orders arrive as an open Barsy account ("сметка") — the owner's staff work
// from that list, and Barsy drives its statuses („Чака одобрение" → „За
// обслужване" → …) from the register's „Режим на одобрение", which their admin
// configures. This is Barsy's „работен сценарий 2".
//
// It uses the AUTHENTICATED `Accounts_create` rather than the public
// `Publicorders_place` that produces the same kind of account without
// credentials, because only the authenticated call can carry the three things
// this checkout needs:
//   * `client_id` 2 („НА МЯСТО") — the one client the −15% pricelist lists, so
//     the discount actually applies;
//   * `uuid` — Barsy's own key for "избягване на дублиране на сметка", real
//     protection against a double submit rather than a disabled button;
//   * `account_alias` — a title, so web orders are identifiable at a glance in
//     the accounts list.
// `Accounts_place` is the wrong sibling: it runs the whole scenario including
// payment and closing, and these orders are paid on collection.
//
// Host note: the tenant lives at motamoshop.barsy.online. The .barsyonline.menu
// host is only the public menu frontend and authenticates *clients* (loyalty
// cards), which is why staff credentials are rejected there.

const crypto = require("crypto");

const BARSY_API = "https://motamoshop.barsy.online";
const BARSY_PUBLIC = "https://motamoshop.barsyonline.menu/public/endpoints/json?";
const ALLOWED_ORIGIN = "https://motamo.bg";

// MOTAMO SHOP === Каравелов 101; the two names are the same place.
const BARSY_ID = 1;

// Client 7 „Онлайн", created for this channel. Web orders used to go to client 1
// „Анонимен", Barsy's built-in guest, but that is a system record: its name,
// phone and e-mail are locked, and Barsy refuses to issue a public payment link
// for an account whose client has no e-mail — „Липсват задължителни данни за
// email на клиента!". Client 7 is an ordinary client, so it carries one, and the
// owner put it in the same −15% pricing rule — without that rule Barsy would
// price the rows at full catalogue price and reject the order.
const PICKUP_CLIENT_ID = 7;

// Kept in sync with the pricelist so the site can show the price the POS will
// charge. Barsy rounds half-up at two decimals — verified against every computed
// price in its own pricelist screen — so the arithmetic is done in integer
// cents to avoid binary-float surprises (4.675 * 100 is 467.49999… in JS).
// 0 от 24.08.2026. Дотогава каталогът носеше „доставъчната" цена, а ценоразпис
// „- 15%" при клиент 7 правеше цената за вземане. Сега в Барси стои самата цена
// за вземане и правилото е махнато, така че тук няма какво да се смъква — но
// сметките остават в цели стотинки, за да върне цената 0 % непроменена.
const PICKUP_DISCOUNT_PCT = 0;

function discountedCents(baseCents) {
  return Math.floor((baseCents * (100 - PICKUP_DISCOUNT_PCT) + 50) / 100);
}

// Barsy accepts orders Mon–Fri 11:00–18:50 Europe/Sofia. Checked here rather
// than in the browser: a visitor's clock is not evidence, and the static site
// can sit in LiteSpeed's cache after the hours change.
const OPEN_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

// Отделни неработни дни — обектът е затворен, макар да е делник. Датите са по
// Europe/Sofia. Същият списък стои и в `index.html`, но решението е тук: там
// сменя надписа, тук затваря вратата. Стара отворена страница иначе би пратила
// поръчка в ден, в който няма кой да я приготви, и клиентът щеше да дойде за
// нея. 28.08.2026 беше първият такъв ден и е махнат оттук, след като мина.
const CLOSED_DAYS = new Set(["2026-09-07", "2026-09-22"]);
const OPEN_FROM_MIN = 11 * 60;
const OPEN_TO_MIN = 18 * 60 + 50;

// Caps stop fat-fingered quantity steppers and casual pranks from reaching the
// kitchen. Not a security boundary — Barsy's own storefront is public with the
// same capability — but they keep this channel from being the easy way to do
// damage.
// Таван на бройката от един артикул. Различен по категория, по искане на
// собственика: поке върви на по-големи порции, сушито — не. Всичко извън поке пада
// на 7. Проверява се СЛЕД като знаем категорията (тя идва от менюто), затова тук
// стои и общ абсолютен таван за ранната валидация на входа.
const PER_LINE_POKE = 10;
const PER_LINE_DEFAULT = 7;
const POKE_CATEGORY = /поке|poke/i;
const MAX_PER_LINE = PER_LINE_POKE;      // абсолютният таван на входа = най-високият по категория
const MAX_TOTAL_ITEMS = 20;
const MAX_ORDER_EUR = 250;
const MAX_NAME_LEN = 60;
const MAX_NOTE_LEN = 300;

// Колко от този артикул е позволено — по категорията му.
function perLineLimit(category) {
  return POKE_CATEGORY.test(category || "") ? PER_LINE_POKE : PER_LINE_DEFAULT;
}

// The −15% pickup pricelist covers food only. Alcohol is sold across the counter
// but is not offered online: quoting it at −15% makes Barsy reject the whole order
// („Подадената цена … се различава от очакваната"), and quoting it at full price next to
// discounted food is a different price rule on one screen. The owner's call: keep it
// off the site entirely.
const HIDDEN_CATEGORY = /алкохол/i;

// Online card payment is off unless Vercel says otherwise. Barsy's ДСК settings are
// still on „Тестова среда", so a link produced today points at the bank's sandbox:
// a customer would „pay" with no money moving and the account would be marked paid.
// Flip ONLINE_CARD to "1" only once the merchant contract is live and Barsy is out
// of test mode.
const ONLINE_CARD = process.env.ONLINE_CARD === "1";

// ONLINE_CARD being off is a decision someone has to keep making. The failure it
// guards against is quiet and expensive: while Barsy's ДСК settings say
// „Тестова среда", every payment link points at the bank's sandbox, where a
// customer completes a payment, no money moves, and Barsy still marks the account
// settled. Whoever flips the flag one day will not be reading the comment above
// it, so the code checks the link itself rather than trusting the flag.
const SANDBOX_PAYMENT_HOSTS = [
  "uat.dskbank.bg",
  "vpostest.dskbank.bg",
  "test.dskbank.bg"
];

/* Спирачка срещу наводняване на касата.
 *
 * Всяка приета поръчка вдига „Чака одобрение" на екрана в кухнята. Скрипт, който
 * праща валидни поръчки в цикъл, не краде нищо — просто затрупва хората, докато
 * престанат да различават истинската поръчка от боклука.
 *
 * Помни се в паметта на инстанцията. Vercel вдига по няколко и ги приспива, така
 * че това НЕ е точен глобален лимит: разпределена атака или студен старт минават
 * покрай него. Хваща обаче случая, който реално се случва — един източник в
 * серия — и не струва нито външна услуга, нито ключ. Ако някой ден потрябва
 * твърда гаранция, тя се слага пред функцията (Vercel Firewall), не в нея.
 */
const RATE_WINDOW_MS = 10 * 60 * 1000;
// Офисите по Каравелов излизат в интернет през един адрес, така че обедът на
// цял етаж е десетина поръчки от „един" IP за няколко минути. Затова лимитът по
// адрес е висок — той цели скрипт, който би пратил стотици, не колеги, които
// поръчват заедно. Тесният лимит е по телефон: три поръчки от един номер за
// десет минути вече не е обяд.
const MAX_PER_IP = 20;
const MAX_PER_PHONE = 3;
const RATE_MAX_KEYS = 5000;          // таван на паметта, ако някой обикаля IP-та
const rateHits = new Map();

function rateCheck(key) {
  if (!key) return true;
  const now = Date.now();
  if (rateHits.size > RATE_MAX_KEYS) rateHits.clear();
  const fresh = (rateHits.get(key) || []).filter(function (t) { return now - t < RATE_WINDOW_MS; });
  rateHits.set(key, fresh);
  return fresh;
}

function rateExceeded(key, limit) {
  const fresh = rateCheck(key);
  return fresh === true ? false : fresh.length >= limit;
}

function rateRecord(key) {
  if (!key) return;
  const fresh = rateCheck(key);
  if (fresh !== true) fresh.push(Date.now());
}

function clientIp(req) {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return (req.headers && req.headers["x-real-ip"]) || null;
}

function sandboxHostOf(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    return null;
  }
  return SANDBOX_PAYMENT_HOSTS.find(function (h) {
    return host === h || host.endsWith("." + h);
  }) || null;
}

function isSandboxPaymentUrl(url) {
  return sandboxHostOf(url) !== null;
}

// The shop is not operating yet — the POS equipment is not installed and the
// packaging has not arrived — so the site must not take orders nobody can fill.
// Set ORDERS_OPEN=1 to open. PREVIEW_TOKEN lets the owner order anyway, so the
// checkout can be tested while the door is shut; the repository is public, so the
// token lives only in the environment.
const ORDERS_OPEN = process.env.ORDERS_OPEN === "1";
const PREVIEW_TOKEN = process.env.PREVIEW_TOKEN || "";

// „Карта site" — the only payment method the „Линк за плащане" public access offers.
// Naming it means Barsy skips its own chooser page, which is a dark generic screen
// with clip-art that the customer has no reason to see when there is nothing to
// choose between. Without it the link lands there first.
const CARD_PAYMETHOD_ID = 8;

// Колко дълго живее линкът за плащане. Barsy оставя 7 дни по подразбиране, което е
// далеч отвъд деня, в който някой е на касата. Поръчки се приемат до 18:50, а щандът
// затваря в 19:00: линк с недѐлен живот значи, че някой може да плати в 23:00 или на
// другата сутрин — звънецът за одобрение звъни в празен магазин и сметката стои
// платена, но неприключена. Един час стига на всеки, който наистина плаща (пренасочваме
// го веднага), и затваря опашката. Изтече ли линкът, поръчката не се губи — човекът
// плаща на касата, точно както при отказан линк.
const PAYMENT_LINK_EXP_HOURS = 1;

// „Вариант 1" — картовата поръчка влиза като КЛИЕНТСКА ЗАЯВКА, не като отворена
// сметка. Зад собствен флаг, за да е обратимо със смяна на env, без да пипа нито
// поръчките в брой, нито стария картов път.
//
// Защо: „Карта site" е фискален, затова плащането по отворена сметка печата
// фискален бон веднага, а по-късното затваряне на вече нулевия остатък печата
// СЛУЖЕБЕН бон — недопустим при продажба (писмо на БИМ до производителите на ФУ) и
// маркер за проверка пред НАП, при това по един на всяка картова поръчка.
// Клиентската заявка не е фискална операция; тя става сметка чак при
// `Accounts_createfromclientorder` с `flag_close_account=1` — сметката се ражда
// платена и затворена в едно действие и печата ЕДИН фискален бон. Второто го върши
// `api/order-settle.js`, след като плащането по заявката е потвърдено.
const ONLINE_CARD_V2 = process.env.ONLINE_CARD_V2 === "1";

const BARSY_TIMEOUT_MS = 8000;

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, code: code, message: message });
}

async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BARSY_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(barsyRes) {
  const text = await barsyRes.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    parsed = null;
  }
  return { status: barsyRes.status, ok: barsyRes.ok, data: parsed, raw: text };
}

// Public endpoint: action in the JSON envelope, no credentials.
function publicCall(action, params) {
  return withTimeout(async function (signal) {
    const barsyRes = await fetch(BARSY_PUBLIC, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ [action]: params }),
      signal: signal
    });
    return readResponse(barsyRes);
  });
}

// Authenticated endpoint: action in the URL path, bare params as the body.
// A different shape from the public one — sending the envelope here answers
// "Няма подаден екшън".
function authedCall(action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async function (signal) {
    const barsyRes = await fetch(`${BARSY_API}/endpoints/json/${action}?bid=${BARSY_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify(params),
      signal: signal
    });
    return readResponse(barsyRes);
  });
}

function sofiaNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Sofia",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = function (type) {
    const found = parts.find((p) => p.type === type);
    return found ? found.value : "";
  };
  return {
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    date: get("year") + "-" + get("month") + "-" + get("day")
  };
}

function isOpen() {
  const now = sofiaNow();
  if (CLOSED_DAYS.has(now.date)) return false;
  if (!OPEN_DAYS.has(now.weekday)) return false;
  return now.minutes >= OPEN_FROM_MIN && now.minutes <= OPEN_TO_MIN;
}

// Bulgarians type their mobile every which way: 0888 123 456, +359 88 812 3456,
// 00359…, with spaces, dashes and slashes. Normalise, then judge. This filters
// typos, not liars.
function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("359")) digits = "0" + digits.slice(3);
  if (/^08\d{8}$/.test(digits)) return digits;
  return null;
}

function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLen);
}

function hasLetters(value) {
  return /\p{L}/u.test(value);
}

// The browser generates the reference before sending, so it still knows the code
// when our response is lost on a flaky connection. We only sanity-check the
// shape and fall back to our own.
// `W-7K3QD` today. The old `WEB-…-…` shape is still accepted because a copy of the
// previous page can sit in LiteSpeed's cache for a while after a deploy.
const REF_PATTERN = /^(W-[A-Z0-9]{4,8}|WEB-[A-Z0-9]{4,12}-[A-Z0-9]{2,8})$/;

function makeRef(clientRef) {
  if (typeof clientRef === "string" && REF_PATTERN.test(clientRef)) return clientRef;
  const stamp = Math.floor(Date.now() / 60000).toString(36).toUpperCase().slice(-2);
  const rand = ("00" + Math.floor(Math.random() * 46656).toString(36).toUpperCase()).slice(-3);
  return `W-${stamp}${rand}`;
}

// Barsy validates `uuid` as a real UUID — handing it our own reference earns
// "Некоректна дата … (id:UUID)". Derive one from the reference instead of
// generating a random one, so a retry carrying the same reference produces the
// same uuid and Barsy's duplicate guard actually catches it.
function refToUuid(ref) {
  // Scoped to the day. A short reference is readable but its space is small, and
  // two orders months apart landing on the same code would otherwise hash to the
  // same uuid and be merged by Barsy's duplicate guard. Within one day a repeat is
  // vanishingly unlikely, and a retry seconds later still produces the same uuid,
  // which is the whole point of deriving it.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());
  const hex = crypto.createHash("sha1").update(`${day}|${ref}`).digest("hex");
  const version = "5" + hex.slice(13, 16);              // version nibble
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  return [hex.slice(0, 8), hex.slice(8, 12), version, variant, hex.slice(20, 32)].join("-");
}

// Flatten Barsy's category tree into article_id → {name, price, category}. Same
// dedupe as api/menu.js: subcategory articles are repeated at root level. The
// category rides along so the per-line limit can differ by it (поке vs суши).
function buildPriceMap(tree) {
  const map = new Map();

  // Anything the site does not sell must not be orderable either, whatever a
  // crafted request asks for. Barsy repeats subcategory articles in the root
  // list, so collect the hidden ids first and skip them in both passes.
  const hiddenIds = new Set();
  (tree.categories || []).forEach(function (entry) {
    const name = (entry.category && entry.category.cat_name) || "";
    if (!HIDDEN_CATEGORY.test(name)) return;
    (entry.articles || []).forEach(function (a) {
      if (a && a.article_id != null) hiddenIds.add(a.article_id);
    });
  });

  const add = function (a, category) {
    if (!a || a.article_id == null || map.has(a.article_id)) return;
    if (hiddenIds.has(a.article_id)) return;
    const price = Number(a.current_price);
    if (!Number.isFinite(price) || price <= 0) return;
    const name = typeof a.article_name_public === "string" ? a.article_name_public.trim() : "";
    if (!name) return;
    map.set(a.article_id, { name: name, price: price, category: category || "" });
  };
  // First the categorised pass, so each article keeps its own category; the root
  // pass only mops up anything a category did not already claim (dupes are skipped
  // by map.has, so they never overwrite the category set here).
  (tree.categories || []).forEach(function (entry) {
    const cat = (entry.category && entry.category.cat_name) || "";
    (entry.articles || []).forEach((a) => add(a, cat));
  });
  (tree.articles || []).forEach((a) => add(a, ""));
  return map;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    fail(res, 405, "method_not_allowed", "Method not allowed");
    return;
  }

  const user = process.env.BARSY_USER;
  const pass = process.env.BARSY_PASS;
  if (!user || !pass) {
    fail(res, 500, "not_configured", "Barsy credentials are not configured");
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (err) {
      fail(res, 400, "bad_json", "Malformed request body");
      return;
    }
  }
  if (!body || typeof body !== "object") {
    fail(res, 400, "bad_request", "Missing request body");
    return;
  }

  // --- who is ordering -----------------------------------------------------
  const name = sanitizeText(body.name, MAX_NAME_LEN);
  if (name.length < 2 || !hasLetters(name)) {
    fail(res, 400, "invalid_name", "Invalid name");
    return;
  }

  const phone = normalizePhone(body.phone);
  if (!phone) {
    fail(res, 400, "invalid_phone", "Invalid phone number");
    return;
  }

  // The site shows the terms and privacy checkboxes; refuse if they did not
  // actually come back ticked.
  if (body.consent !== true) {
    fail(res, 400, "consent_required", "Terms must be accepted");
    return;
  }

  const note = sanitizeText(body.note, MAX_NOTE_LEN);

  // Cash or card, both paid at the counter — nothing is charged online yet. The
  // kitchen needs to know which, so the terminal is ready when the customer
  // arrives. A cached copy of the old page sends nothing; treat that as cash
  // rather than refusing an otherwise valid order.
  const pay = body.pay === "card" ? "card" : "cash";
  if (body.pay != null && body.pay !== "card" && body.pay !== "cash") {
    fail(res, 400, "invalid_payment", "Invalid payment method");
    return;
  }

  // --- what is being ordered ----------------------------------------------
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || items.length === 0) {
    fail(res, 400, "empty_cart", "Cart is empty");
    return;
  }
  if (items.length > MAX_TOTAL_ITEMS) {
    fail(res, 400, "cart_too_large", "Too many distinct items");
    return;
  }

  const wanted = new Map();
  for (const item of items) {
    const articleId = Number(item && item.article_id);
    const amount = Number(item && item.amount);
    if (!Number.isInteger(articleId) || articleId <= 0) {
      fail(res, 400, "invalid_item", "Invalid item");
      return;
    }
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_PER_LINE) {
      fail(res, 400, "invalid_amount", "Invalid quantity");
      return;
    }
    const running = (wanted.get(articleId) || 0) + amount;
    if (running > MAX_PER_LINE) {
      fail(res, 400, "invalid_amount", "Invalid quantity");
      return;
    }
    wanted.set(articleId, running);
  }

  let totalItems = 0;
  wanted.forEach((amount) => (totalItems += amount));
  if (totalItems > MAX_TOTAL_ITEMS) {
    fail(res, 400, "cart_too_large", "Too many items");
    return;
  }

  const previewing = PREVIEW_TOKEN !== "" && body.preview === PREVIEW_TOKEN;

  if (!ORDERS_OPEN && !previewing) {
    fail(res, 409, "not_launched", "Online ordering has not started yet");
    return;
  }

  if (!isOpen() && !previewing) {
    fail(res, 409, "closed", "Online ordering is closed right now");
    return;
  }

  // Проверява се СЛЕД валидацията и ПРЕДИ Барси: боклукът пада по-рано и на
  // по-евтино, а бройката се вдига само за заявка, която иначе би станала
  // поръчка. Собственикът в режим на преглед не се брои — той тества.
  const ip = clientIp(req);
  if (!previewing && (rateExceeded(ip, MAX_PER_IP) || rateExceeded(phone, MAX_PER_PHONE))) {
    console.error(JSON.stringify({ event: "rate_limited", client_ref: String(body.ref || "").slice(0, 20) }));
    fail(res, 429, "too_many_orders", "Too many orders in a short time");
    return;
  }

  // --- price it from the live menu, never from the browser ------------------
  let menuRes;
  try {
    menuRes = await publicCall("Categories_getalltree", {});
  } catch (err) {
    fail(res, 503, "barsy_unreachable", "Could not reach Barsy");
    return;
  }
  if (!menuRes.ok || !menuRes.data || !menuRes.data.Categories_getalltree) {
    fail(res, 503, "barsy_unreachable", "Could not read the menu from Barsy");
    return;
  }

  const priceMap = buildPriceMap(menuRes.data.Categories_getalltree);

  const rows = [];
  const unavailable = [];
  const overLimit = [];
  let baseCentsTotal = 0;
  let dueCentsTotal = 0;

  wanted.forEach(function (amount, articleId) {
    const article = priceMap.get(articleId);
    if (!article) {
      unavailable.push(articleId);
      return;
    }
    // Таван на бройката по категория (поке 10, останалото 7). Прилага се тук,
    // защото категорията идва от менюто, което вече е изтеглено. Входната
    // валидация вече е спряла всичко над абсолютния таван; това стяга под него.
    const lineMax = perLineLimit(article.category);
    if (amount > lineMax) {
      overLimit.push({ article_id: articleId, name: article.name, max: lineMax });
      return;
    }
    const unitBaseCents = Math.round(article.price * 100);
    const unitDueCents = discountedCents(unitBaseCents);
    baseCentsTotal += unitBaseCents * amount;
    dueCentsTotal += unitDueCents * amount;

    // Barsy expects the price its own pricelist computes for this client and
    // refuses the order otherwise ("Вашата роля няма право да променя
    // продажната цена"), quoting both figures. That refusal is a feature: the
    // price the site showed and the price the POS charges cannot silently
    // diverge — if our arithmetic ever drifts from the pricelist, the order
    // fails loudly instead of charging the customer something else.
    rows.push({
      article_id: articleId,
      amount: amount,
      original_current_price: unitDueCents / 100
    });
  });

  // A stale localStorage cart from days ago is the common case. Refuse the whole
  // order and let the customer re-confirm rather than silently dropping a line.
  if (unavailable.length) {
    res.status(409).json({
      ok: false,
      code: "cart_out_of_date",
      message: "Some items are no longer available",
      unavailable: unavailable
    });
    return;
  }

  // Твърде много от един артикул — казваме кой и колко е таванът, за да свали
  // бройката вместо да гадае. Сървърна преграда: и да е пипана количката в
  // браузъра, тук не минава.
  if (overLimit.length) {
    res.status(400).json({
      ok: false,
      code: "quantity_over_limit",
      message: "Too many of an item",
      over_limit: overLimit
    });
    return;
  }

  const baseTotal = Number((baseCentsTotal / 100).toFixed(2));
  const dueTotal = Number((dueCentsTotal / 100).toFixed(2));
  if (dueTotal <= 0) {
    fail(res, 400, "empty_cart", "Cart is empty");
    return;
  }
  if (baseTotal > MAX_ORDER_EUR) {
    fail(res, 400, "order_too_large", "Order total is too large");
    return;
  }

  // --- place it ------------------------------------------------------------
  const ref = makeRef(body.ref);
  const payLabel = pay === "card" ? "С КАРТА" : "В БРОЙ";

  // ── Вариант 1: картовата поръчка като клиентска заявка (зад ONLINE_CARD_V2) ──
  // Само за карта; в брой продължава надолу като отворена сметка, платена на
  // касата. Заявката не е фискална операция — фискализацията идва чак при
  // превръщането ѝ в сметка в `api/order-settle.js`, така служебният бон отпада.
  if (ONLINE_CARD_V2 && pay === "card") {
    // Редът на заявката носи `original_price` (сметката ползва
    // `original_current_price` — различно поле, същата стойност).
    const orderRows = rows.map(function (r) {
      return { article_id: r.article_id, amount: r.amount, original_price: r.original_current_price };
    });
    const orderObj = {
      client_id: PICKUP_CLIENT_ID,
      // Нашият W-XXXXX като външен номер на заявката.
      order_num: ref,
      contact_name: name,
      client_tel: phone,
      // Печата се на фискалната бележка при превръщането в сметка.
      description: `Поръчка ${ref} · ВЗЕМАНЕ ОТ МЯСТО`,
      // Бележката на клиента — не се печата.
      public_notes: note || "",
      // Вземане от място, без доставка — както при отворената сметка.
      delivery_address: { delivery_type: "no" }
    };

    let zayavka;
    try {
      zayavka = await authedCall("Clientorders_create", { order: orderObj, rows: orderRows }, user, pass);
    } catch (err) {
      res.status(504).json({
        ok: false, code: "uncertain",
        message: "No response from Barsy — the order may have been placed", ref: ref
      });
      return;
    }
    if (!zayavka.ok) {
      console.error(JSON.stringify({
        event: "clientorder_rejected", ref: ref, status: zayavka.status,
        due_total: dueTotal, rows: orderRows,
        barsy: typeof zayavka.raw === "string" ? zayavka.raw.slice(0, 600) : null
      }));
      res.status(502).json({
        ok: false, code: "barsy_rejected",
        message: typeof zayavka.raw === "string" ? zayavka.raw.slice(0, 300) : "Barsy rejected the order", ref: ref
      });
      return;
    }

    if (!previewing) {
      rateRecord(ip);
      rateRecord(phone);
    }

    const clientOrderId = typeof zayavka.data === "number"
      ? zayavka.data
      : (zayavka.data && (zayavka.data.client_order_id || zayavka.data.id)) || null;

    // Линк за плащане по заявката — същият механизъм като по сметка, само
    // адресиран към `client_order_id`. `paymethod_id` 8 „Карта site" пропуска
    // избора; `exp_hours` 1 — линкът умира до час.
    let paymentUrl = null;
    if (clientOrderId) {
      try {
        const link = await authedCall(
          "Clientorders_getpaymentlink",
          { client_order_id: clientOrderId, paymethod_id: CARD_PAYMETHOD_ID, exp_hours: PAYMENT_LINK_EXP_HOURS },
          user, pass
        );
        const url = typeof link.data === "string" ? link.data.trim() : "";
        if (link.ok && /^https:\/\//.test(url) && !isSandboxPaymentUrl(url)) {
          paymentUrl = url;
        } else if (link.ok && isSandboxPaymentUrl(url)) {
          console.error(JSON.stringify({
            event: "clientorder_paymentlink_sandbox_refused", ref: ref,
            client_order_id: clientOrderId, host: sandboxHostOf(url)
          }));
        } else {
          console.error(JSON.stringify({
            event: "clientorder_paymentlink_failed", ref: ref, client_order_id: clientOrderId,
            status: link.status, barsy: typeof link.raw === "string" ? link.raw.slice(0, 1500) : null
          }));
        }
      } catch (err) {
        console.error(JSON.stringify({
          event: "clientorder_paymentlink_error", ref: ref, client_order_id: clientOrderId, message: String(err && err.message)
        }));
      }
    }

    // Тук линкът НЕ е по избор, за разлика от отворената сметка: заявка без
    // плащане не влиза в списъка със сметки и кухнята не я вижда. Без линк не
    // потвърждаваме поръчката — заявката стои неплатена (безвредна, не е фискална
    // операция) и клиентът опитва пак. (Заслужава по-мек резерв — превръщане в
    // отворена сметка за плащане на касата — но не преди пътят да е доказан.)
    if (!paymentUrl) {
      res.status(502).json({
        ok: false, code: "paymentlink_required",
        message: "Card order needs an online payment link, which could not be created", ref: ref
      });
      return;
    }

    // Логваме id-то на заявката — успехът иначе не оставя следа, а то ни трябва,
    // за да превърнем платената заявка в сметка (`api/order-settle.js`).
    console.error(JSON.stringify({
      event: "clientorder_placed", ref: ref, client_order_id: clientOrderId, due_total: dueTotal
    }));

    res.status(200).json({
      ok: true,
      ref: ref,
      total: dueTotal,
      base_total: baseTotal,
      discount_pct: PICKUP_DISCOUNT_PCT,
      payment: pay,
      client_order_id: clientOrderId,
      online_payment_url: paymentUrl
    });
    return;
  }

  const payload = {
    account: {
      // Barsy's own duplicate guard. Two requests carrying the same uuid are one
      // account, which is stronger than anything the browser can promise on a
      // dropped connection.
      uuid: refToUuid(ref),
      client_id: PICKUP_CLIENT_ID,
      contact_name: name,
      phone: phone,
      // The title in the accounts list. It carries the customer's name so staff
      // know whose order it is without opening it; the „ОНЛАЙН" prefix keeps web
      // orders recognisable at a glance. The reference stays in `description`,
      // which is what prints on the receipt.
      // Barsy's own „начин на плащане" cannot be set here: the only way to name
      // one is the `payments` array, which settles and closes the account on
      // creation. So the choice is written where staff will read it — the title
      // in the accounts list, and the first line of the notes.
      account_alias: `ОНЛАЙН ${name} · ${payLabel}`,
      // Prints on the fiscal receipt, so it is short and says what it is.
      description: `Поръчка ${ref} · ВЗЕМАНЕ ОТ МЯСТО`,
      // What the customer typed goes in `notes`, the field the staff actually
      // read on the account. It used to be appended to `description` and the
      // owner never saw it there; the IP that sat here instead told nobody in
      // the kitchen anything.
      notes: note ? `Плащане: ${payLabel}\n${note}` : `Плащане: ${payLabel}`,
      delivery_address: { delivery_type: "no" }
    },
    rows: rows
    // No payments: the customer pays on collection. Sending one settles and
    // closes the account the moment it is created.
  };

  let placed;
  try {
    placed = await authedCall("Accounts_create", payload, user, pass);
  } catch (err) {
    // The order may or may not have landed. The client must be told to call
    // rather than blindly retry.
    res.status(504).json({
      ok: false,
      code: "uncertain",
      message: "No response from Barsy — the order may have been placed",
      ref: ref
    });
    return;
  }

  if (!placed.ok) {
    // The customer only ever sees „Кухнята не отговаря", which tells us nothing an
    // hour later. Barsy names the reason — a price that no longer matches its
    // pricelist, a missing article, a right the API user lost — so put it in the
    // function log. The reference and the priced lines go with it; the customer's
    // name and phone deliberately do not.
    console.error(JSON.stringify({
      event: "barsy_rejected",
      ref: ref,
      status: placed.status,
      client_id: PICKUP_CLIENT_ID,
      due_total: dueTotal,
      rows: rows,
      barsy: typeof placed.raw === "string" ? placed.raw.slice(0, 600) : null
    }));
    res.status(502).json({
      ok: false,
      code: "barsy_rejected",
      message: typeof placed.raw === "string" ? placed.raw.slice(0, 300) : "Barsy rejected the order",
      ref: ref
    });
    return;
  }

  // Броим чак сега, когато поръчката наистина е в касата. Отказана от Барси не
  // е натоварила никого и не бива да изяжда квотата на човек, който после ще
  // поръча както трябва.
  if (!previewing) {
    rateRecord(ip);
    rateRecord(phone);
  }

  // Accounts_create answers with the new account id.
  const accountId = typeof placed.data === "number"
    ? placed.data
    : (placed.data && placed.data.account_id) || null;

  // `Accounts_getpaymentlink` returns a one-off public URL for the remaining amount
  // on the account. The payment method is left unset on purpose: the public access
  // record offers only „Карта site", so there is nothing to choose between.
  //
  // A failure here must not fail the order — the account already exists and the food
  // will be made. The customer simply gets the ordinary confirmation and pays at the
  // counter, which is what every order did until now.
  let paymentUrl = null;
  if (ONLINE_CARD && pay === "card" && accountId) {
    try {
      const link = await authedCall(
        "Accounts_getpaymentlink",
        {
          account_id: accountId,
          paymethod_id: CARD_PAYMETHOD_ID,
          exp_hours: PAYMENT_LINK_EXP_HOURS
        },
        user, pass
      );
      const url = typeof link.data === "string" ? link.data.trim() : "";
      if (link.ok && /^https:\/\//.test(url) && !isSandboxPaymentUrl(url)) {
        paymentUrl = url;
      } else if (link.ok && isSandboxPaymentUrl(url)) {
        // Barsy is still on „Тестова среда": this link leads to the bank's
        // sandbox, where a customer „pays" and the account is marked settled
        // with no money moving. Refuse it and let them pay at the counter —
        // the order itself is already placed and the food gets made.
        console.error(JSON.stringify({
          event: "paymentlink_sandbox_refused",
          ref: ref,
          account_id: accountId,
          host: sandboxHostOf(url)
        }));
      } else {
        console.error(JSON.stringify({
          event: "paymentlink_failed",
          ref: ref,
          account_id: accountId,
          status: link.status,
          barsy: typeof link.raw === "string" ? link.raw.slice(0, 1500) : null
        }));
      }
    } catch (err) {
      console.error(JSON.stringify({
        event: "paymentlink_error", ref: ref, account_id: accountId, message: String(err && err.message)
      }));
    }
  }

  res.status(200).json({
    ok: true,
    ref: ref,
    total: dueTotal,
    base_total: baseTotal,
    discount_pct: PICKUP_DISCOUNT_PCT,
    payment: pay,
    account_id: accountId,
    online_payment_url: paymentUrl
  });
};
