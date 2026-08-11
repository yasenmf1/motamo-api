const SOURCES = {
  point: "https://motamoshop.barsyonline.menu/public/endpoints/json?",
  shop: "https://motamo.barsy.online/public/endpoints/json?"
};

const ALLOWED_ORIGIN = "https://motamo.bg";
const CACHE_SECONDS = 300;

function mapArticle(a) {
  return {
    id: a.article_id,
    name: a.article_name_public,
    price: Number(a.current_price),
    description: (a.description_ml && a.description_ml.bg_BG) || ""
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
    const items = [];
    articles.forEach(function (a) {
      if (seenIds.has(a.article_id)) return;
      seenIds.add(a.article_id);
      if (!hasName(a)) return;
      items.push(mapArticle(a));
    });
    if (items.length) menu.push({ category: cat.cat_name || "", items: items });
  });

  const extraItems = [];
  rootArticles.forEach(function (a) {
    if (seenIds.has(a.article_id)) return;
    seenIds.add(a.article_id);
    if (!hasName(a)) return;
    extraItems.push(mapArticle(a));
  });
  if (extraItems.length) menu.push({ category: rootCatName, items: extraItems });

  res.setHeader("Cache-Control", `s-maxage=${CACHE_SECONDS}, stale-while-revalidate=60`);
  res.status(200).json(menu);
};
