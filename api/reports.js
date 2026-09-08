// api/reports.js — вътрешен хъб с двата дашборда на едно място (таб Цех / Точка).
// Един линк за отметка, гейтнат със същия ключ:
//   GET /api/reports?k=<токен>
// Двата дашборда се зареждат в рамки (iframe), от същия домейн, с токена вътре.
// Само ЧЕТЕ. Ключове: CEX_VIEW_TOKEN / RECONCILE_TOKEN / PREVIEW_TOKEN / PAY_HMAC_SECRET.

const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = (req.query && typeof req.query === "object") ? req.query : {};
  const k = q.k || q.token || "";
  const okV = [process.env.CEX_VIEW_TOKEN, process.env.RECONCILE_TOKEN, process.env.PREVIEW_TOKEN, process.env.PAY_HMAC_SECRET].some(t => t && k === t);
  if (!okV) { res.status(403).send("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:24px'>Няма достъп — липсва или грешен ключ (?k=).</body>"); return; }
  const ek = encodeURIComponent(k);
  const cex = `/api/cex-plan?view=dashboard&k=${ek}`;
  const shop = `/api/shop-dash?view=dashboard&k=${ek}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html><html lang="bg"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>MOTAMO · Репорти</title><style>
:root{color-scheme:light}*{box-sizing:border-box}html,body{height:100%}
body{margin:0;font:15px system-ui,Segoe UI,Roboto,sans-serif;background:#eef0f3;color:#14171a;display:flex;flex-direction:column}
header{background:linear-gradient(135deg,#c8151f,#7a0c12);color:#fff;padding:10px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;box-shadow:0 2px 12px rgba(122,12,18,.3);flex:0 0 auto}
header .brand{font-size:17px;font-weight:800;letter-spacing:.3px;display:flex;align-items:center;gap:9px}
header .brand img{width:30px;height:30px;border-radius:7px;background:#fff;padding:2px}
.tabs{display:flex;gap:8px}
.tabs button{font:14px system-ui;font-weight:700;padding:9px 20px;border:0;border-radius:9px;cursor:pointer;background:rgba(255,255,255,.18);color:#fff;transition:background .12s}
.tabs button:hover{background:rgba(255,255,255,.28)}
.tabs button.on{background:#fff;color:#b3121b;box-shadow:0 2px 6px rgba(0,0,0,.15)}
.frames{position:relative;flex:1 1 auto;min-height:0}
.frames iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:#eef0f3}
.frames iframe[hidden]{display:none}
</style></head><body>
<header>
  <div class="brand"><img src="https://motamo.bg/icons/icon-192.png" alt="" onerror="this.style.display='none'">MOTAMO · Репорти</div>
  <div class="tabs">
    <button id="tCex" class="on" onclick="show('cex')">🍣 Цех</button>
    <button id="tShop" onclick="show('shop')">🍱 Точка (Каравелов)</button>
  </div>
</header>
<div class="frames">
  <iframe id="fCex" src="${esc(cex)}" title="Цех"></iframe>
  <iframe id="fShop" data-src="${esc(shop)}" title="Точка" hidden></iframe>
</div>
<script>
function show(w){
  var isCex=w==='cex';
  var fCex=document.getElementById('fCex'),fShop=document.getElementById('fShop');
  var fr=isCex?fShop:fCex; // мързеливо зареждане на втория при първо отваряне
  if(!isCex&&fShop.getAttribute('data-src')){fShop.src=fShop.getAttribute('data-src');fShop.removeAttribute('data-src')}
  if(isCex&&fCex.getAttribute('data-src')){fCex.src=fCex.getAttribute('data-src');fCex.removeAttribute('data-src')}
  fCex.hidden=!isCex;fShop.hidden=isCex;
  document.getElementById('tCex').className=isCex?'on':'';
  document.getElementById('tShop').className=isCex?'':'on';
  try{location.hash=w}catch(e){}
}
if(location.hash==='#shop')show('shop');
</script>
</body></html>`);
};
