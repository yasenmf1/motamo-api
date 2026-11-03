# MOTAMO — оборот на точката до момента (само четене). Пуска се от задачата motamo-shop-turnover.
# Печата готовия текст за известието. Ключовете се четат локално и не се печатат.
import json, re, sys, urllib.request, datetime as dt, time

from lib import env, anon, sofia_now, notify, heartbeat
PEEK = env("PEEK_TOKEN")
ANON = anon()

def post(url, body):
    r = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json"})
    return json.load(urllib.request.urlopen(r, timeout=60))

data = None
for attempt in range(2):
    try:
        j = post("https://motamo-api.vercel.app/api/peek", {"token": PEEK, "action": "Accounts_getlist",
                 "params": {"order_by": "account_id desc", "length": 600}})
        data = j.get("data"); break
    except Exception:
        time.sleep(30)
if data is None:
    print("Отчетът за оборота не успя: Barsy не отговаря"); notify("Отчетът за оборота не успя: Barsy не отговаря"); sys.exit(0)
data = data if isinstance(data, list) else list(data.values())

now = sofia_now()
hm, today, week = now.strftime("%H:%M:%S"), now.strftime("%Y-%m-%d"), (now - dt.timedelta(days=7)).strftime("%Y-%m-%d")
day = lambda d: [a for a in data if str(a.get("create_date", ""))[:10] == d and str(a["create_date"])[11:] <= hm and float(a.get("total_sum") or 0) > 0]
s = lambda L: round(sum(float(a["total_sum"]) for a in L), 2)
T, W = day(today), day(week)
on = [a for a in T if a.get("user_name") == "Motamo Online"]; cn = [a for a in T if a.get("user_name") != "Motamo Online"]

ads = ""
try:
    r = urllib.request.Request(f"https://ptzgxreojfvdltbavlop.supabase.co/rest/v1/order_attribution?created_at=gte.{today}T00:00:00%2B03:00&select=total,utm_source,fbclid",
                               headers={"apikey": ANON, "Authorization": "Bearer " + ANON})
    rows = json.load(urllib.request.urlopen(r, timeout=20))
    fb = [x for x in rows if x.get("utm_source") == "facebook" or x.get("fbclid")]
    ads = f", от реклама {len(fb)}" + (f" ({round(sum(float(x['total'] or 0) for x in fb), 2)} €)" if fb else "")
except Exception:
    pass

dn = ["пн", "вт", "ср", "чт", "пт", "сб", "нд"][now.weekday()]
cmp = f"{round((s(T) / s(W) - 1) * 100):+d} %" if s(W) else "няма база"
chk = round(s(T) / len(T), 2) if T else 0
end = " · ден приключен" if now.hour >= 19 and now.minute >= 25 else ""
text = (f"🏪 Точка {now:%d.%m} до {now:%H:%M}: {s(T)} € · {len(T)} сметки · чек {chk} €{end}\n"
        f"Щанд {s(cn)} € ({len(cn)}) · Онлайн {s(on)} € ({len(on)}){ads} · спрямо мин. {dn} {cmp}")
# 03.11 — предупреждение: след 17:00 и оборот под −35 % спрямо същия ден миналата седмица
if now.hour >= 17 and s(W) and (s(T) / s(W) - 1) < -0.35:
    text += f"\n⚠ Оборотът е необичайно нисък: {s(T)} € срещу {s(W)} € миналия {dn} до същия час ({round((s(T) / s(W) - 1) * 100):+d} %)."
sys.stdout.reconfigure(encoding="utf8")
print(text)

notify(text)
heartbeat('turnover')
