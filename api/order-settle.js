// api/order-settle.js
// Втората половина на картовия „Вариант 1" (виж ONLINE_CARD_V2 в api/order.js).
//
// Клиентската заявка вече е платена през своя линк (клиентът → ДСК → Barsy я
// засича). Тук я превръщаме в СМЕТКА, родена ПЛАТЕНА и ЗАТВОРЕНА в едно действие
// (`Accounts_createfromclientorder`, flag_close_account=1), която печата ЕДИН
// фискален бон — вместо служебния, който отвореният път произвежда при затваряне
// на вече фискализирания нулев остатък.
//
// Как разбираме, че е платено: ДСК няма server-to-server callback, а връщането
// след плащане отива към Barsy, не към нас. Затова четем самата заявка
// (`Clientorders_get` → `total_remain_sum`). Идемпотентно: заявка, която вече е
// станала сметка, носи `account_id` и се пропуска, така двойно извикване не прави
// втора сметка.
//
// Достъп: POST с `token`, който съвпада с `PREVIEW_TOKEN`. Засега се вика ръчно с
// `client_order_id` (връща се от `api/order.js`), за да се докаже фискалното
// поведение с една истинска поръчка. Периодичната „обиколка" на платените, но още
// непревърнати заявки (за клиентите, които затворят таба) идва след това.

const BARSY_API = "https://motamoshop.barsy.online";
const BARSY_ID = 1;
const BARSY_TIMEOUT_MS = 8000;
const PREVIEW_TOKEN = process.env.PREVIEW_TOKEN || "";

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

// Authenticated endpoint: action in the URL path, bare params as the body — the
// same shape api/order.js uses.
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

function fail(res, status, code, message) {
  res.status(status).json({ ok: false, code: code, message: message });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

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

  // Гейт: докато това е ръчен инструмент за теста, ползва същия PREVIEW_TOKEN.
  if (!PREVIEW_TOKEN || body.token !== PREVIEW_TOKEN) {
    fail(res, 403, "forbidden", "Forbidden");
    return;
  }

  const clientOrderId = Number(body.client_order_id);
  if (!Number.isInteger(clientOrderId) || clientOrderId <= 0) {
    fail(res, 400, "invalid_client_order_id", "Invalid client_order_id");
    return;
  }

  // 1) Прочитаме заявката: платена ли е и има ли вече сметка.
  let got;
  try {
    got = await authedCall("Clientorders_get", { client_order_id: clientOrderId }, user, pass);
  } catch (err) {
    fail(res, 504, "uncertain", "No response from Barsy");
    return;
  }
  if (!got.ok || !got.data || typeof got.data !== "object") {
    console.error(JSON.stringify({
      event: "settle_get_failed", client_order_id: clientOrderId, status: got.status,
      barsy: typeof got.raw === "string" ? got.raw.slice(0, 600) : null
    }));
    fail(res, 502, "clientorder_get_failed", "Could not read the client order");
    return;
  }

  const co = got.data;
  const existingAccountId = co.account_id || null;
  const remain = Number(co.total_remain_sum);
  const paidSum = Number(co.total_paid_sum);

  // Вече превърната — нищо за правене. Пази срещу двойно извикване (обиколка +
  // ръчно, или два тика на периодичната задача).
  if (existingAccountId) {
    res.status(200).json({
      ok: true, already_settled: true,
      client_order_id: clientOrderId, account_id: existingAccountId
    });
    return;
  }

  // Още неплатена (или частично). Не превръщаме — сметка с остатък не се затваря.
  if (!Number.isFinite(remain) || remain > 0.001) {
    res.status(200).json({
      ok: true, paid: false,
      client_order_id: clientOrderId,
      remain: Number.isFinite(remain) ? remain : null,
      paid_sum: Number.isFinite(paidSum) ? paidSum : null,
      status: co.status_name || null
    });
    return;
  }

  // 2) Платена е → превръщаме я в сметка, родена платена и затворена.
  //
  // Първи опит: `flag_close_account=1` БЕЗ `payments`. Хипотезата е, че платената
  // сума на заявката се пренася в сметката при превръщането (затова „самоплатена
  // онлайн заявка"). Ако сметката излезе неплатена/незатворена, се подава и
  // `payments`, разчетено от заявката — но това се решава от наблюдението на
  // първата истинска поръчка, не отгатнато. `account_props` носи само заглавие за
  // касата; клиентът и адресът се копират автоматично от заявката.
  const accountProps = {
    account_alias: `ОНЛАЙН ${co.contact_name || ""} · КАРТА (платена)`.trim()
  };

  let made;
  try {
    made = await authedCall(
      "Accounts_createfromclientorder",
      { client_order_id: clientOrderId, account_props: accountProps, flag_close_account: 1 },
      user, pass
    );
  } catch (err) {
    fail(res, 504, "uncertain", "No response from Barsy while creating the account");
    return;
  }
  if (!made.ok) {
    console.error(JSON.stringify({
      event: "settle_createaccount_failed", client_order_id: clientOrderId, status: made.status,
      barsy: typeof made.raw === "string" ? made.raw.slice(0, 600) : null
    }));
    res.status(502).json({
      ok: false, code: "createaccount_failed",
      message: typeof made.raw === "string" ? made.raw.slice(0, 300) : "Barsy refused to create the account",
      client_order_id: clientOrderId
    });
    return;
  }

  const accountId = typeof made.data === "number"
    ? made.data
    : (made.data && (made.data.account_id || made.data.id)) || null;

  console.error(JSON.stringify({
    event: "settle_ok", client_order_id: clientOrderId, account_id: accountId, paid_sum: paidSum
  }));

  res.status(200).json({
    ok: true, settled: true,
    client_order_id: clientOrderId, account_id: accountId, paid_sum: paidSum
  });
};
