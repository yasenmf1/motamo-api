# MOTAMO Цех — помощник за агента „Цех“. Токенът се чете от файла с ключовете и НИКОГА не се печата.
# Употреба:
#   python ceh.py shortage            суровини, които няма да стигнат за днешния разнос
#   python ceh.py razos [YYYY-MM-DD]  обекти от разноса за деня, още без стокова (по подразбиране ДНЕС)
#   python ceh.py expiring [дни]      партиди със срок до N дни (по подразбиране 3)
#   python ceh.py stock [част от име] наличности (с филтър по име)
#   python ceh.py link                връзка към екрана „Наличности“ (за собственика)
#   python ceh.py photo <file_id>    тегли снимка от Telegram → пише път до файла
#   python ceh.py load_dry <файл.json>   суха проба на зареждане (НЕ пише в Barsy)
#   python ceh.py load_write <файл.json> реален запис в склада (само след „да“ на собственика)
import datetime, json, os, sys, urllib.request
import lib
lib.patch_today()

sys.stdout.reconfigure(encoding="utf8")
HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://motamo-api.vercel.app/api/cex-plan"
from lib import env, ROOT, sofia_now


def key(name):
    v = env(name)
    if not v:
        sys.exit("липсва ключ " + name)
    return v


def call(payload):
    payload = dict(payload, token=key("CEX_TOOL_TOKEN"))
    r = urllib.request.Request(API, json.dumps(payload).encode(), {"content-type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r, timeout=60))
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"ok": False, "error": "http_%s" % e.code}
    except Exception as e:
        return {"ok": False, "error": type(e).__name__}


cmd = sys.argv[1] if len(sys.argv) > 1 else ""
arg = sys.argv[2] if len(sys.argv) > 2 else ""

if cmd == "shortage":
    d = call({"action": "shortage"})
    if not d.get("ok"):
        print("ГРЕШКА", d.get("error")); sys.exit(1)
    print("дата", d.get("date"), "сметки в разноса", d.get("razos_accounts"))
    for s in d.get("shortages", []):
        print(s.get("cat"), "|", s.get("name"), "| има", s.get("have"), "| трябва", s.get("need"), "| липсва", s.get("deficit"))

elif cmd == "razos":
    date = arg or datetime.date.today().isoformat()
    d = call({"action": "load_razos", "date": date})
    if not d.get("ok"):
        print("ГРЕШКА", d.get("error")); sys.exit(1)
    shops = d.get("shops", [])
    print("дата", d.get("date"), "обекти", len(shops))
    for s in shops:
        print(("С" if s.get("has_stokova") else "БЕЗ"), "|", s.get("client"), "|", s.get("rep"), "|", s.get("total"))

elif cmd == "oborot":
    # Оборот на ЦЕХА БЕЗ ДДС: ден срещу същия ден миналата седмица, седмица срещу седмица, месец срещу месец.
    # Данните са „Продажби по артикули“ на цеха (Reports_sales_by_articles; revenue = total_no_dds).
    D = datetime.date
    today = D.today()
    upto = today if (len(sys.argv) > 2 and sys.argv[2] == "includetoday") else today   # вечерта вече е целият ден

    def rev(a, b):
        r = call({"action": "sales_articles", "from": a.isoformat(), "to": b.isoformat()})
        if not r.get("ok"):
            return None
        return (r.get("totals") or {}).get("revenue", 0.0), bool(r.get("incomplete"))

    def line(label, cur, prev, ca, cb, pa, pb):
        if cur is None or prev is None:
            return "%s: няма данни" % label
        c, p = cur[0], prev[0]
        pct = ("%+.0f %%" % ((c - p) / p * 100)) if p else "—"
        note = " (непълни данни)" if (cur[1] or prev[1]) else ""
        return "%s: %.2f € срещу %.2f € (%s) [%s–%s срещу %s–%s]%s" % (label, c, p, pct, ca.strftime("%d.%m"), cb.strftime("%d.%m"), pa.strftime("%d.%m"), pb.strftime("%d.%m"), note)

    # ден: днес срещу същия ден миналата седмица
    pd = today - datetime.timedelta(days=7)
    print(line("ДЕН", rev(today, today), rev(pd, pd), today, today, pd, pd))
    # седмица до момента (Пн..днес) срещу същия период на миналата седмица
    ws = today - datetime.timedelta(days=today.weekday())
    pws = ws - datetime.timedelta(days=7)
    pwe = pws + datetime.timedelta(days=(today - ws).days)
    print(line("СЕДМИЦА до днес", rev(ws, today), rev(pws, pwe), ws, today, pws, pwe))
    # цяла последна седмица срещу предходната
    lws, lwe = ws - datetime.timedelta(days=7), ws - datetime.timedelta(days=1)
    plws, plwe = lws - datetime.timedelta(days=7), lws - datetime.timedelta(days=1)
    print(line("МИНАЛА СЕДМИЦА", rev(lws, lwe), rev(plws, plwe), lws, lwe, plws, plwe))
    # месец до момента срещу същия период на миналия месец
    ms = today.replace(day=1)
    lme = ms - datetime.timedelta(days=1)
    pms = lme.replace(day=1)
    pme = min(pms.replace(day=min(today.day, lme.day)), lme)
    print(line("МЕСЕЦ до днес", rev(ms, today), rev(pms, pme), ms, today, pms, pme))
    # цял миналия месец срещу предходния
    plme = pms - datetime.timedelta(days=1)
    plms = plme.replace(day=1)
    print(line("МИНАЛ МЕСЕЦ", rev(pms, lme), rev(plms, plme), pms, lme, plms, plme))

elif cmd == "boxes":
    # колко порции поке и колко суши (сетове/ролки) са в разноса за деня → толкова купи/кутии
    date = arg or datetime.date.today().isoformat()
    d = call({"action": "load_razos", "date": date})
    if not d.get("ok"):
        print("ГРЕШКА", d.get("error")); sys.exit(1)
    poke, sushi = {}, {}
    for s in d.get("shops", []):
        for name, q in (s.get("order") or {}).items():
            try:
                q = float(q)
            except Exception:
                continue
            if q <= 0:
                continue
            tgt = poke if name.lower().startswith("poke") else sushi
            tgt[name] = tgt.get(name, 0) + q
    print("дата", d.get("date"), "обекти", len(d.get("shops", [])))
    print("ПОКЕ (купи) общо:", round(sum(poke.values()), 1))
    for n, q in sorted(poke.items(), key=lambda x: -x[1]):
        print("  ", n, round(q, 1))
    print("СУШИ (кутии) общо:", round(sum(sushi.values()), 1))
    for n, q in sorted(sushi.items(), key=lambda x: -x[1]):
        print("  ", n, round(q, 1))

elif cmd == "equalize":
    # Изравняване на склад „Точка“ в ЦЕХА с реалната наличност в Barsy на точката (брак за излишъка).
    # Без аргумент = само показва. `equalize write` = прави документ „Изписване“ (type -1) в цеха.
    import re
    src = open(os.path.join(ROOT, "api", "transfer.js"), encoding="utf8").read()
    block = re.search(r"const MAP = \{(.*?)\};", src, re.S).group(1)
    MAP = {int(a): int(b) for a, b in re.findall(r"(\d+):\s*(\d+)", re.sub(r"//[^\n]*", "", block))}

    def peek(action, params, host):
        body = json.dumps({"token": key("PEEK_TOKEN"), "action": action, "host": host, "params": params}).encode()
        r = urllib.request.Request("https://motamo-api.vercel.app/api/peek", body, {"content-type": "application/json"})
        return json.load(urllib.request.urlopen(r, timeout=90))

    def amounts(host, depot=None):
        f = {"depot_id": depot} if depot else {}
        L = peek("Articles_getlistobject", {"filters": f, "extra_properties": ["store_amount"]}, host)["data"]["list"]
        return {int(a["article_id"]): (a["article_name"], float(a.get("store_amount") or 0)) for a in L}

    cex2, shop = amounts("cex", 2), amounts("shop")
    rows, report = [], []
    for cid, sid in sorted(MAP.items()):
        if cid not in cex2 or sid not in shop:
            continue
        name, have = cex2[cid]
        real = max(shop[sid][1], 0.0)          # на минус в точката → цел 0
        diff = round(have - real, 4)
        if diff > 0.0005:                      # излишък в „Точка“ на цеха → изписваме
            rows.append({"row_id": "", "article_id": cid, "article_name": name, "amount": diff, "notes": ""})
            report.append("%s | в цеха/Точка %s → реално %s | брак %s" % (name, round(have, 3), round(real, 3), diff))
    print("артикули за изравняване:", len(rows), "от", len(MAP))
    for line in report:
        print(" ", line)
    if arg == "write" and rows:
        body = {"token": key("CEX_TOOL_TOKEN"), "action": "article_form", "host": "cex", "id": rows[0]["article_id"], "method": "Storeouts_save", "params": {"id": None},
                "top": {"id": None, "action_type": "save_and_close",
                        "values": {"depot_id": "2", "type_id": "-1", "doc_date": None, "description": "Брак — изравняване на склад Точка с реалното от точката (%s)" % datetime.date.today().isoformat()},
                        "rows": rows}}
        r = urllib.request.Request(API, json.dumps(body).encode(), {"content-type": "application/json"})
        d = json.load(urllib.request.urlopen(r, timeout=90))
        print("ЗАПИСАНО:", d.get("head"))

elif cmd == "expiring":
    d = call({"action": "lots_expiring", "days": int(arg) if arg.isdigit() else 3})
    if not d.get("ok"):
        print("ГРЕШКА", d.get("error")); sys.exit(1)
    # само СУРОВИНИ и ЗАГОТОВКИ (готовата продукция за разноса има 3-дневен срок и не е сигнал)
    rows = [r for r in d.get("rows", []) if r.get("cat") in ("Суровини", "Заготовки")]
    soon = [r for r in rows if not r.get("expired")]
    gone = [r for r in rows if r.get("expired")]
    print("днес", d.get("today"), "| изтичат до", d.get("days"), "дни:", len(soon), "| вече изтекли, още с наличност:", len(gone))
    for r in soon:
        print("изтича", r.get("exp"), "|", r.get("name"), "| партида", r.get("lot"), "| кол.", r.get("qty"))
    if gone:
        print("ИЗТЕКЛИ (по-стари първо, пръв 8):")
        for r in gone[:8]:
            print(" ", r.get("exp"), "|", r.get("name"), "| партида", r.get("lot"), "| кол.", r.get("qty"))

elif cmd == "stock":
    d = call({"action": "stock"})
    if not d.get("ok"):
        print("ГРЕШКА", d.get("error")); sys.exit(1)
    for r in d.get("rows", []):
        if not arg or arg.lower() in str(r.get("name", "")).lower():
            print(r.get("cat"), "|", r.get("name"), "|", r.get("qty"))

elif cmd == "link":
    # връзка към екрана „Наличности“ — праща се на собственика, не се записва никъде
    print(API + "?view=stock&k=" + key("CEX_TOOL_TOKEN"))

elif cmd == "photo":
    tok = key("TELEGRAM_BOT_TOKEN")
    info = json.load(urllib.request.urlopen("https://api.telegram.org/bot%s/getFile?file_id=%s" % (tok, arg), timeout=30))
    path = info["result"]["file_path"]
    os.makedirs(os.path.join(HERE, "inbox"), exist_ok=True)
    out = os.path.join(HERE, "inbox", arg[-12:] + ".jpg")
    open(out, "wb").write(urllib.request.urlopen("https://api.telegram.org/file/bot%s/%s" % (tok, path), timeout=60).read())
    print(out)

elif cmd in ("load_dry", "load_write"):
    body = json.load(open(arg, encoding="utf8"))
    body["action"] = "create_load"
    if cmd == "load_write":
        body["dry"] = False
        body["draft"] = False
    else:
        body.pop("dry", None)  # без dry:false = само сглобява
    print(json.dumps(call(body), ensure_ascii=False)[:3000])

else:
    print(__doc__)
