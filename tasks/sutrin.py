# MOTAMO — агент „Точка“, сутрешно съобщение: какво е спряно от продажба + какви заявки към цеха има за днес.
# Само четене. Печата готовия текст (задачата го праща през notify.py). Ключовете не се печатат.
import datetime as dt, json, os, re, subprocess, sys, urllib.request

sys.stdout.reconfigure(encoding="utf8")
from lib import anon, sofia_now, notify, heartbeat
CHECK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check.py")

# 1) спрени артикули (логиката на check.py; тя сама пази state.json)
p = subprocess.run([sys.executable, CHECK], capture_output=True, text=True, encoding="utf-8", timeout=120)
out = p.stdout.strip().splitlines()
if p.returncode != 0 or any(l.startswith("ГРЕШКА") for l in out):
    stopped_txt = "Спрени артикули: не успях да проверя (" + next((l for l in out if l.startswith("ГРЕШКА")), "грешка") + ")"
else:
    st = [l for l in out if l.startswith("СПРЯН:")]
    noal = [l for l in out if l.startswith("БЕЗ АЛЕРГЕНИ")]
    if not st:
        stopped_txt = "✅ Няма спрени от продажба артикули."
    else:
        stopped_txt = "⛔ Спрени от продажба:\n" + "\n".join("• " + l[len("СПРЯН: "):].replace(" (id ", " (").strip() for l in st)
    if noal:
        stopped_txt += "\nБез алергени в таблицата: " + "; ".join(l.split(": ", 1)[1] for l in noal)

# 2) заявки на точката към цеха за днес (Supabase transfer_requests, четене)
ANON = anon()
OFFSET = dt.timedelta(hours=round((sofia_now() - dt.datetime.utcnow()).total_seconds() / 3600))
today = sofia_now().strftime("%Y-%m-%d")
try:
    r = urllib.request.Request("https://ptzgxreojfvdltbavlop.supabase.co/rest/v1/transfer_requests?for_date=eq.%s&order=created_at.asc" % today,
                               headers={"apikey": ANON, "Authorization": "Bearer " + ANON})
    reqs = [x for x in json.load(urllib.request.urlopen(r, timeout=30)) if x.get("status") != "cancelled"]
except Exception as e:
    reqs = None
    req_txt = "Заявки към цеха: не успях да прочета (%s)" % type(e).__name__
if reqs is not None:
    if not reqs:
        req_txt = "📝 Още няма заявка към цеха за днес."
    else:
        lines = []
        for x in reqs:
            hm = (dt.datetime.fromisoformat(x["created_at"].replace("Z", "+00:00")).replace(tzinfo=None) + OFFSET).strftime("%H:%M")
            stt = {"done": "изпълнена", "pending": "чака цеха", "error": "ГРЕШКА"}.get(x.get("status"), x.get("status"))
            its = []
            for it in x.get("items", []):
                pk = it.get("pack")
                q = ("%g %s" % (pk["count"], pk["plural"] if pk["count"] != 1 else pk["name"])) if pk and pk.get("count") else ("%g %s" % (it.get("qty"), it.get("unit", "")))
                its.append("%s — %s" % (it.get("name"), q.strip()))
            lines.append("• %s · %s: %s" % (hm, stt, "; ".join(its)))
        req_txt = "📝 Заявки към цеха днес:\n" + "\n".join(lines)

txt = "🏪 Точка · сутрин %s\n%s\n%s" % (sofia_now().strftime("%d.%m"), stopped_txt, req_txt)
print(txt)
notify(txt)
heartbeat("sutrin")
