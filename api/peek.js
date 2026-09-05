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

// Позволени Barsy хостове (бял списък — за да не се сочи произволно). „shop" е
// магазинът/точката (по подразбиране), „cex" е цехът (друг Barsy акаунт). Само
// за да проверим дали същият API потребител има достъп там — пак строго четене.
const HOSTS = {
  shop: "https://motamoshop.barsy.online",
  cex: "https://motamo.barsy.online"
};

// Строг бял списък — само методи, които четат. Нищо, което създава/затваря/сторнира.
const ALLOWED = new Set([
  "Accounts_getlist",
  "Accounts_get",
  "Clientorders_getlist",
  "Clientorders_get",
  "Clientorders_getdetails",
  "Clientorders_getstatuslistdata",
  "Accounts_servicestatusgetlist",
  "Payments_getlist",
  // Каталог/цени/рецепти — само четене, за да мога да видя какво евентуално да сменя.
  "Articles_getlist",
  "Articles_get",
  "Articles_getdetails",
  "Articles_getrecipe",
  "Articles_getavailability",
  "Categories_getlist",
  "Categories_getalltree",
  "Paymentmethods_getlist",
  "Taxgroups_getlist",
  // Състав/рецепта: комбо групи (сет→роли) и релации (роля→заготовки→суровини).
  "Articlesupplements_get",
  "Articlesupplements_getlist",
  "Articledetails_get",
  "Articledetails_getlist",
  "Articlerelations_get",
  "Articlerelations_getlist",
  // Склад / зареждане / производство / партиди — кандидати за четене (цех анализ).
  // Всички са *_getlist/_get (четене по конвенцията на Barsy). Несъществуващ метод
  // просто връща грешка — безвредно.
  "Stores_getlist",
  "Store_getlist",
  "Store_getavailability",
  "Storeloads_getlist",
  "Storeloads_get",
  "Storemoves_getlist",
  "Storemoves_get",
  "Availabilities_getlist",
  "Availability_getlist",
  "Productions_getlist",
  "Productions_get",
  "Production_getlist",
  "Lots_getlist",
  "Lots_get",
  "Lot_getlist",
  "Invoices_getlist",
  "Invoices_get",
  // Правилните имена от каталога с методи на Barsy (S11, от доковете):
  "Storeproductions_getlist",
  "Storeproductions_get",
  "Storeouts_getlist",
  "Storeouts_get",
  "Storeouts_types_getlist",
  "Store_get",
  "Store_getavailabilities",
  "Depots_getlist",
  "Depots_get",
  "Pricelists_getlist",
  "Pricelists_get",
  "Reasons_getstorelist",
  "Reasons_getlist",
  "Revisions_getlist",
  "Orders_getlist",
  "Shipments_getlist",
  "Storenotes_getlist",
  "Documents_getlist",
  "Clients_getlist",
  "Clients_get",
  "Contragents_getlist",
  "Suppliers_getlist",
  "Recipes_getlist",
  "Recipe_getlist",
  "Warehouses_getlist"
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

function authedCall(action, params, user, pass, host, bid) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  const base = host || BARSY_API;
  const id = bid || BARSY_ID;
  return withTimeout(async function (signal) {
    const barsyRes = await fetch(`${base}/endpoints/json/${action}?bid=${id}`, {
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
  const HMAC = process.env.PAY_HMAC_SECRET || "";
  const okToken = (PEEK_TOKEN && token === PEEK_TOKEN) || (HMAC && token === HMAC);
  if (!okToken) {
    fail(res, 403, "forbidden", "Forbidden");
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

  // По избор: кой хост (shop|cex) и bid. По подразбиране магазинът.
  const hostKey = body.host != null ? body.host : q.host;
  const host = hostKey ? HOSTS[hostKey] : BARSY_API;
  if (hostKey && !host) {
    fail(res, 400, "bad_host", "host must be one of: " + Object.keys(HOSTS).join(", "));
    return;
  }
  const bidRaw = body.bid != null ? body.bid : q.bid;
  const bid = bidRaw != null && bidRaw !== "" ? Number(bidRaw) : BARSY_ID;

  // Кредити по хост: цехът е отделен акаунт със свои (BARSY_CEX_USER/PASS);
  // магазинът ползва основните. Слагат се във Vercel env от собственика.
  const user = hostKey === "cex" ? process.env.BARSY_CEX_USER : process.env.BARSY_USER;
  const pass = hostKey === "cex" ? process.env.BARSY_CEX_PASS : process.env.BARSY_PASS;
  if (!user || !pass) {
    fail(res, 500, "not_configured", "Barsy credentials are not configured for host " + (hostKey || "shop"));
    return;
  }

  let out;
  try {
    out = await authedCall(action, params, user, pass, host, bid);
  } catch (err) {
    fail(res, 504, "uncertain", "No response from Barsy");
    return;
  }

  res.status(out.ok ? 200 : 502).json({
    ok: out.ok,
    action: action,
    host: hostKey || "shop",
    bid: bid,
    status: out.status,
    data: out.data,
    raw: out.ok ? undefined : (typeof out.raw === "string" ? out.raw.slice(0, 1500) : null)
  });
};
