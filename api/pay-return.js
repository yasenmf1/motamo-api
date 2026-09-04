// api/pay-return.js
// Връщането на клиента от страницата на ДСК след директно картово плащане
// (виж DIRECT_DSK в api/order.js). Това е втората половина на решението за
// служебния бон.
//
// Моделът (без база данни): поръчката вече е ОТВОРЕНА сметка в Barsy (V1 —
// кухнята я вижда, звъни). Плащането мина директно през ДСК, НЕ през линка на
// Barsy — затова плащането още НЕ е фискализирано отделно. Тук, при потвърдено
// плащане, викаме Accounts_place(account_id, payments, flag_close_account=1):
// плащане и закриване стават ЕДНО фискално действие → ЕДИН фискален бон, нула
// служебни. Отвореният път на Barsy правеше две фискални събития (линкът
// фискализира плащането, по-късното закриване на нулевия остатък → служебен).
//
// Как разбираме, че е платено: ДСК няма server-to-server callback — връщането
// идва през браузъра на клиента, към ТОЗИ адрес. На него НЕ се вярва: питаме
// самата ДСК с getOrderStatusExtended по orderId-то, което ДСК добавя към
// returnUrl. Данните, които пренасяме през браузъра (сметка и сума), са
// подписани с HMAC в order.js и се проверяват тук, за да не може някой да
// затвори чужда сметка или с чужда сума.
//
// Безопасен провал: ако нещо тук се обърка, сметката остава ОТВОРЕНА — точно
// днешното поведение (персоналът я закрива ръчно). „Платено, но няма поръчка"
// е невъзможно, защото поръчката съществува ПРЕДИ плащането.

const crypto = require("crypto");

const BARSY_API = "https://motamoshop.barsy.online";
const BARSY_ID = 1;
const BARSY_TIMEOUT_MS = 8000;

const DSK_API = "https://epg.dskbank.bg/payment/rest/";

const SITE = "https://motamo.bg";

// „Карта site" — същият payment-метод, който Barsy ползва за картовите плащания.
const CARD_PAYMETHOD_ID = 8;

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

// Authenticated Barsy endpoint — същата форма като в api/order.js.
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

// Същата тайна и същият ред на полетата като paySign() в api/order.js.
function paySign(parts) {
  const secret = process.env.PAY_HMAC_SECRET || "";
  return crypto.createHmac("sha256", secret).update(parts.join("|")).digest("hex");
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ДСК getOrderStatusExtended.do — питаме банката какъв е статусът на плащането.
// Връща { ok, orderStatus, amount, raw }. orderStatus: 0 регистрирано, неплатено;
// 1 холд (двуфазен терминал); 2 напълно оторизирано/платено; 3 сторнирано;
// 4 върнато; 6 отказано.
async function dskOrderStatus(orderId) {
  const dskUser = process.env.DSK_API_USER;
  const dskPass = process.env.DSK_API_PASS;
  if (!dskUser || !dskPass) return { ok: false, error: "dsk_not_configured" };
  const form = new URLSearchParams({
    userName: dskUser,
    password: dskPass,
    orderId: orderId
  });
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
    if (!data) return { ok: false, error: "bad_status_response", raw: text.slice(0, 600) };
    return {
      ok: true,
      orderStatus: Number(data.orderStatus),
      amount: Number(data.amount),
      raw: text.slice(0, 600)
    };
  });
}

function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

