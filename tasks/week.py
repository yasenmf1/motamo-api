# MOTAMO · агент „Точка“ — седмично следене на разминавания и минуси (САМО ЧЕТЕНЕ).
# Употреба: python week.py [от] [до]   (дати YYYY-MM-DD; без аргументи = миналата седмица Пн–Нд)
# Печата ГОТОВОТО съобщение (за собственика). Ключовете се четат от файла и не се печатат. Нищо не пише в Barsy.
# Памет: state.json (наличности в края на последното пускане → разлика за следващата седмица).
import datetime, json, os, re, sys, time, urllib.request, urllib.error

sys.stdout.reconfigure(encoding="utf8")
import lib
lib.patch_today()
from lib import env, ROOT, state_get, state_put
HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://motamo-api.vercel.app/api/cex-plan"
CEX_SUPPLIER = "Мотамо - цех"
SERVICE = {"Доставка", "Авансово плащане"}


def key(n):
    return env(n)


def post(body, tries=3, timeout=70):
    body = dict(body, token=key("CEX_TOOL_TOKEN"))
    last = None
    for t in range(tries):
        try:
            r = urllib.request.Request(API, json.dumps(body).encode(), {"content-type": "application/json"})
            return json.load(urllib.request.urlopen(r, timeout=timeout))
        except urllib.error.HTTPError as e:
            last = {"ok": False, "http": e.code}
        except Exception as e:
            last = {"ok": False, "err": type(e).__name__}
        time.sleep(1.5 * (t + 1))
    return last


def ro(method, params, host="shop"):
    return post({"action": "ro_call", "host": host, "method": method, "params": params})


def rows_of(d):
    x = d.get("data") if isinstance(d, dict) else None
    if isinstance(x, dict):
        if isinstance(x.get("rows"), list):
            return x["rows"]
        if isinstance(x.get("list"), list):
            return x["list"]
        for v in x.values():
            if isinstance(v, list):
                return v
        return []
    return x if isinstance(x, list) else []


def fail(msg):
    print("ГРЕШКА: " + msg)
    sys.exit(1)


# ── период ──
today = datetime.date.today()
if len(sys.argv) >= 3:
    A, B = sys.argv[1], sys.argv[2]
else:
    mon = today - datetime.timedelta(days=today.weekday() + 7)
    A, B = mon.isoformat(), (mon + datetime.timedelta(days=6)).isoformat()
ndays = (datetime.date.fromisoformat(B) - datetime.date.fromisoformat(A)).days + 1

# ── наличност сега (точката) ──
d = ro("Articles_getlistobject", {"filters": {}, "extra_properties": ["store_amount"]})
L = rows_of(d)
if not L:
    fail("не прочетох наличностите на точката")
stock = {int(a["article_id"]): (a["article_name"], round(float(a.get("store_amount") or 0), 4)) for a in L}

# 36-те артикула на точката + заготовките = „следените“
src = open(os.path.join(ROOT, "api", "transfer.js"), encoding="utf8").read()
block = re.search(r"const MAP = \{(.*?)\};", src, re.S).group(1)
MAP = {int(a): int(b) for a, b in re.findall(r"(\d+):\s*(\d+)", re.sub(r"//[^\n]*", "", block))}
FRESH = {i for i, (n, q) in stock.items() if n.startswith("заг.") or n in ("Зеле овкусено", "Чесън паста", "Кимчи Майонеза", "Спайси Сьомга", "Уасаби Готово")}
TRACKED = set(MAP.values()) | FRESH | {i for i, (n, q) in stock.items() if q != 0}

# ── получено в точката за периода (всички зареждания; „цех“ отделно) ──
heads = rows_of(ro("Storeloads_getlist", {"length": 3000, "order_by": "store_load_id desc", "extra_properties": ["all"]}))
recv_cex, recv_oth, errs = {}, {}, 0
for h in heads:
    dd = str(h.get("doc_date") or h.get("date"))[:10]
    if not (A <= dd <= B) or h.get("status") != 1:
        continue
    g = ro("storeloads_edit", {"id": h["store_load_id"], "store_load_id": h["store_load_id"], "action_type": "values", "active_struct_id": "eStructListForm_1", "force_data_request": True})
    rr = ((g.get("data") or {}).get("rows")) if g and g.get("ok") else None
    if rr is None:
        errs += 1
        continue
    tgt = recv_cex if (h.get("supplier_name") or "") == CEX_SUPPLIER else recv_oth
    for r in rr:
        aid = int(r["article_id"])
        tgt[aid] = tgt.get(aid, 0.0) + float(r.get("amount") or 0)

# ── продажби за периода ──
sold, pages = {}, 0
for pg in range(1, 40):
    d = ro("Reports_sales_by_articles", {"active_struct_id": "eStructList_1", "action_type": "values", "page_num": pg, "filters": {"ref_date": [A, B]}})
    rows = (d.get("data") or {}).get("rows") if d and d.get("ok") else None
    if rows is None:
        fail("продажбите за периода не се прочетоха (страница %d)" % pg)
    pages += 1
    for x in rows:
        k = int(x["article_id"])
        q = sold.setdefault(k, {"name": x.get("article_name"), "cnt": 0.0})
        q["cnt"] += float(x.get("cnt") or 0)
    if len(rows) < 50:
        break

