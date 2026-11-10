# Репорт „сметки и стокови“ (само четене): какво е издадено от предишния репорт насам, дали всяка нова сметка има стокова, дали сумите им се връзват, грешки и пратени планове.
# Пуска се в 23:30 (за вечерните) и в 10:30 (за сутрешните). python stokovi_report.py [--dry] [--seed]
import datetime as dt, json, sys, urllib.request
from lib import env, sb, sofia_now, notify, heartbeat, state_get, state_put

DRY = "--dry" in sys.argv
PEEK = env("PEEK_TOKEN")
SIBIES = {8: "СИБИЕС 17", 4: "СИБИЕС 11", 9: "СИБИЕС 10", 6: "СИБИЕС 6", 1: "СИБИЕС 4", 11: "СИБИЕС 3", 12: "Нова Загора", 15: "Чирпан", 13: "Казанлък", 14: "Раднево", 7: "СИБИЕС 16", 2: "СИБИЕС 13", 5: "СИБИЕС 12", 3: "СИБИЕС 7", 34: "СИБИЕС ВУЗ"}
PETROV = {16: "Форум", 17: "Академика", 18: "Медицински"}


def peek(action, params):
    rq = urllib.request.Request("https://motamo-api.vercel.app/api/peek", json.dumps({"token": PEEK, "action": action, "host": "cex", "params": params}).encode(), {"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(rq, timeout=90)).get("data")
    return d if isinstance(d, list) else (d.get("list") or list(d.values()) if isinstance(d, dict) else [])


def peek_one(action, params):
    rq = urllib.request.Request("https://motamo-api.vercel.app/api/peek", json.dumps({"token": PEEK, "action": action, "host": "cex", "params": params}).encode(), {"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(rq, timeout=90)).get("data")
    return d if isinstance(d, dict) else {}


def who(a):
    c, p = int(a.get("client_id") or 0), a.get("person_id")
    p = int(p) if p not in (None, "") else None
    if c == 2 and p in SIBIES:
        return SIBIES[p]
    if c == 5 and p in PETROV:
        return PETROV[p]
    return str(a.get("client_name") or ("клиент %s" % c))[:26]


st = state_get("stokovi-report")
if "--seed" in sys.argv:
    state_put("stokovi-report", {"inv": int(sys.argv[sys.argv.index("--seed") + 1]), "acc": int(sys.argv[sys.argv.index("--seed") + 2]), "at": sofia_now().isoformat()})
    print("seed ok"); sys.exit(0)
last_inv, last_acc = int(st.get("inv") or 0), int(st.get("acc") or 0)
if not last_inv:
    print("няма начална точка — пусни със --seed <inv_id> <acc_id>"); sys.exit(0)

accs = [a for a in peek("Accounts_getlist", {"order_by": "account_id desc", "length": 250}) if int(a["account_id"]) > last_acc]
accs.sort(key=lambda a: int(a["account_id"]))
invs = [x for x in peek("Invoices_getlist", {"order_by": "inv_id desc", "length": 250}) if int(x["inv_id"]) > last_inv]
stok = sorted([x for x in invs if x.get("type_id") == 11 and not x.get("is_anulate")], key=lambda x: int(x["inv_id"]))
other = [x for x in invs if x.get("type_id") != 11]

# към кои сметки е вързана всяка нова стокова
linked, tot_by_acc = {}, {}
for x in stok:
    try:
        g = peek_one("Invoices_get", {"inv_id": x["inv_id"]})
    except Exception:
        g = {}
    al = [int(v) for v in (g.get("accounts") or [])] if g else []
    for a in al:
        linked[a] = x
        tot_by_acc[a] = tot_by_acc.get(a, 0) + float(x.get("total") or 0)

lines = []
real = [a for a in accs if float(a.get("total_sum") or 0) > 0.005]
lines.append("Нови сметки: %d (%.2f €) · нови стокови: %d (%.2f €)" % (len(real), sum(float(a["total_sum"]) for a in real), len(stok), sum(float(x.get("total") or 0) for x in stok)))
nostok = [a for a in real if int(a["account_id"]) not in linked]
if nostok:
    lines.append("⚠ Сметки БЕЗ стокова: " + "; ".join("%s №%s (%.2f €)" % (who(a), a["account_id"], float(a["total_sum"])) for a in nostok[:12]))
else:
    lines.append("✅ Всяка нова сметка има стокова.")
diff = []
for a in real:
    i = int(a["account_id"])
    # реалната сума (след отстъпките по редове) е total_real; total_sum е преди тях
    pay = float(a.get("total_real") if a.get("total_real") not in (None, "") else a["total_sum"])
    if i in tot_by_acc and abs(tot_by_acc[i] - pay) > 0.05:
        diff.append("%s: сметка %.2f ≠ стокова %.2f" % (who(a), pay, tot_by_acc[i]))
if diff:
    lines.append("⚠ Различни суми: " + "; ".join(diff[:8]))
extra = [x for x in stok if not any(linked.get(int(a["account_id"])) is x for a in real)]
if extra:
    lines.append("Стокови към по-стари/празни сметки: %d" % len(extra))
if other:
    kinds = {}
    for x in other:
        kinds[x.get("type_id")] = kinds.get(x.get("type_id"), 0) + 1
    names = {1: "фактури", 2: "кредитни", -1: "изписвания"}
    lines.append("Други документи: " + ", ".join("%s %d" % (names.get(k, "тип %s" % k), v) for k, v in kinds.items()))

# грешки от журнала и пратени планове
since = (st.get("at") or "")[:19]
try:
    errs = sb("error_log?select=source,message,at&at=gte.%s&order=at.desc&limit=200" % (dt.datetime.fromisoformat(since) - dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S") ) or []
except Exception:
    errs = []
cnt = {}
for e in errs:
    cnt[e["source"]] = cnt.get(e["source"], 0) + 1
if cnt:
    lines.append("Грешки в журнала: " + "; ".join("%s ×%d" % (k, v) for k, v in sorted(cnt.items(), key=lambda kv: -kv[1])[:4]))
try:
    plans = sb("cex_tg_sent?select=kind,for_date,sent_at&kind=eq.plan&order=sent_at.desc&limit=4") or []
    sent = [p for p in plans if p["sent_at"][:19] >= (dt.datetime.fromisoformat(since) - dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%S")]
    if sent:
        lines.append("Планове, пратени към кухнята: " + ", ".join(sorted({p["for_date"][5:].replace("-", ".")[3:] + "." + p["for_date"][5:7] for p in sent})))
except Exception:
    pass

hh = sofia_now().hour
head = "🧾 Репорт · сметки и стокови · %s (%s)" % (sofia_now().strftime("%d.%m %H:%M"), "вечерните" if hh >= 18 else "сутрешните")
text = head + "\n" + "\n".join(lines)
print(text)
if not DRY:
    notify(text)
    state_put("stokovi-report", {"inv": max([last_inv] + [int(x["inv_id"]) for x in invs]), "acc": max([last_acc] + [int(a["account_id"]) for a in accs]), "at": sofia_now().isoformat()})
    heartbeat("stokovi-report")
