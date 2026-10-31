// Сух тест на резервата на менюто (lib/barsy-tree.js + api/menu.js) с подменен fetch. Не говори с Barsy.
const assert = require("assert");
const tree = (withDesc) => ({ Categories_getalltree: { category: { cat_name: "Меню" }, categories: [{ category: { cat_name: "Поке" }, articles: [Object.assign({ article_id: 1, article_name_public: "Поке Тон", current_price: 9.5 }, withDesc ? { description_ml: { bg_BG: "Ориз 150 гр" } } : {})] }], articles: [] } });
const ok = (b) => ({ ok: true, status: 200, json: async () => b });
let mode, calls;
global.fetch = async (url, init) => {
  calls.push(url.includes("barsyonline.menu") ? "public" : "auth");
  const isPub = url.includes("barsyonline.menu");
  if (isPub) { if (mode === "pub-ok") return ok(tree(true)); if (mode === "pub-http") return { ok: false, status: 503, json: async () => ({}) }; throw new Error("timeout"); }
  if (mode === "both-down") throw new Error("auth down");
  assert(init.headers.Authorization && init.headers.Authorization.startsWith("Basic "), "няма Basic");
  return ok(tree(false));
};
process.env.BARSY_USER = "u"; process.env.BARSY_PASS = "p";
const menu = require("../api/menu.js");
function call() {
  return new Promise((resolve) => {
    const h = {}; let body, status = 200;
    const res = { setHeader: (k, v) => (h[k] = v), status: (s) => { status = s; return res; }, json: (b) => { body = b; resolve({ status, h, body }); }, send: (b) => { body = b; resolve({ status, h, body }); }, end: () => resolve({ status, h, body }) };
    menu({ method: "GET", query: { source: "point" }, headers: {} }, res);
  });
}
(async () => {
  calls = []; mode = "pub-ok"; let r = await call();
  assert.equal(r.status, 200); assert.equal(r.h["X-Menu-Source"], "public"); assert.deepEqual(calls, ["public"]); assert(/s-maxage=300/.test(r.h["Cache-Control"]));
  assert.equal(r.body[0].items[0].description, "Ориз 150 гр"); console.log("✓ публичен ок → пълно меню, кеш 5 мин");
  calls = []; mode = "pub-timeout"; r = await call();
  assert.equal(r.status, 200); assert.equal(r.h["X-Menu-Source"], "auth"); assert.deepEqual(calls, ["public", "auth"]); assert(/s-maxage=60.*stale-while-revalidate=0/.test(r.h["Cache-Control"]));
  assert.equal(r.body[0].items[0].price, 9.5); assert.equal(r.body[0].items[0].description, "Ориз 150 гр"); console.log("✓ публичен таймаут → резерва, цени ок, описание от паметта, кеш 1 мин");
  calls = []; mode = "pub-http"; r = await call();
  assert.equal(r.status, 200); assert.equal(r.h["X-Menu-Source"], "auth"); console.log("✓ публичен HTTP 503 → резерва");
  calls = []; mode = "both-down"; r = await call();
  assert.equal(r.status, 502); assert(!r.h["Cache-Control"], "грешката не се кешира"); console.log("✓ и двата падат → 502 без кеш");
  delete process.env.BARSY_USER; calls = []; mode = "pub-timeout"; r = await call();
  assert.equal(r.status, 502); console.log("✓ без данни за вход → 502 (не се чупи)");
  console.log("\nВсички проби минаха.");
})().catch((e) => { console.error("✗ ГРЕШКА:", e.message); process.exit(1); });
