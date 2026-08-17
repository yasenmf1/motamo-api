// Guest PICKUP checkout → Barsy POS (Каравелов 101).
//
// The browser never talks to Barsy directly. It posts a minimal cart here
// ({article_id, amount} only) and this function is the one that decides what
// the order actually costs: it re-fetches the live menu from Barsy and prices
// every line server-side. Anything the client says about money is ignored.
//
// Barsy's public endpoint takes guest orders unauthenticated via
// `Publicorders_place` — same host and path the menu already uses, no
// credentials involved. Pickup is expressed as delivery_address.delivery_type
// = "no" ("home" would be delivery, which this endpoint deliberately refuses).

const BARSY_ENDPOINT = "https://motamoshop.barsyonline.menu/public/endpoints/json?";
const ALLOWED_ORIGIN = "https://motamo.bg";

// Read back from Barsy: 1 = "В брой", 2 = "Карта". Prices are in EUR.
const PAYMENT_METHODS = { 1: "cash", 2: "card" };

// Barsy accepts public orders Mon–Fri 11:00–18:50 Europe/Sofia. The check must
// live here rather than in the browser: a visitor's clock and timezone are not
// evidence of anything, and the static site can sit in LiteSpeed's cache for a
// while after the hours change.
const OPEN_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);
const OPEN_FROM_MIN = 11 * 60;
const OPEN_TO_MIN = 18 * 60 + 50;

// Caps exist to stop fat-fingered quantity steppers and casual pranks from
// reaching the kitchen. They are not a security boundary — Barsy's own
// storefront is publicly reachable with the same capability — but they do keep
// this new channel from being the easy way to do damage.
const MAX_PER_LINE = 20;
const MAX_TOTAL_ITEMS = 50;
const MAX_ORDER_EUR = 200;
const MAX_NAME_LEN = 60;
const MAX_NOTE_LEN = 300;

// Vercel kills the function at 10s; stay under it so a slow Barsy produces our
// own explainable error instead of an opaque platform 504.
const BARSY_TIMEOUT_MS = 8000;

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, code: code, message: message });
}

async function barsyCall(action, params) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, BARSY_TIMEOUT_MS);

  try {
    const barsyRes = await fetch(BARSY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ [action]: params }),
      signal: controller.signal
    });

    const text = await barsyRes.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = null;
    }
    return { status: barsyRes.status, ok: barsyRes.ok, data: parsed, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

// Europe/Sofia wall clock via Intl, so DST switches are handled by the runtime's
// timezone database instead of hand-rolled offset arithmetic.
function sofiaNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Sofia",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const get = function (type) {
    const found = parts.find(function (p) {
      return p.type === type;
    });
    return found ? found.value : "";
  };

  return {
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute"))
  };
}

function isOpen() {
  const now = sofiaNow();
  if (!OPEN_DAYS.has(now.weekday)) return false;
  return now.minutes >= OPEN_FROM_MIN && now.minutes <= OPEN_TO_MIN;
}

// Bulgarians type their mobile every which way: 0888 123 456, +359 88 812 3456,
// 00359..., with spaces, dashes and slashes. Normalise to 08XXXXXXXX and only
// then judge it. This filters typos, not liars — a determined prankster can
// always supply a real-looking number.
function normalizePhone(raw) {
  if (typeof raw !== "string") return null;

  let digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("359")) digits = "0" + digits.slice(3);

  // Bulgarian mobile numbers are 10 digits and begin 08.
  if (/^08\d{8}$/.test(digits)) return digits;
  return null;
}

function sanitizeText(value, maxLen) {
  if (typeof value !== "string") return "";
  // Strip control characters so nothing odd reaches the kitchen ticket.
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLen);
}

function hasLetters(value) {
  return /\p{L}/u.test(value);
}

// One reference per attempt, echoed into the order description. When the
// response gets lost on a flaky phone connection this is what lets the customer
// and the kitchen identify the same order over the phone instead of guessing.
//
// The browser generates it and sends it along, precisely so it still knows the
// code when our response never arrives. We only sanity-check the shape and fall
// back to our own if the client sent nothing usable.
const REF_PATTERN = /^WEB-[A-Z0-9]{4,12}-[A-Z0-9]{2,8}$/;

function makeRef(clientRef) {
  if (typeof clientRef === "string" && REF_PATTERN.test(clientRef)) return clientRef;
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `WEB-${stamp}-${rand}`;
}