module.exports = async function handler(req, res) {
  // Клиентът се връща с GET от страницата на ДСК.
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  const first = (v) => Array.isArray(v) ? v[0] : v;

  const ref = String(first(q.ref) || "");
  const acct = String(first(q.acct) || "");
  const amt = String(first(q.amt) || "");           // центове (минорни единици)
  const sig = String(first(q.sig) || "");
  const failFlag = String(first(q.fail) || "") === "1";
  // ДСК добавя своя идентификатор на плащането към returnUrl (orderId; някои
  // инсталации го наричат mdOrder). Приемаме и двете.
  const orderId = String(first(q.orderId) || first(q.mdOrder) || "");

  const back = (paid) => `${SITE}/?paid=${paid}${ref ? "&ref=" + encodeURIComponent(ref) : ""}`;

  // 1) Подписът пази срещу подправяне: чужда сметка, друга сума.
  const expected = paySign([ref, acct, amt]);
  if (!ref || !acct || !amt || !sig || !timingSafeEqual(sig, expected)) {
    console.error(JSON.stringify({ event: "payreturn_bad_signature", ref: ref, acct: acct }));
    redirect(res, back(0));
    return;
  }

  // 2) Изричен отказ от банката, или клиент, който се е върнал без плащане.
  if (failFlag || !orderId) {
    console.error(JSON.stringify({ event: "payreturn_no_payment", ref: ref, acct: acct, fail: failFlag, has_order: !!orderId }));
    redirect(res, back(0)); // сметката остава отворена — персоналът я закрива
    return;
  }

  // 3) Питаме ДСК платено ли е наистина. На браузъра не вярваме.
  let st;
  try {
    st = await dskOrderStatus(orderId);
  } catch (err) {
    console.error(JSON.stringify({ event: "payreturn_status_error", ref: ref, orderId: orderId, message: String(err && err.message) }));
    redirect(res, back(0));
    return;
  }
  // orderStatus 2 = платено. (1 = холд на двуфазен терминал — логваме силно, за
  // да се види, ако терминалът не е едно­фазен; тогава трябва deposit.do, но
  // договорът е за онлайн магазин, който е едно­фазен.)
  const paid = st.ok && st.orderStatus === 2;
  const amountMatches = st.ok && Number(st.amount) === Number(amt);
  if (!paid || !amountMatches) {
    console.error(JSON.stringify({
      event: "payreturn_not_paid", ref: ref, acct: acct, orderId: orderId,
      orderStatus: st && st.orderStatus, amount: st && st.amount, expected_amt: amt, raw: st && st.raw
    }));
    redirect(res, back(0)); // отворената сметка чака ръчно закриване
    return;
  }

  // 4) Платено и сумата съвпада → закриваме сметката ЕДНОВРЕМЕННО с плащането.
  //    Едно фискално действие → един фискален бон, нула служебни.
  //
  // Схемата е сверена с документацията на Barsy (docs.lukanet.com/barsy.api,
  // Accounts_place). Продължаваме СЪЩЕСТВУВАЩАТА сметка по `account_id` — НЕ
  // подаваме нито `account`, нито `orders`: редовете вече са на сметката от
  // Accounts_create, повторното им подаване би удвоило поръчката. `payments` се
  // приемат само заедно с `flag_close_account=1` (както пише в доката).
  //
  // Идемпотентност при двойно връщане (клиент презарежда return-а): второто
  // извикване удря вече затворена сметка и Barsy го отказва — логваме и връщаме
  // успех, без второ плащане или втори бон.
  const user = process.env.BARSY_USER;
  const pass = process.env.BARSY_PASS;
  const sumEur = Number((Number(amt) / 100).toFixed(2));

  let placed;
  try {
    placed = await authedCall(
      "Accounts_place",
      {
        account_id: Number(acct),
        flag_close_account: 1,
        // AccountPaymentInputData: сумата е `original_paid_sum` (НЕ `sum`).
        // `payment_data` НЕ се подава: живото API го иска като object, не string
        // (примерът в доката е подвеждащ — подаде ли се текст, връща „Некоректен
        // тип … Очаква се: object"). То е по избор — за проследяване; orderId-то
        // на ДСК остава в лога (payreturn_settled), което стига за засичане.
        payments: [{
          paymethod_id: CARD_PAYMETHOD_ID,
          original_paid_sum: sumEur
        }]
      },
      user, pass
    );
  } catch (err) {
    // Плащането Е взето. Сметката е още отворена → персоналът я закрива ръчно
    // (рядкото изключение, което пак печата служебен, но само тук — не на всяка
    // поръчка). Клиентът вижда успех: храната ще се направи.
    console.error(JSON.stringify({ event: "payreturn_place_error", ref: ref, acct: acct, orderId: orderId, message: String(err && err.message) }));
    redirect(res, back(1));
    return;
  }

  if (!placed.ok) {
    console.error(JSON.stringify({
      event: "payreturn_place_failed", ref: ref, acct: acct, orderId: orderId,
      status: placed.status, barsy: typeof placed.raw === "string" ? placed.raw.slice(0, 600) : null
    }));
    // Пак: платено е, сметката е отворена, персоналът закрива. Успех към клиента.
    redirect(res, back(1));
    return;
  }

  // Логваме и суровия отговор на Accounts_place — за да видим дали Barsy връща
  // номер на фискалния бон (за евентуално записване/показване към сметката).
  console.error(JSON.stringify({
    event: "payreturn_settled", ref: ref, acct: acct, orderId: orderId, sum: sumEur,
    barsy: typeof placed.raw === "string" ? placed.raw.slice(0, 800) : placed.data
  }));
  redirect(res, back(1));
};
