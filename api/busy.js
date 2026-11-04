// api/busy.js — „натоварени ли сме“: брой ОТВОРЕНИ сметки в Barsy на точката (status 0, създадени през последните 3 ч).
// Публичен само за четене; сайтът го пита на минута. Над BUSY_OPEN_MAX (5) отворени → busy:true → сайтът показва съобщение за забавяне.
// Кеш 60 сек в CDN-а на Vercel, за да не тормозим Barsy при много посетители. При грешка → busy:false (не плашим клиентите без нужда).
const ALLOWED_ORIGIN = "https://motamo.bg";
const SHOP_API = "https://motamoshop.barsy.online";
const LIMIT = Number(process.env.BUSY_OPEN_MAX) || 5;
const LOOKBACK_MIN = 180;

const sofiaNow = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
const naiveMin = (s) => Date.parse(String(s).replace(" ", "T") + "Z") / 60000;

module.exports = async function handler(req, res) {
  const o = String((req.headers && req.headers.origin) || "");
  res.setHeader("Access-Control-Allow-Origin", (o === ALLOWED_ORIGIN || o === "https://www.motamo.bg") ? o : ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ ok: false }); return; }
  try {
    const auth = Buffer.from(`${process.env.BARSY_USER}:${process.env.BARSY_PASS}`).toString("base64");
    const r = await fetch(`${SHOP_API}/endpoints/json/Accounts_getlist?bid=1`, {
      method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ order_by: "account_id desc", length: 60 }), signal: AbortSignal.timeout(8000)
    });
    const d = await r.json();
    const list = Array.isArray(d) ? d : Object.values(d || {});
    if (!r.ok || !list.length) throw new Error("no_data");
    const now = naiveMin(sofiaNow());
    const open = list.filter(a => Number(a.status) === 0 && Number(a.total_sum || 0) > 0 && now - naiveMin(a.create_date) <= LOOKBACK_MIN).length;
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");
    res.status(200).json({ ok: true, open, limit: LIMIT, busy: open > LIMIT });
  } catch (e) {
    res.setHeader("Cache-Control", "s-maxage=30");
    res.status(200).json({ ok: false, busy: false });
  }
};
