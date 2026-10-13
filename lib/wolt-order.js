// lib/wolt-order.js — връзката поръчка (Barsy) ↔ доставка (Wolt Drive).
//
// Редът в Supabase `wolt_deliveries` (ключ = нашият W-ref) се ражда в api/order.js
// заедно със сметката. Самата доставка в Wolt се създава:
//   - в брой (ако Wolt включи наложен платеж): веднага, в api/order.js;
//   - с карта: в api/pay-return.js, СЛЕД потвърдено плащане от ДСК.
// Promise-ът от сайта е само доказателство, че адресът е доставим; до плащането
// той изтича, затова тук се иска НОВ promise по координатите и с него се създава
// доставката. Идемпотентно по ref — второ извикване връща вече създадената.

const wolt = require("./wolt");

const SB_URL = "https://ptzgxreojfvdltbavlop.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB0emd4cmVvamZ2ZGx0YmF2bG9wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyNjIxNzksImV4cCI6MjEwMTgzODE3OX0.o4i60i2Q9eCEhEOjw8OLmNqAkXVXpnqYYvx9_9BrkPs";
const sbH = { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}`, "Content-Type": "application/json" };

async function getRow(ref) {
  const r = await fetch(`${SB_URL}/rest/v1/wolt_deliveries?ref=eq.${encodeURIComponent(ref)}&select=*`, { headers: sbH });
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return rows[0] || null;
}
async function patchRow(ref, patch) {
  const r = await fetch(`${SB_URL}/rest/v1/wolt_deliveries?ref=eq.${encodeURIComponent(ref)}`, {
    method: "PATCH", headers: { ...sbH, Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
  return r.ok;
}
// Записва реда при поръчка. Провал тук не трябва да проваля поръчката — логва се.
async function saveRow(row) {
  try {
    const r = await fetch(`${SB_URL}/rest/v1/wolt_deliveries?on_conflict=ref`, {
      method: "POST", headers: { ...sbH, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([row])
    });
    if (!r.ok) console.error(JSON.stringify({ event: "wolt_row_save_failed", ref: row.ref, status: r.status }));
    return r.ok;
  } catch (err) {
    console.error(JSON.stringify({ event: "wolt_row_save_error", ref: row.ref, message: String(err && err.message) }));
    return false;
  }
}

// Създава доставката в Wolt за дадена поръчка (по реда в Supabase).
// Връща { ok, tracking_url, wolt_order_id, already } или { ok:false, code }.
async function createDeliveryForRef(ref, opts) {
  const row = await getRow(ref);
  if (!row) return { ok: false, code: "not_found" };
  if (row.wolt_order_id && row.status !== "failed") {
    return { ok: true, already: true, tracking_url: row.tracking_url, wolt_order_id: row.wolt_order_id };
  }
  if (row.lat == null || row.lon == null) return { ok: false, code: "invalid_address" };

  await patchRow(ref, { status: "creating", error: null });

  // Нов promise — старият от сайта почти сигурно е изтекъл.
  const p = await wolt.shipmentPromise({ lat: row.lat, lon: row.lon });
  if (!p.ok) {
    console.error(JSON.stringify({ event: "wolt_create_quote_failed", ref: ref, code: p.code, detail: p.detail || null }));
    await patchRow(ref, { status: "failed", error: `quote:${p.code}` });
    return { ok: false, code: p.code };
  }

  const comment = [row.address, row.details].filter(Boolean).join(" · ");
  const d = await wolt.createDelivery({
    promise_id: p.promise_id, lat: p.lat != null ? p.lat : row.lat, lon: p.lon != null ? p.lon : row.lon,
    name: row.name, phone: row.phone, email: row.email || undefined,
    comment: comment.slice(0, 200),
    ref: ref,
    description: (opts && opts.description) || "MOTAMO суши/поке — пази хоризонтално",
    bag_count: (opts && opts.bag_count) || 1
  });
  if (!d.ok) {
    console.error(JSON.stringify({ event: "wolt_create_failed", ref: ref, code: d.code, status: d.status || null, detail: d.detail || null }));
    await patchRow(ref, { status: "failed", error: `create:${d.code}` });
    return { ok: false, code: d.code };
  }
  await patchRow(ref, {
    status: "created", wolt_order_id: d.wolt_order_id || d.delivery_id, tracking_url: d.tracking_url,
    wolt_price: d.price != null ? d.price : p.price, promise_id: p.promise_id, promise_valid_until: p.valid_until,
    pickup_eta: d.pickup_eta, dropoff_eta: d.dropoff_eta, error: null
  });
  console.error(JSON.stringify({ event: "wolt_created", ref: ref, wolt: d.wolt_order_id || d.delivery_id, price: d.price != null ? d.price : p.price, mock: !!d.mock }));
  return { ok: true, tracking_url: d.tracking_url, wolt_order_id: d.wolt_order_id || d.delivery_id, dropoff_eta: d.dropoff_eta };
}

module.exports = { getRow, patchRow, saveRow, createDeliveryForRef };
