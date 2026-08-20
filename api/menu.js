const SOURCES = {
  point: "https://motamoshop.barsyonline.menu/public/endpoints/json?",
  shop: "https://motamo.barsy.online/public/endpoints/json?"
};

// Barsy's own storefront builds product images from article_id via this endpoint
// (found in the storefront's JS bundle: getArticlesAvatarThumb). It returns the
// uploaded photo when one exists, or a graceful placeholder SVG when it doesn't —
// no dependency on the raw `picture` filename field, which isn't directly servable.
const IMAGE_BASE = {
  point: "https://motamoshop.barsyonline.menu/public/endpoints/res/Articles_getavatar",
  shop: "https://motamo.barsy.online/public/endpoints/res/Articles_getavatar"
};

// The −15% pickup pricelist covers food only. Alcohol is sold across the counter
// but is not offered online: quoting it at −15% makes Barsy reject the whole order
// („Подадената цена … се различава от очакваната"), and quoting it at full price next to
// discounted food is a different price rule on one screen. The owner's call: keep it
// off the site entirely.
const HIDDEN_CATEGORY = /алкохол/i;

const { sortByProfit } = require("./costs");

// Подредбата по печалба важи само за точката. Магазинният каталог е друг —
// други article_id, друг ценоразпис, себестойности за него няма — така че там
// редът остава този от касата, вместо да го подреждаме по налучкан разход.
const SORT_BY_PROFIT = { point: true, shop: false };

const ALLOWED_ORIGIN = "https://motamo.bg";
const CACHE_SECONDS = 300;

// The Каравелов 101 point runs a −15% pricelist that Barsy applies to guest
// orders, so the public catalogue price is not what such an order actually
// costs. api/order.js sends Barsy the discounted figure and Barsy rejects
// anything else, so the site has to display the same number or customers would
// be quoted a price the POS refuses. Mirrored here rather than imported because
// the two functions are deployed independently.
//
// Barsy rounds half-up at two decimals; the arithmetic stays in integer cents
// because 4.675 * 100 is 467.49999… in binary floating point.
const DISCOUNT_PCT = { point: 15, shop: 0 };

function discounted(price, source) {
  const pct = DISCOUNT_PCT[source] || 0;
  const cents = Math.round(Number(price) * 100);
  if (!pct) return cents / 100;
  return Math.floor((cents * (100 - pct) + 50) / 100) / 100;
}

function mapArticle(a, source) {
  const base = Number(a.current_price);
  const pickup = discounted(base, source);
  // The avatar endpoint is keyed only by article_id, so replacing a product photo
  // in Barsy leaves the URL identical and browsers keep showing the old picture
  // for hours. Barsy stamps every article with `last_update`, which moves whenever
  // the article does — hanging it on the URL makes a new photo a new address.
  const stamp = typeof a.last_update === "string" ? a.last_update.replace(/\D/g, "") : "";
  return {
    id: a.article_id,
    name: a.article_name_public,
    // The menu deliberately quotes the full price. Showing the discounted one
    // everywhere would quietly turn it into the normal price — the discount
    // stops reading as a discount, and it is the number competitors see. The
    // saving belongs at checkout, as its own line.
    price: base,
    pickup_price: pickup === base ? null : pickup,
    description: (a.description_ml && a.description_ml.bg_BG) || "",
    image: `${IMAGE_BASE[source]}?article_id=${a.article_id}&mode=fix&width=550`
      + (stamp ? `&v=${stamp}` : "")
  };
}

function hasName(a) {
  return typeof a.article_name_public === "string" && a.article_name_public.trim().length > 0;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const source = req.query.source;
  const baseUrl = SOURCES[source];

  if (!baseUrl) {
    res.status(400).json({ error: 'Invalid or missing "source" parameter. Use "point" or "shop".' });
    return;
  }

  let barsyRes;
  try {
    barsyRes = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Categories_getalltree: {} })
    });
  } catch (err) {
    res.status(502).json({ error: "Failed to reach Barsy", details: err.message });
    return;
  }

  if (!barsyRes.ok) {
    res.status(502).json({ error: `Barsy responded with status ${barsyRes.status}` });
    return;
  }

  let data;
  try {
    data = await barsyRes.json();
  } catch (err) {
    res.status(502).json({ error: "Invalid JSON from Barsy" });
    return;
  }

  const tree = (data && data.Categories_getalltree) || {};
  const categories = tree.categories || [];
  const rootArticles = tree.articles || [];

  // The root `category.cat_name` (e.g. "Меню Мотамо SHOP") is Barsy's internal
  // parent-container label, not a real menu category — only usable as an actual
  // category name when there ARE no subcategories (root articles are then the
  // whole menu). When subcategories exist, any leftover root-only article is an
  // uncategorized outlier and goes into a generic bucket instead.
  const rootCatName = categories.length > 0
    ? "Други"
    : (tree.category && tree.category.cat_name) || "Други";

  // Barsy repeats subcategory products inside the root `articles[]` array too,
  // but on sources with no subcategories at all (e.g. "shop") root articles
  // are the *only* place the catalog exists — so both must be read, deduped by id.
  const seenIds = new Set();
  const menu = [];

  categories.forEach(function (entry) {
    const cat = entry.category || {};
    const articles = entry.articles || [];
    // Hidden articles are still marked as seen, or Barsy's duplicate copies of them
    // in the root list would resurface under the generic bucket.
    const hidden = HIDDEN_CATEGORY.test(cat.cat_name || "");
    const items = [];
    articles.forEach(function (a) {
      if (seenIds.has(a.article_id)) return;
      seenIds.add(a.article_id);
      if (hidden) return;
      if (!hasName(a)) return;
      items.push(mapArticle(a, source));
    });
    if (items.length) {
      const name = cat.cat_name || "";
      menu.push({
        category: name,
        items: SORT_BY_PROFIT[source] ? sortByProfit(items, name) : items
      });
    }
  });

  const extraItems = [];
  rootArticles.forEach(function (a) {
    if (seenIds.has(a.article_id)) return;
    seenIds.add(a.article_id);
    if (!hasName(a)) return;
    extraItems.push(mapArticle(a, source));
  });
  if (extraItems.length) {
    menu.push({
      category: rootCatName,
      items: SORT_BY_PROFIT[source] ? sortByProfit(extraItems, rootCatName) : extraItems
    });
  }

  res.setHeader("Cache-Control", `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`);
  res.status(200).json(menu);
};
