// lib/wolt.js — Wolt Drive (куриер до адрес) за motamo.bg.
//
// Wolt Drive е САМО куриер: поръчката, плащането и менюто остават при нас.
// Пътят е: shipment promise (може ли до адреса, за колко, кога) → delivery
// (създаваме доставката с promise_id) → webhooks (статус). Справка:
// motamo_site/docs/WOLT_DRIVE_API.md.
//
// Env (Vercel): WOLT_DRIVE_TOKEN (merchant key), WOLT_VENUE_ID, WOLT_MERCHANT_ID,
// WOLT_ENV ("prod" | "dev", по подразбиране dev), WOLT_WEBHOOK_SECRET (client_secret
// при регистрацията на webhook-а), WOLT_MOCK=1 → не вика Wolt, връща правдоподобни
// отговори (за проба на сайта/API-то преди Wolt да даде достъп).

const crypto = require("crypto");

const HOSTS = {
  prod: "https://daas-public-api.wolt.com",
  dev: "https://daas-public-api.development.dev.woltapi.com"
};

const TIMEOUT_MS = 7000;

// Точката, откъдето куриерът взима. Само за mock/разстояние; в реалния режим
// Wolt знае venue-то по WOLT_VENUE_ID.
const PICKUP = { lat: 42.4268, lon: 25.6397 };   // ул. „Л. Каравелов" 101, Стара Загора

// Колко време Wolt да сметне за приготвяне (мин). Wolt: default 30, max 60.
const PREP_MINUTES = 30;

function cfg() {
  const env = process.env.WOLT_ENV === "prod" ? "prod" : "dev";
  return {
    mock: process.env.WOLT_MOCK === "1",
    host: HOSTS[env],
    env: env,
    token: process.env.WOLT_DRIVE_TOKEN || "",
    venue: process.env.WOLT_VENUE_ID || "",
    merchant: process.env.WOLT_MERCHANT_ID || "",
    secret: process.env.WOLT_WEBHOOK_SECRET || ""
  };
}

function configured() {
  const c = cfg();
  return c.mock || (c.token && c.venue);
}

