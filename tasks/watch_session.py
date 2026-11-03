# Следи на живо работата на собственика (само четене): грешки в журнала, записани/пратени планове, нови стокови/сметки/производства в Barsy.
# python watch_session.py   — печата по ред на ВСЯКА промяна; спира сам след 90 мин.
import json, sys, time, urllib.request
from lib import env, sb, sofia_now

sys.stdout.reconfigure(encoding="utf8", line_buffering=True)
PEEK = env("PEEK_TOKEN")


def peek(action, params):
    rq = urllib.request.Request("https://motamo-api.vercel.app/api/peek", json.dumps({"token": PEEK, "action": action, "host": "cex", "params": params}).encode(), {"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(rq, timeout=60))
    d = d.get("data")
    return d if isinstance(d, list) else (d.get("list") or list(d.values()) if isinstance(d, dict) else [])


def now():
    return sofia_now().strftime("%H:%M")


seen_err = (sb("error_log?select=at&order=at.desc&limit=1") or [{}])[0].get("at", "")
seen_plan = (sb("cex_kitchen_plan?select=for_date,updated_at&order=updated_at.desc&limit=1") or [{}])[0].get("updated_at", "")
seen_tg = (sb("cex_tg_sent?select=sent_at&order=sent_at.desc&limit=1") or [{}])[0].get("sent_at", "")
inv0 = max([int(x["inv_id"]) for x in peek("Invoices_getlist", {"order_by": "inv_id desc", "length": 5})] or [0])
acc0 = max([int(x["account_id"]) for x in peek("Accounts_getlist", {"order_by": "account_id desc", "length": 5})] or [0])
print("%s следя… (документ >%d, сметка >%d)" % (now(), inv0, acc0))

end = time.time() + 90 * 60
while time.time() < end:
    time.sleep(45)
    try:
        for r in sb("error_log?select=at,source,message&at=gt.%s&order=at.asc" % seen_err.replace("+", "%2B")) or []:
            seen_err = r["at"]
            print("%s ⚠ ГРЕШКА %s — %s" % (now(), r["source"], r["message"][:140]))
        p = (sb("cex_kitchen_plan?select=for_date,updated_at&order=updated_at.desc&limit=1") or [{}])[0]
        if p.get("updated_at", "") > seen_plan:
            seen_plan = p["updated_at"]; print("%s 📋 запазен план за %s" % (now(), p["for_date"]))
        t = (sb("cex_tg_sent?select=kind,for_date,sent_at&order=sent_at.desc&limit=1") or [{}])[0]
        if t.get("sent_at", "") > seen_tg:
            seen_tg = t["sent_at"]
            if t["kind"] in ("plan",):
                print("%s ✈ ПРАТЕНО в Telegram: %s за %s" % (now(), t["kind"], t["for_date"]))
        for x in sorted(peek("Invoices_getlist", {"order_by": "inv_id desc", "length": 12}), key=lambda y: int(y["inv_id"])):
            if int(x["inv_id"]) > inv0:
                inv0 = int(x["inv_id"]); print("%s 📄 нов документ №%s (тип %s, клиент %s, %s €)" % (now(), x.get("inv_num"), x.get("type_id"), x.get("client_id"), x.get("total")))
        for x in sorted(peek("Accounts_getlist", {"order_by": "account_id desc", "length": 12}), key=lambda y: int(y["account_id"])):
            if int(x["account_id"]) > acc0:
                acc0 = int(x["account_id"]); print("%s 🧾 нова сметка №%s (клиент %s)" % (now(), x["account_id"], x.get("client_name") or x.get("client_id")))
    except Exception as e:
        print("%s (проверката се запъна: %s)" % (now(), type(e).__name__))
print("край на наблюдението")
