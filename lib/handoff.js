// ★ S37 — бутон „Предадена на куриера“: проверява статуса на РЕДОВЕТЕ в Barsy и го мести 11 → 12 само ако е „Очаква куриер“.
// Barsy няма „задай статус X“: Orders_setStatus мести реда САМО ЕДНА СТЪПКА напред (11→12, но 12→2 „Изпълнено“ без връщане).
// Затова: четем реда току-що, пращаме заявка само за ред със статус 11 и НИКОГА не повтаряме при грешка/таймаут (първо четем пак).
const BARSY_API = "https://motamoshop.barsy.online";
const REF_LOOKUP = /(D-[A-Z0-9]{4,8})/;
const FEE_ARTICLE = () => Number(process.env.COURIER_FEE_ARTICLE_ID || process.env.WOLT_FEE_ARTICLE_ID) || 401;

async function shopPost(action, params) {
  const user = process.env.BARSY_USER, pass = process.env.BARSY_PASS;
  if (!user || !pass) throw new Error("barsy_not_configured");
  const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(`${BARSY_API}/endpoints/json/${action}?bid=1`, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"), "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(params || {}) });
    const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(tm); }
}
const listOf = (d) => Array.isArray(d) ? d : (d && Array.isArray(d.list) ? d.list : (d && typeof d === "object" ? Object.values(d) : []));

async function findAccount(ref) {
  const l = await shopPost("Accounts_getlist", { order_by: "account_id desc", length: 300 });
  if (!l.ok) throw new Error("accounts_unreachable");
  for (const a of listOf(l.data)) {
    if (!a || typeof a !== "object") continue;
    const m = REF_LOOKUP.exec(a.description || "") || REF_LOOKUP.exec(a.account_alias || "");
    if (m && m[1].toUpperCase() === ref) return a;
  }
  return null;
}
async function readLines(accountId) {
  // справката от Каса → Текущи поръчки: има status, next_status_name, pos_id (Orders_getlist няма следващата стъпка)
  const r = await shopPost("accounts_orders_list", { params: { bid: 1 }, action_type: "values", active_struct_id: "eStructList_1",
    filters: { account_id: accountId }, _search: true, rows: 500, page_num: 1, order_by: "", order_dir: "desc" });
  if (!r.ok) throw new Error("orders_unreachable");
  return listOf(r.data && r.data.rows ? r.data.rows : r.data).filter(x => x && Number(x.account_id) === Number(accountId) && Number(x.article_id != null ? x.article_id : x.pos_id_article) !== FEE_ARTICLE());
}
// код на статуса на реда (различните справки го наричат различно)
const codeOf = (r) => { const v = r.status != null ? r.status : (r.order_status_id != null ? r.order_status_id : r.status_id); return v == null ? NaN : Number(v); };
const titleOf = (r) => String(r.order_status_title || r.status_name || r.order_status_name || "");
const isWaiting = (r) => codeOf(r) === 11 || (isNaN(codeOf(r)) && /очаква куриер/i.test(titleOf(r)));
const isHanded = (r) => codeOf(r) === 12 || /предадена на куриер/i.test(titleOf(r));
const nextOk = (r) => { const n = r.next_status_name != null ? String(r.next_status_name) : null; return n == null ? null : /предадена на куриер/i.test(n); };

async function handoff(ref, opts) {
  const dry = !!(opts && opts.dry);
  const out = { ok: false, ref, moved: [], skipped: [] };
  const acc = await findAccount(ref);
  if (!acc) { out.error = "no_account"; out.text = "Не намирам поръчката в Barsy."; return out; }
  out.account_id = Number(acc.account_id);
  let rows = await readLines(out.account_id);
  if (!rows.length) { out.error = "no_lines"; out.text = "Поръчката няма редове."; return out; }
  const why = (r) => isHanded(r) ? "вече е предадена" : (codeOf(r) === 2 || /изпълнен/i.test(titleOf(r))) ? "вече е изпълнена"
    : (/приготв|поръчано/i.test(titleOf(r)) || [1, 10].includes(codeOf(r))) ? "още не е готова" : "статус „" + titleOf(r) + "“";
  for (const r of rows) {
    const name = String(r.article_name || r.pos_name || r.order_id);
    if (!isWaiting(r)) { out.skipped.push({ order_id: r.order_id, name, reason: why(r) }); continue; }
    if (nextOk(r) !== true) { out.skipped.push({ order_id: r.order_id, name, reason: nextOk(r) === false ? "следващата стъпка не е „Предадена на Куриер“ (статус 12 не е включен за тази каса)" : "не мога да проверя следващата стъпка" }); continue; }
    if (dry) { out.moved.push({ order_id: r.order_id, name, dry: true }); continue; }
    // свежо четене точно преди заявката (статусът може да е сменен от КДС или от друг човек)
    const fresh = (await readLines(out.account_id)).find(x => Number(x.order_id) === Number(r.order_id));
    if (!fresh || !isWaiting(fresh)) { out.skipped.push({ order_id: r.order_id, name, reason: "статусът току-що се промени" }); continue; }
    let sent;
    try { sent = await shopPost("Orders_setStatus", { order_id: Number(r.order_id), account_id: out.account_id, set_served_by: false }); }
    catch (e) { sent = { ok: false, timeout: true }; }   // БЕЗ повторен опит — първо четем пак
    out.moved.push({ order_id: r.order_id, name, sent: !!(sent && sent.ok), unsure: !!(sent && sent.timeout) });
  }
  if (!dry && out.moved.length) {
    const after = await readLines(out.account_id);
    out.moved.forEach(m => { const x = after.find(y => Number(y.order_id) === Number(m.order_id)); m.verified = !!(x && isHanded(x)); m.now = x ? titleOf(x) : null; });
  }
  out.ok = true;
  const mv = out.moved.filter(m => m.dry || m.verified), bad = out.moved.filter(m => !m.dry && !m.verified);
  out.text = (mv.length ? `✅ Предадена на куриера (${mv.length} ${mv.length === 1 ? "ред" : "реда"}).` : "")
    + (bad.length ? ` ⚠ Не се потвърди за ${bad.length} ред(а) — виж в Barsy.` : "")
    + (out.skipped.length ? ` Пропуснати: ` + out.skipped.map(s => `${s.name} — ${s.reason}`).join("; ") + "." : "");
  return out;
}
module.exports = { handoff, findAccount, readLines, shopPost };
