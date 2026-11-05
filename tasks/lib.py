# Общи помощници за задачите, които работят в GitHub Actions (не зависят от компютъра).
# Ключовете идват от GitHub secrets (env); на компютъра — резервно от motamo-tokens.env.
import json, os, re, sys, urllib.request, datetime as dt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENVF = os.path.join(os.path.expanduser("~"), ".claude", "motamo-tokens.env")
SB = "https://ptzgxreojfvdltbavlop.supabase.co/rest/v1/"
sys.stdout.reconfigure(encoding="utf8")


def env(key):
    v = os.environ.get(key)
    if v:
        return v
    try:
        for line in open(ENVF, encoding="utf8"):
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return None


def anon():
    return re.search(r'const SB_ANON = "([^"]+)"', open(os.path.join(ROOT, "api", "order.js"), encoding="utf8").read()).group(1)


def _last_sunday(y, m):
    d = dt.datetime(y, m + 1, 1) - dt.timedelta(days=1) if m < 12 else dt.datetime(y, 12, 31)
    return d - dt.timedelta(days=(d.weekday() + 1) % 7)


def sofia_now():
    """Час в София без нужда от tzdata: UTC+2, лятно UTC+3 (от последната нд на март до последната нд на октомври, 01:00 UTC)."""
    u = dt.datetime.utcnow().replace(microsecond=0)
    y = u.year
    a = _last_sunday(y, 3).replace(hour=1)
    b = _last_sunday(y, 10).replace(hour=1)
    return u + dt.timedelta(hours=3 if a <= u < b else 2)


def sb(path, method="GET", body=None, prefer=None):
    a = anon()
    h = {"apikey": a, "Authorization": "Bearer " + a, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    rq = urllib.request.Request(SB + path, json.dumps(body).encode() if body is not None else None, h, method=method)
    t = urllib.request.urlopen(rq, timeout=30).read().decode("utf8")
    return json.loads(t) if t else None


def state_get(name):
    try:
        r = sb("task_state?select=state&name=eq.%s&limit=1" % name)
        return (r[0]["state"] if r else {}) or {}
    except Exception:
        return {}


def state_put(name, state):
    sb("task_state?on_conflict=name", "POST", [{"name": name, "state": state, "at": dt.datetime.utcnow().isoformat() + "Z"}], "resolution=merge-duplicates,return=minimal")


# 05.11: съобщенията на агентите отиват в групата „МОТАМО_Агенти“ (по една тема на агент), за да не се трупа личният чат с бота.
# Идентификаторите не са тайни. Липсва ли темата или групата откаже — пращаме както преди, в личния чат.
AGENTS_CHAT = "-1004146364644"
TOPICS = {"Цех": 5, "Точка": 6, "Сайт": 7, "Финанси": 8, "Новини": 9, "Реклама": 10, "Конкуренти": 11, "Поща": 12}
TOPIC_BY_SCRIPT = {"ceh_jobs.py": "Цех", "novini_job.py": "Новини", "ads_job.py": "Реклама", "sait.py": "Сайт",
                   "sutrin.py": "Точка", "turnover.py": "Точка", "watch.py": "Точка", "stokovi_report.py": "Точка",
                   "week.py": "Точка", "hours.py": "Точка", "finansi.py": "Финанси"}
TOPIC_BY_NAME = {"finansi": "Финанси", "finansi-srok": "Финанси", "tochka-sedmica": "Точка", "chasove": "Точка"}


def _tg_post(tok, payload):
    rq = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % tok, json.dumps(payload).encode(), {"content-type": "application/json"})
    urllib.request.urlopen(rq, timeout=30)


def notify(text, topic=None):
    tok, chat = env("TELEGRAM_BOT_TOKEN"), env("TELEGRAM_OWNER_CHAT_ID")
    if not (tok and chat):
        print("Telegram: липсва ключ"); return False
    topic = topic or TOPIC_BY_SCRIPT.get(os.path.basename(sys.argv[0] if sys.argv else ""))
    if topic in TOPICS:
        try:
            _tg_post(tok, {"chat_id": AGENTS_CHAT, "message_thread_id": TOPICS[topic], "text": text[:3500]}); return True
        except Exception as e:
            print("Telegram (тема %s): не успя — %s; пращам в личния чат" % (topic, type(e).__name__))
    try:
        _tg_post(tok, {"chat_id": chat, "text": text[:3500]}); return True
    except Exception as e:
        print("Telegram: не успя — " + type(e).__name__); return False


def heartbeat(name, note=None):
    try:
        sb("task_heartbeat?on_conflict=name", "POST", [{"name": name, "at": dt.datetime.utcnow().isoformat() + "Z", "note": note}], "resolution=merge-duplicates,return=minimal")
    except Exception:
        pass


class _SofiaDate(dt.date):
    @classmethod
    def today(cls):
        return sofia_now().date()


def patch_today():
    """datetime.date.today() да връща датата в София (в облака часовникът е UTC)."""
    import datetime
    datetime.date = _SofiaDate
