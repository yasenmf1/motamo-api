# Агент „Финанси“ — сверка „затворени сметки срещу издадени фактури“ в Barsy на ЦЕХА (само четене).
# python finansi.py [YYYY-MM]   (по подразбиране текущия месец) → кратък български текст за Telegram.
# Данни: /api/peek host cex — Accounts_getlist (затворена сметка = status 1 + close_date; ref_date = датата на затваряне),
# Invoices_getlist (type_id: 1 = Фактура, 2 = Кредитно известие (отрицателна сума, parent_num = № на фактурата),
# 11 = Стокова разписка), Invoices_get (accounts = към кои сметки е вързана фактурата), Clients_getlist.
import calendar, concurrent.futures as cf, datetime, json, sys, time, urllib.request

sys.stdout.reconfigure(encoding="utf8")
import lib
lib.patch_today()
from lib import env
T0 = time.time()


def key(n):
    return env(n)


PEEK = key("PEEK_TOKEN")


def peek(action, params):
    body = json.dumps({"token": PEEK, "action": action, "host": "cex", "params": params}).encode()
    r = urllib.request.Request("https://motamo-api.vercel.app/api/peek", body, {"content-type": "application/json"})
    last = None
    for _ in range(3):
        try:
            return json.load(urllib.request.urlopen(r, timeout=90))
        except Exception as e:
            last = e
            time.sleep(1.5)
    raise RuntimeError(type(last).__name__)


def rows(r):
    d = r.get("data")
    if isinstance(d, list):
        return d
    if isinstance(d, dict):
        return d.get("list") or list(d.values())
    return []


# ── правила на собственика (клиентите са намерени по име в Clients_getlist; виж картата в отчета) ──────────────────
#  mode: "rolling" = засичане на 12–15 дни; "semi" = на 15-о и в края на месеца; "eom" = само в края на месеца;
#        "each" = фактура при ВСЯКА сметка; "delivery" = след всеки разнос (вторник и петък) + кредитни
GROUPS = [
    {"name": "СИБИЕС", "ids": [2], "mode": "rolling"},
    {"name": "А шоп", "ids": [4], "mode": "semi"},
    {"name": "Стенли", "ids": [7], "mode": "semi"},
    {"name": "Пламен Петров", "ids": [5, 14], "mode": "semi"},   # 5 = Пламен Петров, 14 = ПЛАМЕН ПЕТРОВ ВП ЕООД (фактури се издават на 14)
    {"name": "Атлетик", "ids": [8], "mode": "eom"},
    {"name": "Хай Левел (Хасково)", "ids": [9], "mode": "each"},
    {"name": "Сливен/Мерканто", "ids": [11], "mode": "delivery"},
]
OTHER_NAMES = {10: "Тара Шуус", 12: "Падел клуб", 3: "служители ИТТ", 1: "Анонимен"}

month = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().strftime("%Y-%m")
y, m = int(month[:4]), int(month[5:7])
first = datetime.date(y, m, 1)
last = datetime.date(y, m, calendar.monthrange(y, m)[1])
today = datetime.date.today()
upto = min(today, last)


def d(s):
    return datetime.date.fromisoformat(str(s)[:10])


def eur(x):
    return ("%.2f" % x).replace(".", ",") + " €"


try:
    clients = {int(c["client_id"]): c.get("client_name") for c in rows(peek("Clients_getlist", {"filters": {}}))}
    accs = rows(peek("Accounts_getlist", {"filters": {"ref_date": [first.isoformat(), last.isoformat()]}, "length": 5000, "order_by": "account_id desc"}))
    invs = rows(peek("Invoices_getlist", {"order_by": "inv_id desc", "length": 4000}))
except Exception as e:
    print("Финанси: не успях да чета Barsy (%s)" % e)
    sys.exit(1)

accs = [a for a in accs if a.get("status") == 1 and a.get("close_date") and first <= d(a["close_date"]) <= last and float(a.get("total_sum") or 0) > 0.005]   # сметки с 0,00 € не искат фактура
# фактури и кредитни от началото на месеца нататък (издадени и след края на месеца — за сметки от този месец)
cand = [x for x in invs if x.get("type_id") in (1, 2) and not x.get("is_anulate") and d(x["create_date"]) >= first]


def get_inv(x):
    try:
        g = peek("Invoices_get", {"inv_id": x["inv_id"]}).get("data") or {}
        return x, [int(a) for a in (g.get("accounts") or [])]
    except Exception:
        return x, None


with cf.ThreadPoolExecutor(6) as ex:
    detail = list(ex.map(get_inv, cand))

failed = sum(1 for _, a in detail if a is None)
invoiced = {}            # account_id → inv_num
for x, al in detail:
    if x["type_id"] == 1 and al:
        for a in al:
            invoiced[a] = x["inv_num"]

