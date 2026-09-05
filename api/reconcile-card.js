// api/reconcile-card.js
// Равнителна задача за онлайн картовите поръчки (виж DIRECT_DSK в api/order.js).
//
// Проблемът: ако клиент плати на страницата на ДСК, но НЕ се върне на сайта
// (затвори таба), `api/pay-return.js` не се вика и сметката остава ОТВОРЕНА и
// незатворена — персоналът я гони по мейла и я закрива ръчно (виж сметка 231).
//
// Тази задача затваря дупката без база данни: изброява отворените онлайн-КАРТОВИ
// сметки, вади реф-а (W-XXXX) от описанието, пита ДСК за статуса ПО НОМЕРА НА
// ПОРЪЧКАТА (`orderNumber` — потвърдено, че ДСК го приема), и щом плащането е
// потвърдено (`orderStatus === 2`) и сумата съвпада — затваря сметката с
// `Accounts_place(payment, flag_close_account=1)`: един фискален бон, нула
// служебни, точно като pay-return.
//
// Безопасно по устройство:
//   * пипа само сметки на клиент 7 (Онлайн) с надпис „КАРТА" — плащанията в брой
//     стоят си отворени до вземане на касата, тях НЕ ги докосва;
//   * затваря само при потвърдено от ДСК плащане и съвпадаща сума → фантом няма;
//   * идемпотентно: затворена сметка пада от списъка с отворени, следващ тик я
//     подминава; двойно затваряне удря вече затворена сметка и Barsy го отказва.
//
// Достъп: GET/POST с `token` = PAY_HMAC_SECRET (или PREVIEW_TOKEN). Мисли се за
// периодично викане (крон) през работния ден. Връща обобщение.

const crypto = require("crypto");

const BARSY_API = "https://motamoshop.barsy.online";
const BARSY_ID = 1;
const BARSY_TIMEOUT_MS = 8000;

const DSK_API = "https://epg.dskbank.bg/payment/rest/";

const PICKUP_CLIENT_ID = 7;      // „Онлайн" — каналът на сайта
const CARD_PAYMETHOD_ID = 8;     // „Карта site"
const CARD_ALIAS = /карта/i;     // само картовите (надписът е „… · С КАРТА")
const REF_RE = /(W-[A-Z0-9]{4,8}|WEB-[A-Z0-9]{4,12}-[A-Z0-9]{2,8})/;

async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BARSY_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(r) {
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  return { status: r.status, ok: r.ok, data: data, raw: text };
}

function authedCall(action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async function (signal) {
    const r = await fetch(`${BARSY_API}/endpoints/json/${action}?bid=${BARSY_ID}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}),
      signal: signal
    });
    return readResponse(r);
  });
}

// ДСК статус по НАШИЯ orderNumber (реф). Връща { orderStatus, amount } или null.
async function dskStatusByRef(ref, dskUser, dskPass) {
  const form = new URLSearchParams({ userName: dskUser, password: dskPass, orderNumber: ref });
  return withTimeout(async function (signal) {
    const r = await fetch(DSK_API + "getOrderStatusExtended.do", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: signal
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }
    if (!data) return null;
    return { orderStatus: Number(data.orderStatus), amount: Number(data.amount), errorCode: String(data.errorCode) };
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const q = (req.query && typeof req.query === "object") ? req.query : {};
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};

  const token = body.token != null ? body.token : q.token;
  const HMAC = process.env.PAY_HMAC_SECRET || "";
  const PREVIEW_TOKEN = process.env.PREVIEW_TOKEN || "";
  if (!((HMAC && token === HMAC) || (PREVIEW_TOKEN && token === PREVIEW_TOKEN))) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }

  const user = process.env.BARSY_USER;
  const pass = process.env.BARSY_PASS;
  const dskUser = process.env.DSK_API_USER;
  const dskPass = process.env.DSK_API_PASS;
  if (!user || !pass || !dskUser || !dskPass) {
    res.status(500).json({ ok: false, error: "not_configured" });
    return;
  }

  // 1) Всички сметки; филтрираме към ОТВОРЕНИ онлайн-КАРТОВИ.
  let list;
  try {
    list = await authedCall("Accounts_getlist", {}, user, pass);
  } catch (err) {
    res.status(504).json({ ok: false, error: "barsy_unreachable" });
    return;
  }
  if (!list.ok || !Array.isArray(list.data)) {
    res.status(502).json({ ok: false, error: "accounts_getlist_failed", status: list.status });
    return;
  }

  const open = list.data.filter(function (a) {
    const notClosed = !a.close_date;                       // отворена
    const online = Number(a.client_id) === PICKUP_CLIENT_ID;
    const isCard = CARD_ALIAS.test(a.account_alias || "") || Number(a.paymethod_id) === CARD_PAYMETHOD_ID;
    return notClosed && online && isCard;
  });

  const closed = [];
  const pending = [];
  const skipped = [];
  const errors = [];

  for (const a of open) {
    const accountId = a.account_id;
    const m = REF_RE.exec(a.description || "") || REF_RE.exec(a.account_alias || "");
    if (!m) { skipped.push({ account_id: accountId, why: "no_ref" }); continue; }
    const ref = m[1];

    // Дължимото на сметката, в центове — трябва да съвпадне с платеното в ДСК.
    const dueEur = Number(a.total_remain != null && Number(a.total_remain) > 0 ? a.total_remain : a.total_sum);
    const dueCents = Math.round(dueEur * 100);

    let st;
    try {
      st = await dskStatusByRef(ref, dskUser, dskPass);
    } catch (err) {
      errors.push({ account_id: accountId, ref: ref, why: "dsk_error" });
      continue;
    }
    if (!st) { errors.push({ account_id: accountId, ref: ref, why: "dsk_bad_response" }); continue; }

    // orderStatus 2 = платено/оторизирано. Всичко друго = още неплатена → чака.
    if (st.orderStatus !== 2) { pending.push({ account_id: accountId, ref: ref, orderStatus: st.orderStatus }); continue; }

    // Сумата трябва да съвпада — иначе не пипаме (ръчна проверка).
    if (Number(st.amount) !== dueCents) {
      errors.push({ account_id: accountId, ref: ref, why: "amount_mismatch", dsk: st.amount, due: dueCents });
      continue;
    }

    // Платено и съвпада → затваряме с плащането (един фискален бон, без служебен).
    const sumEur = Number((Number(st.amount) / 100).toFixed(2));
    let placed;
    try {
      placed = await authedCall(
        "Accounts_place",
        {
          account_id: Number(accountId),
          flag_close_account: 1,
          payments: [{ paymethod_id: CARD_PAYMETHOD_ID, original_paid_sum: sumEur }]
        },
        user, pass
      );
    } catch (err) {
      errors.push({ account_id: accountId, ref: ref, why: "place_error" });
      continue;
    }
    if (!placed.ok) {
      console.error(JSON.stringify({
        event: "reconcile_place_failed", ref: ref, account_id: accountId,
        status: placed.status, barsy: typeof placed.raw === "string" ? placed.raw.slice(0, 400) : null
      }));
      errors.push({ account_id: accountId, ref: ref, why: "place_failed" });
      continue;
    }

    console.error(JSON.stringify({ event: "reconcile_settled", ref: ref, account_id: accountId, sum: sumEur }));
    closed.push({ account_id: accountId, ref: ref, sum: sumEur });
  }

  res.status(200).json({
    ok: true,
    open_card_accounts: open.length,
    closed: closed,
    pending: pending,
    skipped: skipped,
    errors: errors
  });
};
