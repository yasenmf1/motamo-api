// api/peek.js — READ-ONLY прозорец към Barsy за проверка (разработка).
//
// Позволява да се четат поръчки/сметки/заявки/плащания директно, без да се иска
// снимка от собственика на всяка стъпка. НИЩО НЕ ПРОМЕНЯ — само изброените read
// методи, строго в бял списък. Гейтнато с PEEK_TOKEN (Config env). Данните носят
// имена и телефони на клиенти, затова без токен не се дава.
//
// Извиква се: GET /api/peek?t=<PEEK_TOKEN>&action=Accounts_getlist&params={...}
//   или POST { token, action, params }.
// Разрешени action-и: само четене (виж ALLOWED).

const BARSY_API = "https://motamoshop.barsy.online";
const BARSY_ID = 1;
const BARSY_TIMEOUT_MS = 8000;
const PEEK_TOKEN = process.env.PEEK_TOKEN || "";

// Строг бял списък — само методи, които четат. Нищо, което създава/затваря/сторнира.
const ALLOWED = new Set([
  "Accounts_getlist",
  "Accounts_get",
  "Clientorders_getlist",
  "Clientorders_get",
  "Clientorders_getdetails",
  "Payments_getlist",
  // Каталог/цени/рецепти — само четене, за да мога да видя какво евентуално да сменя.
  "Articles_getlist",
  "Articles_get",
  "Categories_getlist",
  "Categories_getalltree",
  "Paymentmethods_getlist",
  "Taxgroups_getlist"
]);

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

function authedCall(action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async function (signal) {
    const barsyRes = await fetch(`${BARSY_API}/endpoints/json/${action}?bid=${BARSY_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify(params || {}),
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

  const q = req.query || {};
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (err) { body = null; }
  }
  if (!body || typeof body !== "object") body = {};

  const token = body.token != null ? body.token : q.t;
  if (!PEEK_TOKEN || token !== PEEK_TOKEN) {
    fail(res, 403, "forbidden", "Forbidden");
    return;
  }

  const user = process.env.BARSY_USER;
  const pass = process.env.BARSY_PASS;
  if (!user || !pass) {
    fail(res, 500, "not_configured", "Barsy credentials are not configured");
    return;
  }

  const action = body.action != null ? body.action : q.action;
  if (!action || !ALLOWED.has(action)) {
    fail(res, 400, "action_not_allowed", "action must be one of: " + Array.from(ALLOWED).join(", "));
    return;
  }

  let params = body.params;
  if (params == null && typeof q.params === "string") {
    try { params = JSON.parse(q.params); } catch (err) {
      fail(res, 400, "bad_params", "params must be valid JSON");
      return;
    }
  }
  if (params == null) params = {};

  let out;
  try {
    out = await authedCall(action, params, user, pass);
  } catch (err) {
    fail(res, 504, "uncertain", "No response from Barsy");
    return;
  }

  res.status(out.ok ? 200 : 502).json({
    ok: out.ok,
    action: action,
    status: out.status,
    data: out.data,
    raw: out.ok ? undefined : (typeof out.raw === "string" ? out.raw.slice(0, 1500) : null)
  });
};
