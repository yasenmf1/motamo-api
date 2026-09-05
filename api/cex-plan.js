// api/cex-plan.js — Фаза 1 на цеховата автоматика: ПРОИЗВОДСТВЕН КАЛКУЛАТОР.
//
// Вход (POST JSON или GET query):
//   * `orders`: { "<име или id на артикул>": бройка, ... }  — дневната заявка (сбор),
//   * ИЛИ `seed_date`: "YYYY-MM-DD" — зарежда сметките на ЦЕХА за този ден и ги
//     събира като чернова заявка (историята на същия делник).
// Изход: разбивка на заявката до
//   * РОЛИ/ПОКЕ за производство (директните + разбитите сетове), и
//   * ЗАГОТОВКИ за производство (по рецептите на ролите, многослойно).
// Суровините НЕ ги смятаме — Barsy ги тегли сам при производство.
//
// НУЛА писане в Barsy — само чете (сметки/поръчки на цеха за зареждане). Рецептата
// идва от `_cexdata.js` (генериран от експорта). Гейт: RECONCILE_TOKEN /
// PAY_HMAC_SECRET / PREVIEW_TOKEN.

const DATA = require("./_cexdata.js");
const ARTS = DATA.articles;            // { id: {id,name,cat,components:[{name,qty,id,cat}],is_menu,is_set,...} }
const NAME2ID = DATA.name2id;

const CEX_API = "https://motamo.barsy.online";
const CEX_BID = 1;
const TIMEOUT_MS = 8000;

function byId(id) { return ARTS[String(id)] || null; }
function resolve(key) {
  // приема id или име
  if (ARTS[String(key)]) return ARTS[String(key)];
  const id = NAME2ID[key];
  return id != null ? ARTS[String(id)] : null;
}

async function withTimeout(run) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try { return await run(c.signal); } finally { clearTimeout(t); }
}
function cexCall(action, params, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");
  return withTimeout(async (signal) => {
    const r = await fetch(`${CEX_API}/endpoints/json/${action}?bid=${CEX_BID}`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}), signal
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data, raw: text };
  });
}

// Събиране на дневната заявка от сметките на цеха за seed_date.
async function seedFromDate(date, user, pass) {
  const list = await cexCall("Accounts_getlist", { order_by: "account_id desc", length: 400 }, user, pass);
  const accts = (list.data || []).filter(a => String(a.create_date || "").startsWith(date));
  const order = {};
  for (const a of accts) {
    const rows = await cexCall("Orders_getlist", { filters: { account_id: a.account_id } }, user, pass);
    for (const o of (rows.data || [])) {
      const art = byId(o.article_id) || resolve(o.article_name);
      if (art && art.is_menu) {
        const amt = Number(o.amount) || 0;
        order[art.name] = (order[art.name] || 0) + amt;
      }
    }
  }
  return { order, accounts: accts.length };
}

// Разбиване: заявка (меню) → роли/поке за производство (разбива сетовете, рекурсивно).
function explodeToRolls(order) {
  const rolls = {};
  const add = (name, qty) => {
    const art = resolve(name);
    if (!art) { rolls[name] = (rolls[name] || 0) + qty; return; }   // непознат — оставяме както е
    if (art.is_set) {
      for (const c of art.components) {
        const cart = c.id != null ? byId(c.id) : resolve(c.name);
        if (cart && cart.is_menu) add(cart.name, qty * c.qty);      // роля вътре в сета (рекурсия за вложен сет)
        // консумативи/суровини в сета се пропускат тук
      }
    } else {
      rolls[art.name] = (rolls[art.name] || 0) + qty;               // роля/поке — за производство
    }
  };
  for (const [k, v] of Object.entries(order)) add(k, Number(v) || 0);
  return rolls;
}

// От ролите/поке → заготовки за производство (рекурсивно заготовка→заготовка).
function rollsToZagotovki(rolls) {
  const zag = {};
  const walk = (name, qty) => {
    const art = resolve(name);
    if (!art) return;
    for (const c of art.components) {
      const cart = c.id != null ? byId(c.id) : resolve(c.name);
      if (!cart) continue;
      if (cart.cat === "Заготовки") {
        zag[cart.name] = (zag[cart.name] || 0) + qty * c.qty;
        walk(cart.name, qty * c.qty);   // ако заготовката има под-заготовки
      }
    }
  };
  for (const [k, v] of Object.entries(rolls)) walk(k, Number(v) || 0);
  return zag;
}

const round = (n, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
function sortObj(o, d = 3) {
  const out = {};
  Object.keys(o).sort().forEach(k => out[k] = round(o[k], d));
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") body = {};

  const token = body.token != null ? body.token : q.token;
  const ok = [process.env.RECONCILE_TOKEN, process.env.PAY_HMAC_SECRET, process.env.PREVIEW_TOKEN]
    .some(t => t && token === t);
  if (!ok) { res.status(403).json({ ok: false, error: "forbidden" }); return; }

  let order = body.orders || null;
  let seededAccounts = null;
  const seedDate = body.seed_date || q.seed_date;

  if (!order && seedDate) {
    const user = process.env.BARSY_CEX_USER, pass = process.env.BARSY_CEX_PASS;
    if (!user || !pass) { res.status(500).json({ ok: false, error: "cex_not_configured" }); return; }
    try {
      const s = await seedFromDate(String(seedDate), user, pass);
      order = s.order; seededAccounts = s.accounts;
    } catch (e) {
      res.status(504).json({ ok: false, error: "cex_unreachable", message: String(e && e.message) });
      return;
    }
  }
  if (!order || typeof order !== "object" || !Object.keys(order).length) {
    res.status(400).json({ ok: false, error: "no_orders", hint: "подай orders:{} или seed_date:YYYY-MM-DD" });
    return;
  }

  const rolls = explodeToRolls(order);
  const zag = rollsToZagotovki(rolls);

  res.status(200).json({
    ok: true,
    seed_date: seedDate || null,
    seeded_accounts: seededAccounts,
    order: sortObj(order, 2),
    produce_rolls: sortObj(rolls, 2),      // роли/поке за производство
    produce_zagotovki: sortObj(zag, 3)     // заготовки за производство
  });
};
