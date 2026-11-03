# Еднократно нулиране на пресните заготовки (собственикът каза „да“ 02.11): точка (Barsy motamoshop) и склад „Точка“ в цеха.
# python reset_fresh.py          → само показва (суха проба)
# python reset_fresh.py write    → записва: брак за плюсовете, корекция-зареждане за минусите, после проверка
import datetime, json, os, subprocess, sys, urllib.request
import lib
lib.patch_today()

sys.stdout.reconfigure(encoding="utf8")
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
NIGHT = MODE == "night"            # вечерен режим: с предпазител, описания „неотчетен остатък“
WRITE = MODE in ("write", "night")
GUARD_KG = 60                      # над толкова на артикул — не пише сам, само алармира
TODAY = datetime.date.today().isoformat()
HERE = os.path.dirname(os.path.abspath(__file__))
MAP = {70: 286, 67: 287, 59: 283, 68: 288, 65: 289, 131: 290, 72: 285, 66: 284, 73: 281, 69: 282, 78: 0}  # цех → точка за заготовките


def key(n):
    return lib.env(n)


def post(url, body):
    r = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(r, timeout=90))
    except urllib.error.HTTPError as e:
        return {"ok": False, "err": e.code, "body": e.read().decode()[:300]}


def peek(action, params, host):
    return post("https://motamo-api.vercel.app/api/peek", {"token": key("PEEK_TOKEN"), "action": action, "host": host, "params": params})


def stock(host, depot=None):
    f = {"depot_id": depot} if depot else {}
    L = peek("Articles_getlistobject", {"filters": f, "extra_properties": ["store_amount"]}, host)["data"]["list"]
    return {int(a["article_id"]): (a["article_name"], round(float(a.get("store_amount") or 0), 4)) for a in L}


def save(host, method, top, any_id):
    return post("https://motamo-api.vercel.app/api/cex-plan", {"token": key("CEX_TOOL_TOKEN"), "action": "article_form", "host": host, "id": any_id, "method": method, "params": {"id": None}, "top": top})


# имената на заготовките (категория „Заготовки“ в цеха)
out = subprocess.run([sys.executable, os.path.join(HERE, "ceh.py"), "stock"], capture_output=True, text=True, encoding="utf8").stdout
ZAG = set(l.split(" | ")[1] for l in out.splitlines() if l.startswith("Заготовки"))

# ── 1) ТОЧКА (Barsy motamoshop) ──────────────────────────────────────────
shop = stock("shop")
shop_fresh = {i: v for i, v in shop.items() if v[0] in ZAG or v[0].startswith("заг.")}
outs, loads = [], []
for i, (n, q) in sorted(shop_fresh.items()):
    if q > 0.0005:
        outs.append({"row_id": "", "article_id": i, "article_name": n, "amount": q, "notes": ""})
    elif q < -0.0005:
        cost = 1.46
        amt = round(-q, 4)
        loads.append({"store_load_row_id": "", "article_id": str(i), "original_article_name": n, "amount": str(amt), "current_price": str(cost), "delivery_price": str(cost),
                      "delivery_total": str(round(cost * amt, 2)), "delivery_tax_id": "100", "actual_tax_id": "100", "tax": "0", "tax_sum": "0", "discount": "0",
                      "lot_value": "", "lot_exp_date": None, "lot_detail_id": "", "notes": "Корекция на наличност", "amount_unit": "1", "is_group_art": 0})
print("ТОЧКА — брак (изписване):", [(r["article_name"], r["amount"]) for r in outs])
print("ТОЧКА — корекция (зареждане):", [(r["original_article_name"], r["amount"]) for r in loads])

# ── 2) ЦЕХ, склад „Точка“ (депо 2) ────────────────────────────────────────
cex2 = stock("cex", 2)
cex_fresh = {i: v for i, v in cex2.items() if v[0] in ZAG or v[0].startswith("заг.")}
couts = [{"row_id": "", "article_id": i, "article_name": n, "amount": q, "notes": ""} for i, (n, q) in sorted(cex_fresh.items()) if q > 0.0005]
print("ЦЕХ/Точка — изписване:", [(r["article_name"], r["amount"]) for r in couts])
big = [(r["article_name"], r["amount"]) for r in outs] + [(r["original_article_name"], float(r["amount"])) for r in loads] + [(r["article_name"], r["amount"]) for r in couts]
big = [b for b in big if b[1] > GUARD_KG]
if NIGHT and big:
    print("ПРЕДПАЗИТЕЛ: голямо разминаване над %s — НЕ записвам, виж ръчно: %s" % (GUARD_KG, big))
    WRITE = False

if WRITE:
    if outs:
        r = save("shop", "Storeouts_save", {"id": None, "action_type": "save_and_close",
                 "values": {"depot_id": "1", "type_id": "-1", "doc_date": None, "description": ("Неотчетен остатък на пресните заготовки — край на деня (%s)" if NIGHT else "Брак — нулиране на пресните заготовки (%s)") % TODAY}, "rows": outs}, outs[0]["article_id"])
        print("  изписване точка:", r.get("head") or r)
    if loads:
        r = save("shop", "Storeloads_save", {"id": None, "action_type": "save_and_close",
                 "values": {"store_load_id": None, "operation_type": "1", "depot_id": "1", "doc_type_id": "3", "doc_date": TODAY + " 00:00:00", "doc_num": "КОР-" + TODAY + ("-N" if NIGHT else ""),
                            "supplier_id": "4", "has_tax": 0, "price_mode": 0, "fill_delivery_price": 0, "currency_id": "1", "currency_rate": "1", "store_load_cat_id": "1",
                            "discount": "0", "total_costs": 0, "description": "Корекция на наличност (минус от недокументиран ориз) — не е доставка"}, "rows": loads}, int(loads[0]["article_id"]))
        print("  зареждане точка:", r.get("head") or r)
    after = stock("shop")
    print("ТОЧКА след записа:", {n: q for i, (n, q) in after.items() if i in shop_fresh})


if WRITE and couts:
    r = save("cex", "Storeouts_save", {"id": None, "action_type": "save_and_close",
             "values": {"depot_id": "2", "type_id": "-1", "doc_date": None, "description": "Корекция на склад Точка (пресни заготовки, вече използвани в точката) — не е реален брак (%s)" % TODAY}, "rows": couts}, couts[0]["article_id"])
    print("  изписване цех:", r.get("head") or r)
    after = stock("cex", 2)
    print("ЦЕХ/Точка след записа:", {n: q for i, (n, q) in after.items() if i in cex_fresh})
    print("ЦЕХ/Основен непроменен:", {n: q for i, (n, q) in stock("cex", 1).items() if i in cex_fresh})