async function call(method, path, body) {
  const c = cfg();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(c.host + path, {
      method: method,
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    return { ok: r.ok, status: r.status, data: data, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

// Грешките на Wolt → нашите кратки кодове, които сайтът превежда.
function mapError(resp) {
  const code = resp && resp.data && resp.data.error_code;
  if (resp && resp.status === 429) return "unavailable";
  switch (code) {
    case "DROPOFF_OUTSIDE_OF_DELIVERY_AREA": return "outside_area";
    case "INVALID_DROPOFF_ADDRESS": return "invalid_address";
    case "REQUEST_OUTSIDE_DELIVERY_HOURS":
    case "INVALID_SCHEDULED_DROPOFF_TIME":
    case "VENUE_CLOSED":
    case "DELIVERY_AREA_CLOSED":
    case "DELIVERY_AREA_CLOSED_TEMPORARILY":
    case "DELIVERY_NOT_ENABLED_FOR_DELIVERY_AREA": return "closed";
    case "SHIPMENT_PROMISE_NOT_FOUND": return "quote_expired";
    case "DUPLICATE_ORDER": return "duplicate";
    case "INVALID_PAYLOAD": return "invalid_address";
    default: return "unavailable";
  }
}

function haversineKm(a, b) {
  const R = 6371, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// ---------- 1) shipment promise ----------
// where: { street, city, post_code } и/или { lat, lon } (координатите са с предимство).
// Връща { ok, promise_id, valid_until, formatted_address, lat, lon, eta_minutes,
// price (€, с ДДС — за НАС, не за клиента) } или { ok:false, code }.
async function shipmentPromise(where) {
  const c = cfg();
  if (c.mock) return mockPromise(where);
  if (!c.token || !c.venue) return { ok: false, code: "unavailable" };

  const body = { language: "bg", min_preparation_time_minutes: PREP_MINUTES };
  if (where.lat != null && where.lon != null) { body.lat = Number(where.lat); body.lon = Number(where.lon); }
  else { body.street = String(where.street || ""); body.city = String(where.city || "Стара Загора"); if (where.post_code) body.post_code = String(where.post_code); }
  // Една пратка „суши" — стандартна торба; теглото е ориентир за куриера.
  body.parcels = [{ count: 1, dimensions: { weight_gram: 1500, width_cm: 30, height_cm: 20, depth_cm: 30 }, price: { amount: 0, currency: "EUR" } }];

  let resp;
  try {
    resp = await call("POST", `/v1/venues/${encodeURIComponent(c.venue)}/shipment-promises`, body);
  } catch (err) {
    return { ok: false, code: "unavailable", detail: String(err && err.message) };
  }
  if (!resp.ok || !resp.data || !resp.data.id) {
    return { ok: false, code: mapError(resp), status: resp.status, detail: resp.raw ? String(resp.raw).slice(0, 300) : null };
  }
  const d = resp.data;
  const drop = d.dropoff || {};
  const coords = (drop.location && drop.location.coordinates) || {};
  return {
    ok: true,
    promise_id: d.id,
    valid_until: d.valid_until || null,
    is_binding: d.is_binding !== false,
    formatted_address: (drop.location && drop.location.formatted_address) || "",
    lat: coords.lat != null ? Number(coords.lat) : (body.lat != null ? body.lat : null),
    lon: coords.lon != null ? Number(coords.lon) : (body.lon != null ? body.lon : null),
    eta_minutes: drop.eta_minutes != null ? Math.round(Number(drop.eta_minutes)) : null,
    price: d.price && d.price.amount != null ? Number(d.price.amount) / 100 : null,
    currency: d.price && d.price.currency ? d.price.currency : "EUR"
  };
}

// ---------- 2) delivery ----------
// o: { promise_id, lat, lon, name, phone, email, comment, ref, order_number,
//      description, bag_count, sms_received, sms_picked_up }
async function createDelivery(o) {
  const c = cfg();
  if (c.mock) return mockDelivery(o);
  if (!c.token || !c.venue) return { ok: false, code: "unavailable" };

  const body = {
    shipment_promise_id: o.promise_id,
    dropoff: {
      location: { coordinates: { lat: Number(o.lat), lon: Number(o.lon) } },
      comment: o.comment || "",
      options: { is_no_contact: false }
    },
    recipient: { name: o.name, phone_number: o.phone, email: o.email || "office@motamo.bg" },
    parcels: [{
      count: 1,
      description: o.description || "MOTAMO суши/поке",
      identifier: o.ref,
      dimensions: { weight_gram: 1500, width_cm: 30, height_cm: 20, depth_cm: 30 },
      price: { amount: 0, currency: "EUR" },
      dropoff_restrictions: { id_check_required: false },
      tags: []
    }],
    pickup: { comment: `Поръчка ${o.ref} — онлайн, платена` },
    merchant_order_reference_id: o.ref,
    order_number: o.order_number || String(o.ref).replace(/^W-/, "").slice(0, 5),
    customer_support: { url: "https://motamo.bg", email: "office@motamo.bg", phone_number: "+359882595959" },
    sms_notifications: {
      received: o.sms_received || `MOTAMO: поръчката ${o.ref} е приета и се приготвя. Куриер на Wolt ще я достави.`,
      picked_up: o.sms_picked_up || `MOTAMO: куриерът тръгна към теб с поръчка ${o.ref}.`
    },
    tips: [],
    bag_count: o.bag_count || 1,
    language: "bg"
  };

  let resp;
  try {
    resp = await call("POST", `/v1/venues/${encodeURIComponent(c.venue)}/deliveries`, body);
  } catch (err) {
    return { ok: false, code: "unavailable", detail: String(err && err.message) };
  }
  if (!resp.ok || !resp.data || !resp.data.id) {
    return { ok: false, code: mapError(resp), status: resp.status, detail: resp.raw ? String(resp.raw).slice(0, 400) : null };
  }
  const d = resp.data;
  return {
    ok: true,
    delivery_id: d.id,
    wolt_order_reference_id: d.wolt_order_reference_id || null,
    status: d.status || null,
    tracking_url: (d.tracking && d.tracking.url) || null,
    tracking_id: (d.tracking && d.tracking.id) || null,
    pickup_eta: (d.pickup && d.pickup.eta) || null,
    dropoff_eta: (d.dropoff && d.dropoff.eta) || null,
    price: d.price && d.price.amount != null ? Number(d.price.amount) / 100 : null
  };
}

// ---------- 3) cancel ----------
async function cancelDelivery(woltOrderRef, reason) {
  const c = cfg();
  if (c.mock) return { ok: true, status: "REJECTED", mock: true };
  if (!c.token) return { ok: false, code: "unavailable" };
  let resp;
  try {
    resp = await call("PATCH", `/order/${encodeURIComponent(woltOrderRef)}/status/cancel`, { reason: reason || "Отказ от ресторанта" });
  } catch (err) {
    return { ok: false, code: "unavailable", detail: String(err && err.message) };
  }
  if (!resp.ok) return { ok: false, code: (resp.data && resp.data.error_code) || mapError(resp), detail: resp.raw ? String(resp.raw).slice(0, 300) : null };
  return { ok: true, status: (resp.data && resp.data.status) || "REJECTED" };
}

// ---------- 4) webhook JWT (HS256 с client_secret) ----------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function verifyWebhook(token) {
  const c = cfg();
  if (!token || typeof token !== "string") return { ok: false, code: "no_token" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, code: "bad_token" };
  if (!c.secret) return { ok: false, code: "no_secret" };
  const expected = b64url(crypto.createHmac("sha256", c.secret).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(expected), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, code: "bad_signature" };
  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch (e) { return { ok: false, code: "bad_payload" }; }
  return { ok: true, payload: payload };
}

// ---------- mock (WOLT_MOCK=1) ----------
function mockPromise(where) {
  let lat = where.lat != null ? Number(where.lat) : null, lon = where.lon != null ? Number(where.lon) : null;
  const street = String(where.street || "").trim();
  if (lat == null || lon == null) {
    if (street.length < 5 || !/\d/.test(street)) return { ok: false, code: "invalid_address", mock: true };
    // „адрес" → точка на ~1,8 км от точката (детерминистично по текста)
    const h = crypto.createHash("md5").update(street).digest();
    lat = PICKUP.lat + ((h[0] / 255) - 0.5) * 0.03;
    lon = PICKUP.lon + ((h[1] / 255) - 0.5) * 0.04;
  }
  const km = haversineKm(PICKUP, { lat, lon });
  if (km > 5) return { ok: false, code: "outside_area", mock: true, km: Number(km.toFixed(2)) };
  const band = Math.min(4, Math.floor(km));
  const price = [3.55, 3.98, 4.46, 4.91, 5.34][band] * 1.2;
  return {
    ok: true, mock: true,
    promise_id: "mock-" + crypto.randomBytes(6).toString("hex"),
    valid_until: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    is_binding: true,
    formatted_address: street ? `${street}, Стара Загора` : `(по местоположение) ~${km.toFixed(1)} км от MOTAMO, Стара Загора`,
    lat: lat, lon: lon,
    eta_minutes: PREP_MINUTES + 8 + Math.round(km * 4),
    price: Number(price.toFixed(2)), currency: "EUR", km: Number(km.toFixed(2))
  };
}
function mockDelivery(o) {
  const id = "mockdlv-" + crypto.randomBytes(5).toString("hex");
  return {
    ok: true, mock: true, delivery_id: id, wolt_order_reference_id: id, status: "INFO_RECEIVED",
    tracking_url: "https://track.wolt.com/mock/" + id, tracking_id: id,
    pickup_eta: new Date(Date.now() + PREP_MINUTES * 60000).toISOString(),
    dropoff_eta: new Date(Date.now() + (PREP_MINUTES + 20) * 60000).toISOString(), price: 4.46 * 1.2
  };
}

module.exports = { cfg, configured, shipmentPromise, createDelivery, cancelDelivery, verifyWebhook, mapError, PREP_MINUTES, PICKUP };
