// lib/dlv-watch.js — следи ДОСТАВКИТЕ (само поръчки D-…), които чакат куриер твърде дълго (S37, 28.10).
// Всички редове на сметката (без реда „Доставка“) са на „Очаква куриер“ ≥ WAIT_MIN минути → един сигнал в Telegram: на собственика и в групата „МОТАМО поръчки“. Вземането (M-…) и касовите сметки се игнорират. Вика се от Vercel cron (`/api/transfer?cron=dlvwatch`) —
// Vercel позволява само дневни записи, затова в vercel.json има отделен запис на всеки 15 мин (08:00–17:00 UTC); run() сама
// пропуска всичко извън Пн–Сб 11:00–20:00 (София).
// „Откога чака“ = от първото наблюдение на статуса (Barsy не дава час на смяната), т.е. сигналът идва 15–30 мин след готовността.
const TG = require("./telegram.js");
const GRP = require("./orders-group.js");

const WAIT_MIN = 15;
const LOOKBACK_MIN = 240;
const FEE_ARTICLE_ID = Number(process.env.COURIER_FEE_ARTICLE_ID) || 401;
const SHOP_API = "https://motamoshop.barsy.online";
const BID = 1;

async function shopCall(action, params) {
  const auth = Buffer.from(`${process.env.BARSY_USER}:${process.env.BARSY_PASS}`).toString("base64");
  const r = await fetch(`${SHOP_API}/endpoints/json/${action}?bid=${BID}`, {
    method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(params || {}), signal: AbortSignal.timeout(8000)
  });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { ok: r.ok, data };
}

// Час в София като „YYYY-MM-DD HH:mm:ss“ → минути (наивно UTC; сравняваме само разлики).
const sofiaParts = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Sofia", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d || new Date());
const naiveMin = (s) => Date.parse(String(s).replace(" ", "T") + "Z") / 60000;
const sofiaHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(new Date()));
const sofiaWeekday = () => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", weekday: "short" }).format(new Date());

const stageOf = (r) => {
  const t = String(r.order_status_title || "");
  if (/изпълн|обслужен|сервиран/i.test(t)) return 4;
  if (/очаква куриер|готов/i.test(t)) return 3;
  if (/приготв/i.test(t)) return 2;
  return 1;
};

async function run(opts) {
  opts = opts || {};
  if (!opts.force) {
    if (sofiaWeekday() === "Sun") return { ok: true, skipped: "sunday" };
    const h = sofiaHour();
    if (h < 11 || h >= 20) return { ok: true, skipped: "outside_hours", hour: h };
  }
  if (!process.env.BARSY_USER || !process.env.BARSY_PASS) return { ok: false, error: "not_configured" };

  const nowSofia = sofiaParts(new Date(opts.now || Date.now()));   // opts.now — само за тест
  const nowMin = naiveMin(nowSofia);
  const list = await shopCall("Accounts_getlist", { order_by: "account_id desc", length: 40 });
  const accounts = list.ok && Array.isArray(list.data) ? list.data : [];
  const out = { ok: true, checked: 0, waiting: 0, alerted: [] };

  for (const a of accounts) {
    const m = /\b(D-[A-Z0-9]{4,8})\b/.exec(String(a.description || ""));
    if (!m) continue;                                              // само доставки
    const created = naiveMin(a.create_date || "");
    if (!Number.isFinite(created) || nowMin - created > LOOKBACK_MIN) continue;
    const ref = m[1];
    out.checked++;
    const ol = await shopCall("Orders_getlist", { filters: { account_id: a.account_id } });
    const rows = (ol.ok && Array.isArray(ol.data) ? ol.data : []).filter(r => Number(r.article_id) !== FEE_ARTICLE_ID);
    if (!rows.length) continue;
    const stage = Math.min.apply(null, rows.map(stageOf));
    if (stage !== 3) continue;                                      // чака куриер = всичко е „Очаква куриер“
    if (await GRP.handoffGet(ref).catch(() => null)) continue;      // вече е предадена на куриера (бутонът в групата)
    out.waiting++;
    const kind = "dlv_wait_" + ref, day = TG.sofiaDate();   // for_date в cex_tg_sent е тип DATE → номерът на поръчката е в kind
    const rec = await TG.sentGet(kind, day);
    const payload = (rec && rec.payload) || {};
    if (payload.alerted) continue;
    if (!payload.first_seen) {
      await TG.sentSave(kind, day, { first_seen: nowMin, account_id: a.account_id });
      continue;
    }
    const waited = Math.round(nowMin - payload.first_seen);
    if (waited < WAIT_MIN) continue;
    const text = `⏰ <b>Доставка ${TG.escHtml(ref)}</b> (сметка №${TG.escHtml(a.account_id)}) чака куриер от около ${waited} мин.\nОбади се на куриерите и когато вземат храната, смени редовете на „Изпълнено“.`;
    // и на собственика, и в групата „МОТАМО поръчки“ (персоналът на точката вика куриера)
    const targets = [TG.OWNER_CHAT_ID].concat(TG.ORDERS_CHAT_ID ? [TG.ORDERS_CHAT_ID] : []);
    const rs = await Promise.all(targets.map(c => TG.tgSend(text, c, TG.sofiaDate()).catch(() => ({}))));
    const r = { ok: rs.some(x => x && x.ok) };
    if (r.ok) { await TG.sentSave(kind, day, { first_seen: payload.first_seen, account_id: a.account_id, alerted: true, waited: waited }); out.alerted.push(ref); }
  }
  return out;
}

module.exports = { run, stageOf };
