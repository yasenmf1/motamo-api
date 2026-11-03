# Агент „Новини“ в облака: времето + бриф от profit.bg, news.bg, dnes.bg, sportal.bg, capital.bg → няколко съобщения в Telegram.
# python novini_job.py [--dry]  (--dry = печата, не праща)
import concurrent.futures as cf, json, os, re, subprocess, sys
from lib import sofia_now, notify, heartbeat
from llm import ask, MODEL_SMART

HERE = os.path.dirname(os.path.abspath(__file__))
DRY = "--dry" in sys.argv


def nov(*args):
    p = subprocess.run([sys.executable, os.path.join(HERE, "novini.py"), *args], capture_output=True, text=True, encoding="utf8", timeout=120)
    return (p.stdout or "").strip()


def send(text):
    print(text + "\n" + "-" * 40)
    if not DRY:
        notify(text)


SECTIONS = [
    ("bg", "🇧🇬 БЪЛГАРИЯ", "политика и общество (news.bg, dnes.bg)", 5),
    ("biz", "💼 БИЗНЕС И ИКОНОМИКА", "profit.bg, capital.bg; акцент върху енергия/суровини/цени, ЕС фондове, AI и всичко, което засяга бизнеса", 5),
    ("world", "🌍 СВЯТ", "Иран/Близък изток, Украйна–Русия, САЩ, ЕС (news.bg, dnes.bg)", 4),
    ("sport", "⚽ СПОРТ", "САМО от sportal.bg: приоритет Ливърпул и английското първенство, после NBA, тенис (Григор Димитров, Сабаленка), Формула 1, после водещите български", 5),
]
RULES = ("Ти си агент „Новини“ на собственика на MOTAMO (Ясен, Стара Загора). Пишеш на български. Нищо не измисляш — само по подадените текстове. "
         "Формат на всяка новина: емоджи + ВОДЕЩ ФАКТ с главни букви, после 2–3 изречения резюме, после линка на нов ред. Без markdown (без ** и #). "
         "Ако за статията има само заглавие, напиши заглавие и „(само заглавие)“. НЕ пишеш заглавие на секцията и дата — само самите новини.")

weather = nov("weather").replace("дъжд, дъжд", "дъжд")
send(weather)

headlines = nov("news")
sel_prompt = ("Ето заглавия и линкове от български новинарски сайтове. Избери най-важните за днес за четири секции и върни САМО JSON "
              '{"bg":[линкове],"biz":[...],"world":[...],"sport":[...]} — най-много 6 на секция, само линкове от списъка. '
              "bg=политика/общество от news.bg и dnes.bg; biz=profit.bg и capital.bg (енергия, суровини, цени, ЕС фондове, AI); "
              "world=Иран/Близък изток, Украйна–Русия, САЩ, ЕС; sport=само sportal.bg (Ливърпул и английско първенство първо).\n\n" + headlines[:14000])
try:
    raw = ask(sel_prompt, max_tokens=1200)
    picks = json.loads(re.search(r"\{.*\}", raw, re.S).group(0))
except Exception as e:
    send("Новини: не успях да подредя брифа (%s)" % str(e)[:120]); sys.exit(0)

known = set(re.findall(r"\|\s*(https?://\S+)", headlines))
allurls = [u for k in ("bg", "biz", "world", "sport") for u in picks.get(k, []) if u in known]


def art(u):
    try:
        return u, nov("article", u)
    except Exception:
        return u, ""


with cf.ThreadPoolExecutor(6) as ex:
    texts = dict(ex.map(art, allurls))
titles = {m.group(2): m.group(1) for m in re.finditer(r"-\s(.*?)\s\|\s(https?://\S+)", headlines)}

day = sofia_now().strftime("%d.%m.%Y")
sent = 1
for key, title, desc, n in SECTIONS:
    urls = [u for u in picks.get(key, []) if u in known][:n + 1]
    if not urls:
        continue
    material = "\n\n".join("ЗАГЛАВИЕ: %s\nЛИНК: %s\nТЕКСТ: %s" % (titles.get(u, ""), u, texts.get(u) or "(не се чете)") for u in urls)
    try:
        body = ask("Напиши секцията „%s“ (%s) за %s, %d–%d новини, от тези материали:\n\n%s" % (title, desc, day, n - 1, n + 1, material), system=RULES, max_tokens=2500)
        send(title + " · " + day + "\n\n" + body[:3300]); sent += 1
    except Exception as e:
        send(title + ": не успях да я напиша (%s)" % str(e)[:100])

# „ОЩЕ“: Xpeng/електромобили, Bitcoin, стрийминг премиери — с уеб търсене (ако е разрешено в акаунта)
try:
    body = ask("Намери накратко днешното по: Xpeng/електромобили (Ясен чака P7+), цена на Bitcoin, нови стрийминг премиери. По 1–2 реда на тема на български; ако няма нищо — кажи го. Само от резултатите от търсенето.",
               system="Пишеш на български, без markdown.", max_tokens=1200,
               tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 4}])
    if body:
        send("🔎 ОЩЕ · " + day + "\n\n" + body[:3300]); sent += 1
except Exception as e:
    print("ОЩЕ: прескочено (%s)" % str(e)[:120])

if not DRY:
    heartbeat("novini")
print("Изпратени: %d съобщения" % sent)
