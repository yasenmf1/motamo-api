// lib/bot-commands.js — бързи команди за собственика в Telegram бота (отговор до секунди, без агент и без компютър).
//   помощ · оборот · суровини · цех · сайт     (с или без „точка:“/„цех:“ отпред за оборот; нищо не пише в Barsy)
const TG = require("./telegram.js");
const turnover = require("./turnover.js");

const BASE = "https://motamo-api.vercel.app";
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const ddmm = iso => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
const eur = n => (Math.round(n * 100) / 100).toFixed(2);

async function cex(token, body) {
  const r = await fetch(BASE + "/api/cex-plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, token }), signal: AbortSignal.timeout(45000) });
  const d = await r.json().catch(() => ({})); if (!d.ok) throw new Error(d.error || ("HTTP " + r.status)); return d;
}

const HELP = "Команди (пиши ги като съобщение):\n• оборот — оборот на точката до момента\n• суровини — какво няма да стигне за днешния разнос + заготовки\n• цех — разнос днес, без стокова, кутии, срокове, оборот на цеха\n• сайт — дали сайтът, менюто и приложението отговарят\n• Поща: … / Цех: … — към агентите на компютъра (отговор до 10 мин)";

async function suroviny(token) {
  const d = await cex(token, { action: "shortage" });
  const out = [`Суровини · ${ddmm(d.date || TG.sofiaDate())}`];
  if (!d.razos_accounts) out.push("Още няма зареден разнос за деня — не мога да сметна недостига.");
  else {
    const sur = (d.shortages || []).filter(s => s.cat === "Суровини"), zag = (d.shortages || []).filter(s => s.cat === "Заготовки").map(s => s.name);
    if (sur.length) { out.push("⚠️ НЯМА да стигнат за днешния разнос:"); for (const s of sur) out.push(`• ${s.name}: има ${s.have}, трябва ${s.need} → липсват ${s.deficit}`); }
    else out.push("✅ Всички суровини стигат за днешния разнос.");
    if (zag.length) out.push("Заготовки за правене днес: " + zag.join(", "));
  }
  try {
    const st = await cex(token, { action: "stock" });
    const z = (st.rows || []).filter(r => r.cat === "Заготовки").sort((a, b) => Number(a.qty) - Number(b.qty));
    if (z.length) out.push("Заготовки в склада (най-ниско първо): " + z.map(r => `${r.name}: ${Math.round(Number(r.qty) * 100) / 100}`).join("; "));
  } catch (e) {}
  return out.join("\n");
}

async function ceh(token) {
  const today = TG.sofiaDate(), out = [`Цех · ${ddmm(today)}`];
  const rz = await cex(token, { action: "load_razos", date: today });
  const shops = rz.shops || [];
  if (!shops.length) out.push("Днес няма разнос.");
  else {
    const without = shops.filter(s => !s.has_stokova);
    out.push(without.length ? "⚠️ Без стокова: " + without.map(s => (s.rep || s.client || "?").toString().slice(0, 28)).join("; ") : `✅ Всички ${shops.length} обекта имат стокова.`);
    const poke = {}, sushi = {};
    for (const s of shops) for (const [n, q0] of Object.entries(s.order || {})) { const q = Number(q0); if (!(q > 0)) continue; const t = /^poke/i.test(n) ? poke : sushi; t[n] = (t[n] || 0) + q; }
    const sm = o => Object.values(o).reduce((a, b) => a + b, 0), ls = o => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([n, q]) => `${n} ${q}`).join(", ");
    out.push(`Поке: ${sm(poke)} купи (${ls(poke)})`); out.push(`Суши: ${sm(sushi)} кутии (${ls(sushi)})`);
  }
  try {
    const ex = await cex(token, { action: "lots_expiring", days: 3 });
    const rows = (ex.rows || []).filter(r => r.cat === "Суровини" || r.cat === "Заготовки"), soon = rows.filter(r => !r.expired), gone = rows.filter(r => r.expired);
    if (soon.length) { out.push("Изтичат до 3 дни:"); for (const r of soon.slice(0, 8)) out.push(`• ${ddmm(String(r.exp).slice(0, 10))} · ${r.name} · кол. ${r.qty}`); }
    if (gone.length) out.push(`Вече изтекли с наличност: ${gone.length}`);
    if (!soon.length && !gone.length) out.push("✅ Няма партиди с изтичащ срок.");
  } catch (e) {}
  try {
    const rev = async (a, b) => { const r = await cex(token, { action: "sales_articles", from: a, to: b }); return Number((r.totals || {}).revenue || 0); };
    const pd = addDays(today, -7), dow = (new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7, ws = addDays(today, -dow), pws = addDays(ws, -7), pwe = addDays(pws, dow), ms = today.slice(0, 8) + "01";
    const [d1, d0, w1, w0] = await Promise.all([rev(today, today), rev(pd, pd), rev(ws, today), rev(pws, pwe)]);
    const pc = (c, p) => p ? ` (${Math.round((c - p) / p * 100) >= 0 ? "+" : ""}${Math.round((c - p) / p * 100)} %)` : "";
    out.push(`Оборот цех без ДДС: ден ${eur(d1)} € срещу ${eur(d0)} €${pc(d1, d0)} · седмица ${eur(w1)} € срещу ${eur(w0)} €${pc(w1, w0)}`);
  } catch (e) {}
  return out.join("\n");
}

async function sait() {
  const t = async (name, url, ok) => { const t0 = Date.now(); try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); const tx = await r.text(); return `${ok(r.status, tx) ? "✓" : "✗"} ${name} — ${r.status}, ${Date.now() - t0} мс`; } catch (e) { return `✗ ${name} — не отговаря`; } };
  const L = await Promise.all([
    t("Сайт motamo.bg", "https://motamo.bg/?x=" + Date.now(), (s, x) => s === 200 && /MOTAMO/i.test(x)),
    t("Меню от API", BASE + "/api/menu?source=point&x=" + Date.now(), (s, x) => s === 200 && x.length > 1000),
    t("Приложение /app/", "https://motamo.bg/app/", s => s === 200),
  ]);
  return "Сайт · проверка\n" + L.join("\n");
}

// → текст за отговор или null (не е команда)
async function handle(text, ctx) {
  const t = String(text || "").trim().toLowerCase().replace(/[?!.]+$/, "").replace(/\s+/g, " ");
  try {
    if (/^(помощ|команди|help|\/help|\/start)$/.test(t)) return HELP;
    if (/^(точка\s*:\s*)?оборот$/.test(t)) return await turnover.report(ctx.shopCall);
    if (/^(цех\s*:\s*)?суровини$/.test(t)) return await suroviny(ctx.cexToken());
    if (/^(цех|цех\s*:\s*(разнос|вечер|днес))$/.test(t)) return await ceh(ctx.cexToken());
    if (/^сайт$/.test(t)) return await sait();
  } catch (e) { return "Не успях да го прочета сега (" + String(e && e.message || e).slice(0, 80) + ")."; }
  return null;
}

module.exports = { handle, HELP };
