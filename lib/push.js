// lib/push.js — push известия за статуса на поръчка (телефон). Абонаментите са в Supabase `push_subs`.
// VAPID ключовете НЕ се пазят никъде: извеждат се от PEEK_TOKEN (HMAC) → един и същ ключ при всяко пускане, нищо за ротиране/пазене.
// Поток: сайтът (след поръчка, на телефон) записва абонамент → tick() на минута (Supabase pg_cron → /api/transfer?cron=push&k=…)
// гледа статуса на сметките и пуска известие при промяна.
const crypto = require("crypto");
const TG = require("./telegram.js");

const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hm = (label) => crypto.createHmac("sha256", process.env.PEEK_TOKEN || "").update(label).digest();

function vapid() {
  let n = 0;
  for (;;) { // 32 байта, валидни за P-256 (на практика първият опит)
    const priv = hm("motamo-vapid-v1:" + n++);
    try { const e = crypto.createECDH("prime256v1"); e.setPrivateKey(priv); return { pub: b64u(e.getPublicKey()), priv: b64u(priv) }; } catch (err) { if (n > 20) throw err; }
  }
}
// Ключът на крона живее само в базата (таблица push_cron, без достъп за anon); тук го проверява функцията push_check_key.
async function cronKeyOk(k) {
  if (!/^[0-9a-f]{32,80}$/.test(String(k || ""))) return false;
  try {
    const r = await fetch(`${TG.SB_URL}/rest/v1/rpc/push_check_key`, { method: "POST", headers: TG.sbH, body: JSON.stringify({ p: String(k) }), signal: AbortSignal.timeout(6000) });
    return r.ok && (await r.json()) === true;
  } catch (e) { return false; }
}

const REF_PATTERN = /^([WMD]-[A-Z0-9]{4,8}|WEB-[A-Z0-9]{4,12}-[A-Z0-9]{2,8})$/;
const sb = async (path, init) => {
  const r = await fetch(`${TG.SB_URL}/rest/v1/${path}`, { ...(init || {}), headers: { ...TG.sbH, ...((init && init.headers) || {}) }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("sb " + r.status);
  const t = await r.text(); return t ? JSON.parse(t) : null;
};

async function subscribe(body) {
  const ref = String(body.ref || "").trim().toUpperCase();
  const s = body.sub || {}, k = s.keys || {};
  if (!REF_PATTERN.test(ref)) return { status: 400, body: { ok: false, code: "bad_ref" } };
  if (!/^https:\/\//.test(String(s.endpoint || "")) || String(s.endpoint).length > 600 || !k.p256dh || !k.auth) return { status: 400, body: { ok: false, code: "bad_sub" } };
  const acct = Number(body.acct) > 0 ? Number(body.acct) : null;
  await sb("push_subs?on_conflict=ref,endpoint", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([{ ref, num: String(body.num || ref).slice(0, 40), acct, endpoint: s.endpoint, p256dh: String(k.p256dh).slice(0, 200), auth: String(k.auth).slice(0, 100), device: String(body.device || "mobile").slice(0, 20), last_state: "pending", done: false, updated_at: new Date().toISOString() }])
  });
  return { status: 200, body: { ok: true } };
}

// Какво казваме на клиента при всяко състояние (state идва от accountState() в api/order.js).
function message(state, ref, num, delivery) {
  const n = num || ref;
  switch (state) {
    case "accepted": case "preparing": return { title: "Поръчка " + n, body: "Приехме я и вече се приготвя 🍣" };
    case "ready": return { title: "Поръчка " + n, body: delivery ? "Готова е и я предаваме на куриера." : "Готова е — можеш да я вземеш! 🎉" };
    case "courier": return { title: "Поръчка " + n, body: "Куриерът я взе и е на път към теб 🛵" };
    case "done": return { title: "Поръчка " + n, body: delivery ? "Доставена е. Приятен апетит! 😋" : "Приятен апетит! 😋" };
    case "cancelled": return { title: "Поръчка " + n, body: "За съжаление поръчката е отказана. Обади ни се и ще оправим." };
    default: return null;
  }
}

async function tick(shopCall, accountState, findByRef, o) {
  const opt = o || {};
  const since = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const subs = await sb(`push_subs?done=eq.false&created_at=gte.${encodeURIComponent(since)}&select=*&limit=200`) || [];
  if (!subs.length) return { ok: true, subs: 0 };
  const r = await shopCall("Accounts_getlist", { order_by: "account_id desc", length: 300 });
  const raw = r && r.data, list = Array.isArray(raw) ? raw : Object.values(raw || {});
  if (!list.length) return { ok: false, error: "no_barsy_data", subs: subs.length };
  const webpush = require("web-push");
  const v = vapid();
  webpush.setVapidDetails("mailto:office@motamo.bg", v.pub, v.priv);
  const out = { ok: true, subs: subs.length, sent: 0, changed: 0, dropped: 0 };
  for (const s of subs) {
    const a = (s.acct ? list.find(x => x && Number(x.account_id) === Number(s.acct)) : null) || findByRef(list, s.ref);
    if (!a) continue;
    let state; try { state = accountState(a); } catch (e) { continue; }
    if (/^D-/.test(s.ref) && state === "done" && Number(a.service_status_id) !== 6) state = "courier";
    if (state === s.last_state) continue;
    out.changed++;
    const m = message(state, s.ref, s.num, /^D-/.test(s.ref));
    let gone = false;
    if (m && !opt.dry) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: m.title, body: m.body, tag: s.ref, url: "/" }), { TTL: 3600, urgency: "high" });
        out.sent++;
      } catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) { gone = true; out.dropped++; } }
    }
    if (!opt.dry) {
      const fin = gone || state === "done" || state === "cancelled";
      await sb(`push_subs?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_state: state, done: fin, updated_at: new Date().toISOString() }) }).catch(() => null);
    }
  }
  return out;
}

module.exports = { vapid, cronKeyOk, subscribe, tick, message };
