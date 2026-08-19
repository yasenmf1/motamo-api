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
const PICKUP_DISCOUNT_PCT = 15;

function discountedCents(baseCents) {
  return Math.floor((baseCents * (100 - PICKUP_DISCOUNT_PCT) + 50) / 100);
}

// Barsy accepts orders Mon–Fri 11:00–18:50 Europe/Sofia. Checked here rather
// than in the browser: a visitor's clock is not evidence, and the static site
// can sit in LiteSpeed's cache after the hours change.
const OPEN_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const OPEN_FROM_MIN = 11 * 60;
const OPEN_TO_MIN = 18 * 60 + 50;

// Caps stop fat-fingered quantity steppers and casual pranks from reaching the
// kitchen. Not a security boundary — Barsy's own storefront is public with the
// same capability — but they keep this channel from being the easy way to do
// damage.
const MAX_PER_LINE = 20;
const MAX_TOTAL_ITEMS = 50;
const MAX_ORDER_EUR = 200;
const MAX_NAME_LEN = 60;
const MAX_NOTE_LEN = 300;

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
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  const get = function (type) {
    const found = parts.find((p) => p.type === type);
    return found ? found.value : "";
  };
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

function isOpen() {
  const now = sofiaNow();
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

// Flatten Barsy's category tree into article_id → {name, price}. Same dedupe as
// api/menu.js: subcategory articles are repeated at root level.
function buildPriceMap(tree) {
  const map = new Map();
  const add = function (a) {
    if (!a || a.article_id == null || map.has(a.article_id)) return;
    const price = Number(a.current_price);
    if (!Number.isFinite(price) || price <= 0) return;
    const name = typeof a.article_name_public === "string" ? a.article_name_public.trim() : "";
    if (!name) return;
    map.set(a.article_id, { name: name, price: price });
  };
  (tree.categories || []).forEach((entry) => (entry.articles || []).forEach(add));
  (tree.articles || []).forEach(add);
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

  if (!isOpen()) {
    fail(res, 409, "closed", "Online ordering is closed right now");
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
  let baseCentsTotal = 0;
  let dueCentsTotal = 0;

  wanted.forEach(function (amount, articleId) {
    const article = priceMap.get(articleId);
    if (!article) {
      unavailable.push(articleId);
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

  // Accounts_create answers with the new account id.
  res.status(200).json({
    ok: true,
    ref: ref,
    total: dueTotal,
    base_total: baseTotal,
    discount_pct: PICKUP_DISCOUNT_PCT,
    payment: pay,
    account_id: typeof placed.data === "number" ? placed.data : (placed.data || null)
  });
};
