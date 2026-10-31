// lib/barsy-tree.js — чете менюто (Categories_getalltree) от Barsy с РЕЗЕРВА.
// 10.09.2026: публичният хост (*.barsyonline.menu) увисна от Vercel за час; удостоверения корен
// (/endpoints/json?bid=1, Basic) връща същото дърво (ids, current_price, article_name_public),
// но без description_ml / article_name_public_ml / slug. Затова: публичен 4,5 с → удостоверен 4,5 с
// (общо под лимита от 10 с на Vercel). Липсващите описания се допълват от последния добър отговор
// в паметта на същия инстанс (ако има такъв).
const PUBLIC = {
  point: "https://motamoshop.barsyonline.menu/public/endpoints/json?",
  shop: "https://motamo.barsy.online/public/endpoints/json?"
};
const AUTH = {
  point: { url: "https://motamoshop.barsy.online/endpoints/json?bid=1", user: "BARSY_USER", pass: "BARSY_PASS" }, // secret-scan:ok (име на променлива)
  shop: { url: "https://motamo.barsy.online/endpoints/json?bid=1", user: "BARSY_CEX_USER", pass: "BARSY_CEX_PASS" } // secret-scan:ok (име на променлива)
};
const STEP_MS = 4500;
const BODY = JSON.stringify({ Categories_getalltree: {} });

// последни добри полета, които удостоверената версия не връща
const LAST_GOOD = { point: new Map(), shop: new Map() };
const EXTRA = ["description_ml", "article_name_public_ml", "slug"];

function eachArticle(tree, fn) {
  (tree.articles || []).forEach(fn);
  (tree.categories || []).forEach((c) => (c.articles || []).forEach(fn));
}

function remember(source, tree) {
  const m = LAST_GOOD[source];
  eachArticle(tree, (a) => {
    if (!a || a.article_id == null) return;
    const o = {};
    EXTRA.forEach((k) => { if (a[k] != null) o[k] = a[k]; });
    m.set(a.article_id, o);
  });
}

function patch(source, tree) {
  const m = LAST_GOOD[source];
  let patched = 0;
  eachArticle(tree, (a) => {
    const o = a && m.get(a.article_id);
    if (!o) return;
    EXTRA.forEach((k) => { if (a[k] == null && o[k] != null) { a[k] = o[k]; patched++; } });
  });
  return patched;
}

async function post(url, headers) {
  const r = await fetch(url, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers || {}), body: BODY, signal: AbortSignal.timeout(STEP_MS) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const data = await r.json();
  const tree = data && data.Categories_getalltree;
  if (!tree || typeof tree !== "object") throw new Error("няма Categories_getalltree");
  return tree;
}

// → { tree, via: "public" | "auth", patched }. Хвърля грешка само ако и двата пътя паднат.
async function fetchTree(source, opts) {
  const o = opts || {};
  let pubErr = null;
  if (!o.skipPublic) {
    try {
      const tree = await post(PUBLIC[source]);
      remember(source, tree);
      return { tree, via: "public", patched: 0 };
    } catch (e) {
      pubErr = e;
      console.error(JSON.stringify({ event: "menu_public_fallback", source, error: String(e && e.message).slice(0, 120) }));
    }
  }
  const a = AUTH[source];
  const user = process.env[a.user], pass = process.env[a.pass];
  if (!user || !pass) throw pubErr || new Error("няма данни за резервния вход");
  const tree = await post(a.url, { Authorization: "Basic " + Buffer.from(user + ":" + pass).toString("base64") });
  return { tree, via: "auth", patched: patch(source, tree) };
}

module.exports = { fetchTree, post, PUBLIC, AUTH, STEP_MS };
