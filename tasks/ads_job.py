# Агент „Реклама“ в облака: дневен преглед на Meta кампанията „Поке · Делници“ + поръчки от реклама от сайта.
# Поръчките идват от Supabase (order_attribution). Разходът от Meta иска GitHub secret META_TOKEN (ads_read към акаунт 1536704666764521);
# без него пращам само поръчките и казвам, че Meta още не е свързан.   python ads_job.py [--dry]
import datetime as dt, json, os, sys, urllib.error, urllib.parse, urllib.request
from lib import env, sb, sofia_now, notify, heartbeat
from llm import ask

DRY = "--dry" in sys.argv
CAMPAIGN = "120254238856630729"
G = "https://graph.facebook.com/v21.0/"
START, END, BUDGET = dt.date(2026, 11, 2), dt.date(2026, 11, 20), 100.0


def graph(path, **q):
    q["access_token"] = env("META_TOKEN")
    return json.load(urllib.request.urlopen(G + path + "?" + urllib.parse.urlencode(q), timeout=60))


def act(lst, name):
    for a in lst or []:
        if a.get("action_type") == name:
            return float(a.get("value") or 0)
    return 0.0


def meta(preset):
    d = graph(CAMPAIGN + "/insights", fields="spend,impressions,reach,frequency,inline_link_clicks,cpc,actions,action_values", date_preset=preset)
    r = (d.get("data") or [{}])[0]
    return {"spend": float(r.get("spend") or 0), "impr": int(r.get("impressions") or 0), "clicks": int(r.get("inline_link_clicks") or 0),
            "cpc": float(r.get("cpc") or 0), "freq": float(r.get("frequency") or 0), "buys": act(r.get("actions"), "omni_purchase") or act(r.get("actions"), "purchase"),
            "value": act(r.get("action_values"), "omni_purchase") or act(r.get("action_values"), "purchase")}


def orders():
    today = sofia_now().date()
    since = (today - dt.timedelta(days=7)).isoformat()
    rows = sb("order_attribution?created_at=gte.%sT00:00:00%%2B02:00&select=created_at,total,utm_source,fbclid" % since) or []
    ads = lambda rs: [x for x in rs if (x.get("utm_source") or "").lower() in ("facebook", "instagram", "ig", "fb", "meta") or x.get("fbclid")]
    y = (today - dt.timedelta(days=1)).isoformat()
    ry = [x for x in rows if str(x.get("created_at", ""))[:10] == y]
    s = lambda rs: round(sum(float(x.get("total") or 0) for x in rs), 2)
    return "Сайт: вчера %d онлайн поръчки, %d от реклама (%s €) · 7 дни: %d от реклама (%s €)" % (len(ry), len(ads(ry)), s(ads(ry)), len(ads(rows)), s(ads(rows)))


today = sofia_now().date()
y = today - dt.timedelta(days=1)
head = "📣 Реклама „Делници“ · данни за %s" % y.strftime("%d.%m")
ord_line = orders()
if today < START:
    text = "📣 Реклама „Делници“ тръгва %s.\n%s" % (START.strftime("%d.%m"), ord_line)
elif not env("META_TOKEN"):
    text = head + "\nMeta още не е свързан с облака (липсва META_TOKEN) — разходът не се чете.\n" + ord_line
else:
    try:
        info = graph(CAMPAIGN, fields="name,effective_status,start_time,stop_time")
        d1, tot = meta("yesterday"), meta("maximum")
        weekend = y.weekday() >= 5
        days_done = sum(1 for i in range((min(y, END) - START).days + 1) if (START + dt.timedelta(days=i)).weekday() < 5)
        days_all = sum(1 for i in range((END - START).days + 1) if (START + dt.timedelta(days=i)).weekday() < 5)
        expect = BUDGET * days_done / days_all
        facts = ("Статус: %s · край %s\nВчера (%s%s): %.2f € · %d показв. · %d клика (CPC %.2f €) · покупки: %g (%.0f €)\n"
                 "Общо от старта: %.2f € от %.0f € (очаквано до днес ≈ %.0f €) · показв. %d · покупки %g%s\n%s") % (
            info.get("effective_status"), END.strftime("%d.%m"), y.strftime("%d.%m"), ", уикенд — няма показване" if weekend else "", d1["spend"], d1["impr"], d1["clicks"], d1["cpc"], d1["buys"], d1["value"],
            tot["spend"], BUDGET, expect, tot["impr"], tot["buys"], (" → цена на покупка %.2f €" % (tot["spend"] / tot["buys"])) if tot["buys"] else "", ord_line)
        note = ask("Данни за рекламата (граница за цена на покупка 6 €, CPC над 0,60 € е лошо, честота над 3 = умора, нули в делничен ден при активна кампания = заседнала):\n" + facts +
                   "\nНапиши 3 кратки реда „Какво значи“: тълкуване (харчи ли се по план), сравнение, и ЕДНО действие за днес (или „нищо“). Прост български, без markdown, нищо не измисляй; предположенията ги означи.",
                   system="Ти си агент „Реклама“ на MOTAMO. Само четеш и предлагаш; нищо не променяш.", max_tokens=2500)
        text = head + "\n" + facts + (("\n\nКакво значи\n" + note) if note else "")
    except Exception as e:
        text = head + "\n📣 Реклама: Meta не отговори днес (%s)\n%s" % (type(e).__name__, ord_line)

print(text)
if not DRY:
    notify(text)
    heartbeat("ads")
