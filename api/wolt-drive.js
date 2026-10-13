// api/wolt-drive.js — Wolt Drive за сайта: проверка на адреса (quote), webhook
// от Wolt, статус на доставка и отказ (инструмент на собственика).
//
//   GET  ?action=quote&street=…&city=…  | &lat=…&lon=…   → { ok, promise_id, valid_until,
//        formatted_address, lat, lon, eta_minutes }  (цената на Wolt НЕ се връща — клиентът
//        плаща фиксираната такса от api/order.js)
//   GET  ?action=status&ref=W-XXXXX                      → { ok, status, tracking_url, … }
//   POST ?hook=1   body { token: <JWT> }                 → webhook от Wolt (HS256 с client_secret)
//   POST ?action=cancel  body { token: PREVIEW_TOKEN, ref, reason }  → отказ (само преди взимане)
//   GET  ?action=ping&token=PREVIEW_TOKEN                → конфигурация (без тайни)
//
// Доставката се СЪЗДАВА в api/order.js (в брой) или api/pay-return.js (карта, след
// плащане) — не тук. Състоянието живее в Supabase `wolt_deliveries` (ключ = ref).

const wolt = require("../lib/wolt");

const ALLOWED_ORIGIN = "https://motamo.bg";
const PREVIEW_TOKEN = process.env.PREVIEW_TOKEN || "";

// Последна поръчка с доставка (Europe/Sofia) — огледало на DELIVERY_CUTOFF_MINS в сайта.
const DELIVERY_CUTOFF_MIN = 18 * 60 + 15;
const OPEN_FROM_MIN = 11 * 60;
const OPEN_DAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

const SB_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0emd4cmVvamZ2ZGx0YmF2bG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjIxNzksImV4cCI6MjEwMTgzODE3OX0.o4i60i2Q9eCEhEOjw8OLmNqAkXVXpnqYYvx9_9BrkPs";
const sbH = { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" };
async function sbGet(q) {
  const r = await fetch(`${SB_URL}/rest/v1/wolt_deliveries?${q}`, { headers: sbH });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows[0] || null;
}
async function sbPatch(ref, patch) {
  await fetch(`${SB_URL}/rest/v1/wolt_deliveries?ref=eq.${encodeURIComponent(ref)}`, {
    method: "PATCH", headers: { ...sbH, Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  }).catch(() => {});
}

function sofiaNow() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date());
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return { day: get("weekday"), mins: Number(get("hour")) % 24 * 60 + Number(get("minute")) };
}
function deliveryWindowOpen() {
  const n = sofiaNow();
  return OPEN_DAYS.has(n.day) && n.mins >= OPEN_FROM_MIN && n.mins <= DELIVERY_CUTOFF_MIN;
}

function cors(req, res) {
  const origin = req.headers.origin || "";
  const allowed = origin === ALLOWED_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin);
  if (allowed) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
}
function json(res, status, obj) { res.status(status).json(obj); }

