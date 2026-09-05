// api/dsk-probe.js
// Изолирана, БЕЗОПАСНА проба на ДСК страната преди първата истинска поръчка.
//
// Вика само register.do — регистрира едно плащане при ДСК и връща формата на
// банката (formUrl). register.do НЕ таксува нищо (таксуването е чак когато
// някой плати на formUrl), и НЕ пипа Barsy изобщо (никаква сметка в касата).
// Затова е безопасно да се пусне и в продукция.
//
// Какво доказва: валидни ли са API кредитите на ДСК, приема ли се валута 978
// (EUR), и — най-важното — позволен ли е нашият returnUrl (иначе register.do
// го отказва с грешка, която назовава причината).
//
// Достъп: GET с ?token=<PREVIEW_TOKEN>. Отваря се направо в браузъра.
// Отговорът е JSON: { ok, formUrl, orderId } при успех, или { ok:false, error,
// raw } с точното съобщение на банката.

const crypto = require("crypto");

const DSK_API = "https://epg.dskbank.bg/payment/rest/";
const DSK_CURRENCY = "978"; // EUR
const PAY_RETURN_URL = "https://motamo-api.vercel.app/api/pay-return";
const DSK_TIMEOUT_MS = 8000;

function paySign(parts) {
  const secret = process.env.PAY_HMAC_SECRET || "";
  return crypto.createHmac("sha256", secret).update(parts.join("|")).digest("hex");
}

async function withTimeout(run) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DSK_TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  const q = (req.query && typeof req.query === "object") ? req.query : {};
  const first = (v) => Array.isArray(v) ? v[0] : v;
  const token = String(first(q.token) || "");
  // Приема PREVIEW_TOKEN или PAY_HMAC_SECRET — второто, за да може пробата да се
  // извика server-to-server при пускането ѝ, без токенът да минава през браузър.
  const PREVIEW_TOKEN = process.env.PREVIEW_TOKEN || "";
  const HMAC = process.env.PAY_HMAC_SECRET || "";
  const okToken = (PREVIEW_TOKEN && token === PREVIEW_TOKEN) || (HMAC && token === HMAC);
  if (!okToken) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return;
  }

  const dskUser = process.env.DSK_API_USER;
  const dskPass = process.env.DSK_API_PASS;
  if (!dskUser || !dskPass) {
    res.status(500).json({ ok: false, error: "dsk_not_configured" });
    return;
  }

  // Проба на равнителния път: статус по НАШИЯ orderNumber (реф), без orderId.
  // Ако ДСК приема orderNumber, равнителната задача не се нуждае от база — вади
  // реф-а от описанието на отворената сметка и пита ДСК.
  const orderNumber = String(first(q.orderNumber) || "");
  if (orderNumber) {
    const form = new URLSearchParams({ userName: dskUser, password: dskPass, orderNumber: orderNumber });
    try {
      const out = await withTimeout(async function (signal) {
        const r = await fetch(DSK_API + "getOrderStatusExtended.do", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: signal
        });
        const text = await r.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        return { httpStatus: r.status, data: data, text: text };
      });
      res.status(200).json({
        ok: true,
        by: "orderNumber",
        orderNumber: orderNumber,
        orderStatus: out.data ? out.data.orderStatus : null,
        amount: out.data ? out.data.amount : null,
        errorCode: out.data ? out.data.errorCode : null,
        raw: typeof out.text === "string" ? out.text.slice(0, 700) : null
      });
    } catch (err) {
      res.status(502).json({ ok: false, error: "dsk_unreachable", message: String(err && err.message) });
    }
    return;
  }

  // Фиктивна поръчка: 1.00 EUR (100 цента), референция с времеви печат, за да е
  // уникална при повтаряне на пробата. returnUrl е точно този, който истинската
  // поръчка ще ползва — така пробата проверява реалния whitelist.
  const ref = "PROBE-" + Date.now().toString(36).toUpperCase();
  const amountCents = 100;
  const acct = "0"; // няма реална сметка — това е само проба
  const sig = paySign([ref, acct, String(amountCents)]);
  const qs = new URLSearchParams({ ref: ref, acct: acct, amt: String(amountCents), sig: sig });
  const returnUrl = `${PAY_RETURN_URL}?${qs.toString()}`;

  const form = new URLSearchParams({
    userName: dskUser,
    password: dskPass,
    orderNumber: ref,
    amount: String(amountCents),
    currency: DSK_CURRENCY,
    returnUrl: returnUrl,
    failUrl: returnUrl + "&fail=1",
    description: `MOTAMO probe ${ref}`,
    language: "bg",
    sessionTimeoutSecs: "600"
  });

  let out;
  try {
    out = await withTimeout(async function (signal) {
      const r = await fetch(DSK_API + "register.do", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: signal
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { data = null; }
      return { httpStatus: r.status, data: data, text: text };
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: "dsk_unreachable", message: String(err && err.message) });
    return;
  }

  const formUrl = out.data && typeof out.data.formUrl === "string" ? out.data.formUrl : "";
  const orderId = out.data && typeof out.data.orderId === "string" ? out.data.orderId : "";

  if (formUrl && orderId) {
    res.status(200).json({
      ok: true,
      formUrl: formUrl,
      orderId: orderId,
      note: "register.do работи: кредити, валута и returnUrl са приети. Не е таксувано нищо."
    });
    return;
  }

  res.status(200).json({
    ok: false,
    http_status: out.httpStatus,
    error: out.data && (out.data.errorMessage || out.data.errorCode) ? String(out.data.errorMessage || out.data.errorCode) : "register_failed",
    error_code: out.data ? out.data.errorCode : null,
    raw: typeof out.text === "string" ? out.text.slice(0, 800) : null
  });
};
