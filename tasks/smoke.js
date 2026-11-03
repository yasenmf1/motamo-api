#!/usr/bin/env node
// Бърз тест на живата система след деплой (само публични адреси, нищо не се записва).
//   node tools/smoke.js
// 1) сайтът 2) менюто от API 3) „вратата“ за поръчки (409 cart_out_of_date = отворено; 503 = клиентите НЕ могат да поръчат)
// 4) форма за заявка 5) QR/приложение. Изход 0 = всичко е наред.
const SITE = "https://motamo.bg";
const API = "https://motamo-api.vercel.app";
const bust = "x=" + Date.now();

async function get(url, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); return { status: r.status, text: await r.text() }; }
  catch (e) { return { status: 0, text: String(e.message || e) }; }
  finally { clearTimeout(t); }
}

const results = [];
const check = (name, ok, info) => { results.push(ok); console.log(`${ok ? "✓" : "✗"} ${name}${info ? " — " + info : ""}`); };

(async () => {
  let r = await get(SITE + "/?" + bust);
  check("Сайт motamo.bg", r.status === 200 && /MOTAMO/i.test(r.text), "HTTP " + r.status);

  r = await get(API + "/api/menu?source=point&" + bust);
  let n = 0; try { const j = JSON.parse(r.text); n = (j.items || j.articles || j.data || (Array.isArray(j) ? j : [])).length; } catch {}
  check("Меню от API", r.status === 200 && r.text.length > 1000, `HTTP ${r.status}, ${r.text.length} знака${n ? ", " + n + " реда" : ""}`);

  // врата: валидна форма, но несъществуващ артикул → не се създава сметка
  try {
    const rr = await fetch(API + "/api/order", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "SMOKE TEST", phone: "0882123456", consent: true, pay: "cash", ref: "W-SMOKE" + Date.now(), items: [{ article_id: 999999999, amount: 1 }] }),
    });
    const t = await rr.text(); let code = ""; try { code = JSON.parse(t).code || JSON.parse(t).error || ""; } catch {}
    const open = rr.status === 409 && /cart_out_of_date/.test(t);
    const closed = rr.status === 409 && /not_launched|closed|outside_hours|hours/.test(t);
    check("Врата за поръчки", open || closed, `HTTP ${rr.status} ${code}${closed ? " (затворено/извън час — нормално)" : ""}${rr.status >= 500 ? " ⚠ КЛИЕНТИТЕ НЕ МОГАТ ДА ПОРЪЧАТ" : ""}`);
  } catch (e) { check("Врата за поръчки", false, String(e.message || e)); }

  r = await get("https://zayavka.motamo.bg/");
  check("zayavka.motamo.bg", r.status > 0 && r.status < 500, "HTTP " + r.status);

  r = await get(SITE + "/app/");
  check("Приложение /app/", r.status === 200, "HTTP " + r.status);

  const bad = results.filter((x) => !x).length;
  console.log(bad ? `\n⚠ ${bad} проблема.` : "\n✓ Всичко е наред.");
  process.exit(bad ? 1 : 0);
})();