// Flatten Barsy's category tree into article_id → {name, price}. Same dedupe
// logic as api/menu.js: subcategory articles are repeated at root level, and on
// sources without subcategories the root array is the whole catalogue.
function buildPriceMap(tree) {
  const map = new Map();

  const add = function (a) {
    if (!a || a.article_id == null) return;
    if (map.has(a.article_id)) return;
    const price = Number(a.current_price);
    if (!Number.isFinite(price) || price <= 0) return;
    const name = typeof a.article_name_public === "string" ? a.article_name_public.trim() : "";
    if (!name) return;
    map.set(a.article_id, { name: name, price: price });
  };

  (tree.categories || []).forEach(function (entry) {
    (entry.articles || []).forEach(add);
  });
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

  const payId = Number(body.pay_id);
  if (!PAYMENT_METHODS[payId]) {
    fail(res, 400, "invalid_payment", "Invalid payment method");
    return;
  }

  const note = sanitizeText(body.note, MAX_NOTE_LEN);

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
    // Tolerate a client that sends the same article twice instead of merging.
    const running = (wanted.get(articleId) || 0) + amount;
    if (running > MAX_PER_LINE) {
      fail(res, 400, "invalid_amount", "Invalid quantity");
      return;
    }
    wanted.set(articleId, running);
  }

  let totalItems = 0;
  wanted.forEach(function (amount) {
    totalItems += amount;
  });
  if (totalItems > MAX_TOTAL_ITEMS) {
    fail(res, 400, "cart_too_large", "Too many items");
    return;
  }

  // Closed is checked before touching Barsy — no point pricing an order that
  // cannot be placed.
  if (!isOpen()) {
    fail(res, 409, "closed", "Online ordering is closed right now");
    return;
  }

  // --- price it from the live menu, never from the browser ------------------
  let menuRes;
  try {
    menuRes = await barsyCall("Categories_getalltree", {});
  } catch (err) {
    fail(res, 503, "barsy_unreachable", "Could not reach Barsy");
    return;
  }
  if (!menuRes.ok || !menuRes.data || !menuRes.data.Categories_getalltree) {
    fail(res, 503, "barsy_unreachable", "Could not read the menu from Barsy");
    return;
  }

  const priceMap = buildPriceMap(menuRes.data.Categories_getalltree);

  const lines = [];
  const unavailable = [];
  let totalCents = 0;

  wanted.forEach(function (amount, articleId) {
    const article = priceMap.get(articleId);
    if (!article) {
      unavailable.push(articleId);
      return;
    }
    const cents = Math.round(article.price * 100) * amount;
    totalCents += cents;
    lines.push({
      article_id: articleId,
      amount: amount,
      original_current_price: article.price,
      supplements: [],
      modificators: []
    });
  });

  // An item can vanish or be renamed between page load and checkout — a stale
  // localStorage cart from days ago is the common case. Refuse the whole order
  // and let the customer re-confirm rather than silently dropping a line.
  if (unavailable.length) {
    res.status(409).json({
      ok: false,
      code: "cart_out_of_date",
      message: "Some items are no longer available",
      unavailable: unavailable
    });
    return;
  }

  const total = Number((totalCents / 100).toFixed(2));
  if (total <= 0) {
    fail(res, 400, "empty_cart", "Cart is empty");
    return;
  }
  if (total > MAX_ORDER_EUR) {
    fail(res, 400, "order_too_large", "Order total is too large");
    return;
  }

  // --- place it ------------------------------------------------------------
  const ref = makeRef(body.ref);
  const description = note ? `Онлайн поръчка ${ref} · ${note}` : `Онлайн поръчка ${ref}`;

  // Shape verified against a real accepted order (2026-08-17). Two things the
  // storefront bundle hides at first glance and Barsy rejects with an opaque
  // "непредвидена грешка" if you get them wrong:
  //   * payments carry `paymethod_id` / `original_paid_sum` — `pay_num` is only
  //     the key of the redux map, never a field in the request;
  //   * `public_order_id` is left out entirely for a new order, not sent as null.
  const payload = {
    public_order_data: {
      delivery_address: { delivery_type: "no" },
      phone: phone,
      contact_name: name,
      description: description,
      place_sid: null,
      delivery_date: null
    },
    orders: lines,
    payments: [{ paymethod_id: payId, original_paid_sum: total, req_value: null }],
    client_code: ""
  };

  let placed;
  try {
    placed = await barsyCall("Publicorders_place", payload);
  } catch (err) {
    // Aborted or network-level failure. The order may or may not have landed in
    // the POS, so the client must be told to call rather than blindly retry.
    res.status(504).json({
      ok: false,
      code: "uncertain",
      message: "No response from Barsy — the order may have been placed",
      ref: ref
    });
    return;
  }

  if (!placed.ok || !placed.data || !placed.data.Publicorders_place) {
    res.status(502).json({
      ok: false,
      code: "barsy_rejected",
      message: typeof placed.raw === "string" ? placed.raw.slice(0, 300) : "Barsy rejected the order",
      ref: ref
    });
    return;
  }

  const result = placed.data.Publicorders_place;

  res.status(200).json({
    ok: true,
    ref: ref,
    total: total,
    payment: PAYMENT_METHODS[payId],
    public_order_id: result.public_order_id || null,
    // Barsy leaves public_order_num null on creation and fills it later, so the
    // customer-facing confirmation falls back to our own ref.
    public_order_num: result.public_order_num || null,
    online_payment_url: result.online_payment_url || null
  });
};
