// lib/orders-group.js — съобщение за нова ДОСТАВКА в Telegram групата „МОТАМО поръчки“ (S37).
// Куриерът взема адреса и телефона оттук, без да се влиза в Barsy. Вика се:
//   • от api/order.js — при поръчка В БРОЙ (веднага след създаването на сметката);
//   • от api/pay-return.js — при поръчка С КАРТА, ЧАК след като банката потвърди плащането (с „✅ ПЛАТЕНО“).
// Грешка или бавен отговор на Telegram никога не пречат на поръчката.
const TG = require("./telegram.js");

const TIMEOUT_MS = 2500;

function build(o) {
  const E = TG.escHtml;
  const q = encodeURIComponent(o.address || "");
  const hasXY = o.lat != null && o.lon != null && Number.isFinite(Number(o.lat)) && Number.isFinite(Number(o.lon));
  const nav = hasXY
    ? { g: `https://www.google.com/maps/search/?api=1&query=${o.lat},${o.lon}`, w: `https://waze.com/ul?ll=${o.lat},${o.lon}&navigate=yes` }
    : { g: `https://www.google.com/maps/search/?api=1&query=${q}`, w: `https://waze.com/ul?q=${q}&navigate=yes` };
  const pay = o.paid ? "✅ ПЛАТЕНО С КАРТА" : (o.pay === "card" ? "С КАРТА (плащане при куриера)" : "В БРОЙ (на куриера)");
  const total = Number(o.total);
  const text = `🛵 <b>ДОСТАВКА ${E(o.ref)}</b>${o.accountId ? " · сметка №" + E(o.accountId) : ""}\n`
    + `📍 ${E(o.address)}${o.details ? "\n🚪 " + E(o.details) : ""}\n`
    + `📞 ${E(o.phone)} · ${E(o.name)}\n`
    + `💶 ${Number.isFinite(total) ? total.toFixed(2) + " € · " : ""}${E(pay)}`
    + (o.note ? `\n📝 ${E(String(o.note).slice(0, 300))}` : "");
  return { text, markup: { inline_keyboard: [[{ text: "🗺 Google Maps", url: nav.g }, { text: "🚗 Waze", url: nav.w }]] } };
}

async function notify(o) {
  if (!TG.ORDERS_CHAT_ID) return { ok: false, error: "no_group" };
  try {
    const m = build(o);
    return await Promise.race([
      TG.tgSend(m.text, TG.ORDERS_CHAT_ID, null, m.markup),
      new Promise(r => setTimeout(() => r({ ok: false, error: "timeout" }), TIMEOUT_MS))
    ]);
  } catch (err) {
    console.error(JSON.stringify({ event: "orders_group_notify_failed", ref: o && o.ref, message: String(err && err.message).slice(0, 120) }));
    return { ok: false, error: "exception" };
  }
}

// От сметка на Barsy (Accounts_get) — за пътя след плащане с карта, където нямаме данните от заявката.
function fromAccount(a, ref, extra) {
  const da = (a && a.delivery_address) || {};
  const street = String(da.address || "").trim(), num = String(da.address_number || "").trim();
  let address = (street + (num && street.indexOf(num) < 0 ? " " + num : "")).trim();
  let details = String(da.address_floor || "").trim() || null;
  // Адресът стои ПЪРВИ в бележката („ДОСТАВКА: <адрес>[ · <вход/етаж>]“) — при поръчка с карта Barsy губи полето
  // „Адрес за доставка“ след плащането (delivery_type става „no“), затова бележката е надеждният източник.
  const lines = String(a.notes || "").split(/\r?\n/);
  const m = /^\s*ДОСТАВКА:\s*(.+)$/i.exec(lines[0] || "");
  let rest = lines;
  if (m) {
    const parts = m[1].split(" · ");
    if (!address) address = parts[0].trim();
    if (!details && parts.length > 1) details = parts.slice(1).join(" · ").trim();
    rest = lines.slice(1);
  }
  return Object.assign({
    ref: ref, accountId: a.account_id, address: address, details: details,
    phone: a.phone || "", name: a.contact_name || "", total: a.total_sum, note: rest.join("\n").trim()
  }, extra || {});
}

module.exports = { build, notify, fromAccount };