// Статусите от webhook събитията → кратък статус за нас.
const EVENT_STATUS = {
  "order.received": "received",
  "order.rejected": "rejected",
  "order.pickup_started": "pickup_started",
  "order.pickup_arrival": "pickup_arrival",
  "order.picked_up": "picked_up",
  "order.dropoff_started": "on_the_way",
  "order.dropoff_arrival": "arriving",
  "order.dropoff_completed": "delivered",
  "order.delivered": "delivered",
  "order.customer_no_show": "no_show"
};

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  const q = (req.query && typeof req.query === "object") ? req.query : {};
  const first = (v) => Array.isArray(v) ? v[0] : v;
  const action = String(first(q.action) || "");

  // ---------- webhook от Wolt ----------
  if (req.method === "POST" && String(first(q.hook) || "") === "1") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const v = wolt.verifyWebhook(body && body.token);
    if (!v.ok) {
      console.error(JSON.stringify({ event: "wolt_hook_bad", code: v.code }));
      // 401 → Wolt ще опита пак; при липсваща тайна по-добре да видим в лога.
      json(res, 401, { ok: false, code: v.code });
      return;
    }
    const ev = v.payload || {};
    const d = ev.details || {};
    const type = String(ev.type || "");
    const ref = d.merchant_order_reference_id ? String(d.merchant_order_reference_id) : null;
    const woltId = d.wolt_order_reference_id ? String(d.wolt_order_reference_id) : null;
    console.error(JSON.stringify({ event: "wolt_hook", type: type, ref: ref, wolt: woltId,
      pickup_eta: d.pickup && d.pickup.eta, dropoff_eta: d.dropoff && d.dropoff.eta, rejected: d.purchase_rejected_reason || null }));

    let row = ref ? await sbGet(`ref=eq.${encodeURIComponent(ref)}&select=ref,status,events,wolt_order_id`) : null;
    if (!row && woltId) row = await sbGet(`wolt_order_id=eq.${encodeURIComponent(woltId)}&select=ref,status,events,wolt_order_id`);
    if (row) {
      const events = Array.isArray(row.events) ? row.events : [];
      // Идемпотентно: същото събитие втори път не се записва.
      const dup = events.some((e) => e.type === type && e.at === ev.dispatched_at);
      if (!dup) events.push({ type: type, at: ev.dispatched_at || new Date().toISOString() });
      const patch = { events: events.slice(-40), last_event: type, last_event_at: ev.dispatched_at || new Date().toISOString() };
      // Статусът напред само: доставена поръчка не се връща в „по пътя" от закъсняло събитие.
      const st = EVENT_STATUS[type];
      const final = ["delivered", "rejected", "cancelled", "no_show"];
      if (st && !final.includes(row.status)) patch.status = st;
      if (d.pickup && d.pickup.eta) patch.pickup_eta = d.pickup.eta;
      if (d.dropoff && d.dropoff.eta && d.dropoff.eta.max) patch.dropoff_eta = d.dropoff.eta.max;
      if (type === "order.rejected") patch.error = String(d.purchase_rejected_reason || "rejected");
      if (woltId && !row.wolt_order_id) patch.wolt_order_id = woltId;
      await sbPatch(row.ref, patch);
    }
    json(res, 200, { ok: true });
    return;
  }

  // ---------- quote (сайтът) ----------
  if (req.method === "GET" && action === "quote") {
    const previewing = PREVIEW_TOKEN !== "" && String(first(q.preview) || "") === PREVIEW_TOKEN;
    if (!wolt.configured()) { json(res, 503, { ok: false, code: "unavailable" }); return; }
    if (!previewing && !deliveryWindowOpen()) { json(res, 200, { ok: false, code: "cutoff" }); return; }
    const lat = first(q.lat), lon = first(q.lon);
    const where = {};
    if (lat != null && lon != null && lat !== "" && lon !== "") {
      const la = Number(lat), lo = Number(lon);
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) { json(res, 400, { ok: false, code: "invalid_address" }); return; }
      where.lat = la; where.lon = lo;
    } else {
      const street = String(first(q.street) || "").trim().slice(0, 120);
      if (street.length < 5) { json(res, 400, { ok: false, code: "invalid_address" }); return; }
      where.street = street; where.city = String(first(q.city) || "Стара Загора").trim().slice(0, 40) || "Стара Загора";
    }
    const r = await wolt.shipmentPromise(where);
    if (!r.ok) {
      console.error(JSON.stringify({ event: "wolt_quote_fail", code: r.code, status: r.status || null, detail: r.detail || null }));
      json(res, 200, { ok: false, code: r.code });
      return;
    }
    json(res, 200, {
      ok: true, promise_id: r.promise_id, valid_until: r.valid_until,
      formatted_address: r.formatted_address, lat: r.lat, lon: r.lon, eta_minutes: r.eta_minutes,
      ...(previewing ? { wolt_price: r.price, mock: !!r.mock } : {})
    });
    return;
  }

  // ---------- статус на доставка (сайтът, по ref) ----------
  if (req.method === "GET" && action === "status") {
    const ref = String(first(q.ref) || "").trim();
    if (!/^W-[A-Z0-9]{4,8}$/.test(ref)) { json(res, 400, { ok: false, code: "bad_ref" }); return; }
    const row = await sbGet(`ref=eq.${encodeURIComponent(ref)}&select=ref,status,tracking_url,pickup_eta,dropoff_eta,last_event,last_event_at`);
    if (!row) { json(res, 404, { ok: false, code: "not_found" }); return; }
    json(res, 200, { ok: true, ...row });
    return;
  }

  // ---------- инструменти на собственика ----------
  if (action === "ping" || action === "cancel") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const tok = String((body && body.token) || first(q.token) || "");
    if (!PREVIEW_TOKEN || tok !== PREVIEW_TOKEN) { json(res, 403, { ok: false, code: "forbidden" }); return; }
    if (action === "ping") {
      const c = wolt.cfg();
      json(res, 200, { ok: true, env: c.env, mock: c.mock, has_token: !!c.token, venue: c.venue || null, merchant: c.merchant || null, has_secret: !!c.secret, window_open: deliveryWindowOpen() });
      return;
    }
    const ref = String((body && body.ref) || "").trim();
    const row = await sbGet(`ref=eq.${encodeURIComponent(ref)}&select=ref,status,wolt_order_id`);
    if (!row || !row.wolt_order_id) { json(res, 404, { ok: false, code: "not_found" }); return; }
    const r = await wolt.cancelDelivery(row.wolt_order_id, String((body && body.reason) || "Отказ от ресторанта").slice(0, 200));
    if (r.ok) await sbPatch(ref, { status: "cancelled", last_event: "cancel", last_event_at: new Date().toISOString() });
    json(res, r.ok ? 200 : 409, { ok: r.ok, ...r });
    return;
  }

  json(res, 404, { ok: false, code: "unknown_action" });
};