# ── рецепти (спираме разгъването при следен артикул) ──
cache = {}


def recipe(aid):
    if aid in cache:
        return cache[aid]
    d = ro("articles_recipe", {"id": aid, "action_type": "values", "active_struct_id": "eStructListForm_1", "force_data_request": True})
    cache[aid] = [{"article_id": int(r["article_id"]), "part": float(r.get("part_factored") if r.get("part_factored") is not None else (r.get("part") or 0))}
                  for r in rows_of(d) if r.get("article_id") is not None]
    return cache[aid]


TRACKED |= set(recv_cex) | set(recv_oth)
used = {}


def expand(aid, mult, depth):
    for c in recipe(aid):
        cid = c["article_id"]
        if depth < 4 and cid not in TRACKED and recipe(cid):
            expand(cid, mult * c["part"], depth + 1)
        else:
            used[cid] = used.get(cid, 0.0) + mult * c["part"]


norecipe = 0
for aid, q in sold.items():
    if q["name"] in SERVICE:
        continue
    if not recipe(aid):
        norecipe += 1
        continue
    expand(aid, q["cnt"], 0)

# ── сравнение: получено − използвано срещу текущо (спрямо наличността от миналото пускане) ──
try:
    prev = {int(k): v for k, v in (state_get("tochka-sedmica").get("stock") or {}).items()}
except Exception:
    prev = {}
items = []
for aid in sorted(TRACKED):
    if aid not in stock:
        continue
    name, cur = stock[aid]
    rc, ro_ = recv_cex.get(aid, 0.0) + recv_oth.get(aid, 0.0), used.get(aid, 0.0)
    if not (rc or ro_ or cur):
        continue
    start = prev.get(aid)
    if aid in FRESH:                     # нулират се всяка вечер → сравняваме получено с нужно по рецепти (+ = остатък/брак, − = ползвано повече от получено)
        diff, cover = None, None
        fresh_gap = round(rc - ro_, 2)
    else:
        fresh_gap = None
        expected = None if start is None else start + rc - ro_
        diff = None if expected is None else round(cur - expected, 2)
        per_day = ro_ / ndays
        cover = (cur / per_day) if (per_day > 0 and cur >= 0) else None
    per_day = ro_ / ndays
    items.append({"id": aid, "name": name, "recv": rc, "used": ro_, "cur": cur, "diff": diff, "cover": cover, "per_day": per_day, "fresh": aid in FRESH, "fresh_gap": fresh_gap})
state_put("tochka-sedmica", {"date": today.isoformat(), "stock": {str(i): stock[i][1] for i in TRACKED if i in stock}})

f = lambda x: str(round(x, 1)).replace(".", ",")
neg = sorted([i for i in items if i["cur"] < -0.05 and not i["fresh"]], key=lambda i: i["cur"])
fresh = sorted([i for i in items if i["fresh"] and i["fresh_gap"] is not None and abs(i["fresh_gap"]) >= 0.5], key=lambda i: -abs(i["fresh_gap"]))
gaps = sorted([i for i in items if i["diff"] is not None and abs(i["diff"]) >= 1], key=lambda i: -abs(i["diff"]))
low = sorted([i for i in items if (not i["fresh"]) and i["cover"] is not None and i["cover"] < 1 and i["per_day"] >= 0.3], key=lambda i: i["cover"])
dd = lambda s: ".".join(s.split("-")[::-1][:2])
out = ["📊 Точка · седмица %s–%s" % (dd(A), dd(B))]
out.append("На минус сега: " + ("; ".join("%s %s" % (i["name"], f(i["cur"])) for i in neg[:6]) if neg else "няма") + ("" if len(neg) <= 6 else " (+%d)" % (len(neg) - 6)))
if fresh:
    out.append("Пресни (получено → нужно по рецепти): " + "; ".join("%s %s → %s (%s%s)" % (i["name"], f(i["recv"]), f(i["used"]), "+" if i["fresh_gap"] > 0 else "−", f(abs(i["fresh_gap"]))) for i in fresh[:6]) + ". Минус = използвано повече от получено.")
else:
    out.append("Пресни заготовки: получено и нужно се връзват.")
if gaps:
    out.append("Други разминавания (реално − очаквано): " + "; ".join("%s %s%s" % (i["name"], "+" if i["diff"] > 0 else "−", f(abs(i["diff"]))) for i in gaps[:6]))
if low:
    out.append("Свършват (по-малко от 1 ден): " + "; ".join("%s (%s, ~%s/ден)" % (i["name"], f(i["cur"]), f(i["per_day"])) for i in low[:6]))
if not low:
    out.append("Свършват (по-малко от 1 ден): няма")
out.append("От цеха получено: %d артикула; продадени артикули: %d (без рецепта: %d)%s." % (len(recv_cex), len(sold), norecipe, ("; не се прочетоха %d документа" % errs) if errs else ""))
if not prev:
    out.append("(първо пускане — „други разминавания“ от следващата седмица)")
print("\n".join(out))
