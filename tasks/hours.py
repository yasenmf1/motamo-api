# MOTAMO · агент „Точка“ — месечен отчет за часовете (САМО ЧЕТЕНЕ; към собственика).
# Данните са от бота „Започнах/Приключих“ (Supabase time_log) през вече съществуващия изглед на motamo-api:
#   GET /api/transfer?view=hours&k=<ключ>&m=YYYY-MM&fmt=csv   (ключът = sha256("motamo-hours:"+PEEK_TOKEN)[:24], смята се тук и не се печата)
# Употреба: python hours.py            → праща се САМО ако утре е нов месец (иначе печата „SKIP“)
#           python hours.py --force [YYYY-MM]   → за проба/ръчно
#           python hours.py --file път.csv      → суха проба от файл (без мрежа)
import csv, datetime, hashlib, io, sys, urllib.request

sys.stdout.reconfigure(encoding="utf8")
import lib
lib.patch_today()
from lib import env


def key(n):
    return env(n)


args = sys.argv[1:]
today = datetime.date.today()
tomorrow = today + datetime.timedelta(days=1)
force = "--force" in args
if "--file" not in args and not force and tomorrow.day != 1:
    print("SKIP")
    sys.exit(0)
ym = next((a for a in args if len(a) == 7 and a[4] == "-"), today.strftime("%Y-%m"))

if "--file" in args:
    text = open(args[args.index("--file") + 1], encoding="utf-8-sig").read()
else:
    k = hashlib.sha256(("motamo-hours:" + key("PEEK_TOKEN")).encode()).hexdigest()[:24]
    u = "https://motamo-api.vercel.app/api/transfer?view=hours&k=%s&m=%s&fmt=csv" % (k, ym)
    try:
        text = urllib.request.urlopen(u, timeout=60).read().decode("utf-8-sig")
    except Exception as e:
        print("ГРЕШКА: не прочетох часовете (%s)" % type(e).__name__)
        sys.exit(1)

rows = list(csv.DictReader(io.StringIO(text)))
mm = ".".join(ym.split("-")[::-1])
if not rows:
    print("⏱ Часове за %s: още няма записани часове (екипът не е започнал да натиска „Започнах/Приключих“ в бота)." % mm)
    sys.exit(0)

by = {}
for r in rows:
    key_ = (r["Обект"], r["Служител"])
    p = by.setdefault(key_, {"dates": set(), "min": 0.0, "flags": 0})
    mins = float(r.get("Минути") or 0)
    p["min"] += mins
    if mins > 0:
        p["dates"].add(r["Дата"])
    if (r.get("Бележка") or "").strip():
        p["flags"] += 1

fmt = lambda m: "%d:%02d" % (int(m // 60), int(round(m % 60)))
out = ["⏱ Часове за заплата · %s" % mm]
for site in sorted({s for s, _ in by}):
    people = sorted([(n, v) for (s, n), v in by.items() if s == site], key=lambda x: x[0])
    tot = sum(v["min"] for _, v in people)
    out.append("%s — общо %s ч" % (site, fmt(tot)))
    for n, v in people:
        out.append("• %s: %d дни, %s ч%s" % (n, len(v["dates"]), fmt(v["min"]), (" ⚠ %d без край/поправка" % v["flags"]) if v["flags"] else ""))
out.append("Смяна без край не се брои, докато не се поправи.")
print("\n".join(out))
