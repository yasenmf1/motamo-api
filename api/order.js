// Guest PICKUP checkout → Barsy POS (Каравелов 101).
//
// The browser never talks to Barsy directly. It posts a minimal cart here
// ({article_id, amount} only) and this function decides what the order costs:
// it re-fetches the live menu and prices every line server-side. Anything the
// client says about money is ignored.
//
// This goes through the AUTHENTICATED api (`Clientorders_create`), not the
// public `Publicorders_place`. The public one works without credentials but
// produces an account that Barsy immediately marks "Обслужена" with no order
// status at all, books it to the anonymous client, and cannot express "pickup"
// — Barsy documents this as "работен сценарий 2", which by design has no
// statuses. The authenticated client-order path gives all three back:
// status defaults to „Нова", `delivery_barsy_id` means genuine pickup, and
// booking to client 2 lets the −15% pickup pricelist apply.
//
// Host note: the tenant lives at motamoshop.barsy.online. The .barsyonline.menu
// host is only the public menu frontend and authenticates *clients* (loyalty
// cards), which is why staff credentials are rejected there.

const BARSY_API = "https://motamoshop.barsy.online";
const BARSY_PUBLIC = "https://motamoshop.barsyonline.menu/public/endpoints/json?";
const ALLOWED_ORIGIN = "https://motamo.bg";

// MOTAMO SHOP === Каравелов 101; the two names are the same place.
const BARSY_ID = 1;

// Barsy client 2 is „НА МЯСТО". The −15% pricelist lists exactly this client, so
// booking a web pickup order to it is what makes the rule fire. Orders left on
// the anonymous client (id 1) get no discount at all.
const PICKUP_CLIENT_ID = 2;

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
const REF_PATTERN = /^WEB-[A-Z0-9]{4,12}-[A-Z0-9]{2,8}$/;

function makeRef(clientRef) {
  if (typeof clientRef === "string" && REF_PATTERN.test(clientRef)) return clientRef;
  const stamp = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `WEB-${stamp}-${rand}`;
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

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return "";
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
    baseCentsTotal += unitBaseCents * amount;
    dueCentsTotal += discountedCents(unitBaseCents) * amount;

    // Full menu price goes to Barsy; its own pricelist applies the −15% for
    // client 2. Sending an already-discounted price here would risk the rule
    // discounting a second time.
    rows.push({
      article_id: articleId,
      amount: amount,
      original_price: article.price
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

  const payload = {
    order: {
      // External reference; shows on the order so a lost response can be
      // reconciled over the phone.
      order_num: ref,
      client_id: PICKUP_CLIENT_ID,
      contact_name: name,
      client_tel: phone,
      barsy_id: BARSY_ID,
      // Present = collected from that object. Omitting it would make Barsy treat
      // the order as a delivery to an address.
      delivery_barsy_id: BARSY_ID,
      description: note ? `Онлайн поръчка ${ref} · ${note}` : `Онлайн поръчка ${ref}`,
      public_notes: note,
      ip_address: clientIp(req)
      // status_id deliberately omitted — Barsy defaults it to „Нова".
    },
    rows: rows,
    // No payment yet: the customer pays on collection. Sending one would settle
    // the order the moment it is created.
    payments: []
  };

  let placed;
  try {
    placed = await authedCall("Clientorders_create", payload, user, pass);
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
    res.status(502).json({
      ok: false,
      code: "barsy_rejected",
      message: typeof placed.raw === "string" ? placed.raw.slice(0, 300) : "Barsy rejected the order",
      ref: ref
    });
    return;
  }

  res.status(200).json({
    ok: true,
    ref: ref,
    total: dueTotal,
    base_total: baseTotal,
    discount_pct: PICKUP_DISCOUNT_PCT,
    payment: "cash",
    barsy: placed.data
  });
};