by_client_inv = {}
for x, al in detail:
    by_client_inv.setdefault(int(x["client_id"]), []).append(x)

lines = ["💶 Финанси · сметки срещу фактури · %s (към %s)" % (month, upto.strftime("%d.%m"))]
nofact = []
known = set()
for g in GROUPS:
    ids = g["ids"]
    known.update(ids)
    ga = [a for a in accs if int(a["client_id"]) in ids]
    gi = [x for i in ids for x in by_client_inv.get(i, []) if x["type_id"] == 1]
    gc = [x for i in ids for x in by_client_inv.get(i, []) if x["type_id"] == 2]
    sum_acc = sum(float(a["total_sum"] or 0) for a in ga)
    sum_inv = sum(float(x["total_all"] or 0) for x in gi)
    neto_inv = sum(float(x["total_neto"] or 0) for x in gi)
    sum_cr = sum(float(x["total_all"] or 0) for x in gc)       # отрицателно
    un = sorted([a for a in ga if int(a["account_id"]) not in invoiced], key=lambda a: a["close_date"])
    un_sum = sum(float(a["total_sum"] or 0) for a in un)
    head = "%s: сметки %d (%s с ДДС, ≈%s без) · фактури %d (%s, без ДДС %s)" % (g["name"], len(ga), eur(sum_acc), eur(sum_acc / 1.2), len(gi), eur(sum_inv), eur(neto_inv))
    if gc:
        head += " · кредитни %d (%s)" % (len(gc), eur(sum_cr))
    head += " · разлика %s" % eur(sum_acc - (sum_inv + sum_cr))
    status = "✓ в ред"
    if not ga:
        status = "— няма сметки"
    elif un:
        oldest = d(un[0]["close_date"])
        mode = g["mode"]
        late = False
        why = ""
        if mode == "rolling":
            age = (upto - oldest).days
            late = age >= 15
            why = "най-старата от %s (%d дни; срок 12–15)" % (oldest.strftime("%d.%m"), age)
            if not late and age >= 12:
                why += " — наближава срок"
        elif mode == "semi":
            p1 = [a for a in un if d(a["close_date"]).day <= 15]
            p2 = [a for a in un if d(a["close_date"]).day > 15]
            parts = []
            if p1 and upto >= first.replace(day=15):
                late = True
                parts.append("1–15: %d сметки, срок 15.%02d" % (len(p1), m))
            if p2 and upto >= last:
                late = True
                parts.append("16–%d: %d сметки, срок %s" % (last.day, len(p2), last.strftime("%d.%m")))
            why = "; ".join(parts) if parts else ""
        elif mode == "eom":
            late = upto >= last
            why = "срок %s" % last.strftime("%d.%m")
        elif mode == "each":
            ol = [a for a in un if d(a["close_date"]) < today]
            late = bool(ol)
            if late:
                un, un_sum = ol, sum(float(a["total_sum"] or 0) for a in ol)
            why = "всяка сметка трябва да има фактура"
        elif mode == "delivery":
            ol = [a for a in un if d(a["close_date"]) < today]
            late = bool(ol)
            if late:
                un, un_sum = ol, sum(float(a["total_sum"] or 0) for a in ol)
            why = "разносът е във вт и пт, фактура същия ден"
        if late:
            ids_txt = (" №" + ",".join(str(a["account_id"]) for a in un)) if len(un) <= 3 else ""
            status = "⚠ няма фактура за %d сметки%s (%s) — %s" % (len(un), ids_txt, eur(un_sum), why)
            nofact.append("%s %d (%s)" % (g["name"], len(un), eur(un_sum)))
        else:
            status = "чака срок: %d сметки (%s) още без фактура" % (len(un), eur(un_sum))
    lines.append(head)
    lines.append("   " + status)

# клиенти без зададено правило, но със затворени сметки
oth = {}
for a in accs:
    cid = int(a["client_id"])
    if cid not in known:
        o = oth.setdefault(cid, [0, 0.0, 0, 0.0])
        o[0] += 1
        o[1] += float(a["total_sum"] or 0)
        if int(a["account_id"]) not in invoiced:
            o[2] += 1
            o[3] += float(a["total_sum"] or 0)
for cid, (n, s, un_n, un_s) in sorted(oth.items()):
    nm = OTHER_NAMES.get(cid) or clients.get(cid) or str(cid)
    lines.append("Без правило — %s: сметки %d (%s), без фактура %d (%s)" % (nm, n, eur(s), un_n, eur(un_s)))
lines.append("Без фактура (просрочено): " + ("; ".join(nofact) if nofact else "няма"))
if failed:
    lines.append("⚠ %d фактури не успях да прочета — сверката може да е непълна" % failed)
print("\n".join(lines))
print("(%d сметки, %d фактури/кредитни, %.0f сек)" % (len(accs), len(detail), time.time() - T0), file=sys.stderr)
