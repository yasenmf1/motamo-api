# Агент „Сайт“ в облака: смоук на сайта/API, неуспешни GitHub Actions (motamo-api), сертификати, журнал на грешките.
# Мълчи, ако всичко е наред; в понеделник праща „всичко е наред“. python sait.py [--dry]
import datetime, json, os, socket, ssl, subprocess, sys, urllib.parse, urllib.request
from lib import sofia_now, notify, heartbeat, sb

HERE = os.path.dirname(os.path.abspath(__file__))
DRY = "--dry" in sys.argv
problems = []

# 1) смоук тест (публични адреси)
try:
    r = subprocess.run(["node", os.path.join(HERE, "smoke.js")], capture_output=True, text=True, encoding="utf8", timeout=150)
    for line in (r.stdout or "").splitlines():
        t = line.strip()
        if t and not t.startswith("✓") and "Всичко е наред" not in t:
            problems.append("Смоук: " + t[:160])
    if r.returncode not in (0, None) and not any(p.startswith("Смоук") for p in problems):
        problems.append("Смоук тестът върна грешка (код %s)" % r.returncode)
except Exception as e:
    problems.append("Смоук тестът не тръгна: " + type(e).__name__)

# 2) GitHub Actions на motamo-api — неуспешни пускания за 24 ч (motamo_site е частно репо; него го следи самият GitHub)
since = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)
try:
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    h = {"Accept": "application/vnd.github+json"}
    if tok:
        h["Authorization"] = "Bearer " + tok
    d = json.load(urllib.request.urlopen(urllib.request.Request("https://api.github.com/repos/yasenmf1/motamo-api/actions/runs?per_page=100", headers=h), timeout=30))
    bad = [x for x in d.get("workflow_runs", []) if x.get("conclusion") in ("failure", "timed_out", "startup_failure")
           and datetime.datetime.fromisoformat(x["created_at"].replace("Z", "+00:00")) >= since]
    if bad:
        names = sorted(set(x["name"] for x in bad))
        problems.append("GitHub motamo-api: %d неуспешни пускания (%s)" % (len(bad), ", ".join(names)[:100]))
except Exception as e:
    problems.append("GitHub: не успях да чета (%s)" % type(e).__name__)

# 3) сертификати
for host in ("motamo.bg", "motamo-api.vercel.app"):
    try:
        with socket.create_connection((host, 443), timeout=15) as s, ssl.create_default_context().wrap_socket(s, server_hostname=host) as ss:
            exp = datetime.datetime.strptime(ss.getpeercert()["notAfter"], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=datetime.timezone.utc)
        days = (exp - datetime.datetime.now(datetime.timezone.utc)).days
        if days < 14:
            problems.append("Сертификат %s изтича след %d дни" % (host, days))
    except Exception as e:
        problems.append("Сертификат %s: не успях да проверя (%s)" % (host, type(e).__name__))

# 4) журнал на грешките на API-то (Supabase error_log, 24 ч)
try:
    since_iso = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = sb("error_log?select=source,message,at&at=gte.%s&order=at.desc&limit=500" % urllib.parse.quote(since_iso)) or []
    cnt = {}
    for r in rows:
        cnt[r["source"]] = cnt.get(r["source"], 0) + 1
    barsy = sum(v for k, v in cnt.items() if k.startswith("barsy:"))
    if barsy:
        problems.append("Журнал: Barsy не отговаря/връща не-JSON — %d записа за 24 ч" % barsy)
    for k, v in sorted(cnt.items(), key=lambda x: -x[1]):
        if v >= 3 and not k.startswith("barsy:"):
            ex = next((r["message"] for r in rows if r["source"] == k), "")[:80]
            problems.append("Журнал: %s — %d пъти (напр. „%s“)" % (k, v, ex))
except Exception as e:
    problems.append("Журналът на грешките не се прочете: " + type(e).__name__)

now = sofia_now()
if problems:
    text = "⚠️ Сайт · " + now.strftime("%d.%m") + "\n" + "\n".join("• " + p for p in problems[:10])
elif now.weekday() == 0:
    text = "✅ Сайт: всичко е наред (сайт, API, GitHub, сертификати, журнал) — " + now.strftime("%d.%m")
else:
    text = None
print(text or "OK")
if text and not DRY:
    notify(text)
if not DRY:
    heartbeat("sait")
