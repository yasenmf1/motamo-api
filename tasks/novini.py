# Агент „Новини“ — данни за сутрешния бриф. Само четене.
#   python novini.py weather   → готово съобщение за времето в Стара Загора (Open-Meteo, без ключ)
#   python novini.py news      → заглавия и линкове от profit.bg, news.bg, capital.bg (RSS), dnes.bg, sportal.bg
import html, json, re, sys, urllib.request

sys.stdout.reconfigure(encoding="utf8")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def get(url, timeout=30):
    r = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "bg,en;q=0.8"})
    return urllib.request.urlopen(r, timeout=timeout).read().decode("utf8", "replace")


WMO = {0: "ясно", 1: "предимно ясно", 2: "променлива облачност", 3: "облачно", 45: "мъгла", 48: "мъгла с измръзване", 51: "ръмеж", 53: "ръмеж", 55: "силен ръмеж",
       61: "слаб дъжд", 63: "дъжд", 65: "силен дъжд", 66: "ледена дъждовна", 67: "силен леден дъжд", 71: "слаб сняг", 73: "сняг", 75: "силен сняг", 77: "снежни зърна",
       80: "превалявания", 81: "превалявания", 82: "силни превалявания", 85: "снеговалежи", 86: "силни снеговалежи", 95: "гръмотевична буря", 96: "буря с градушка", 99: "силна буря с градушка"}
DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"]


def weather():
    import datetime
    u = ("https://api.open-meteo.com/v1/forecast?latitude=42.4258&longitude=25.6345&timezone=Europe%2FSofia&forecast_days=4"
         "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max"
         "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m")
    d = json.loads(get(u))
    c, dl = d["current"], d["daily"]
    out = ["🌤 Времето · Стара Загора · %s" % datetime.date.fromisoformat(dl["time"][0]).strftime("%d.%m")]
    out.append("Сега: %.0f°C (усеща се %.0f°C), %s, вятър %.0f км/ч" % (c["temperature_2m"], c["apparent_temperature"], WMO.get(c["weather_code"], "—"), c["wind_speed_10m"]))
    for i in range(4):
        day = datetime.date.fromisoformat(dl["time"][i])
        lab = "Днес" if i == 0 else ("Утре" if i == 1 else DAYS[day.weekday()] + " " + day.strftime("%d.%m"))
        rain = dl["precipitation_probability_max"][i]
        out.append("%s: %.0f…%.0f°C, %s%s, вятър до %.0f км/ч" % (lab, dl["temperature_2m_min"][i], dl["temperature_2m_max"][i], WMO.get(dl["weather_code"][i], "—"),
                   (", дъжд %s%% (%.1f мм)" % (rain, dl["precipitation_sum"][i])) if rain and rain >= 30 else "", dl["wind_speed_10m_max"][i]))
    warn = [i for i in range(4) if (dl["precipitation_sum"][i] or 0) >= 10 or dl["wind_speed_10m_max"][i] >= 60 or dl["temperature_2m_max"][i] >= 36 or dl["temperature_2m_min"][i] <= -8]
    if warn:
        out.append("⚠ Внимание: силно време (дъжд ≥10 мм, вятър ≥60 км/ч, жега ≥36° или студ ≤−8°) в: " + ", ".join("днес" if i == 0 else ("утре" if i == 1 else DAYS[datetime.date.fromisoformat(dl["time"][i]).weekday()]) for i in warn))
    return "\n".join(out)


def anchors(base, page, limit=22, minlen=32, must=None):
    out, seen = [], set()
    for m in re.finditer(r'<a\s[^>]*href="([^"#]+)"[^>]*>(.*?)</a>', page, re.S):
        href, txt = m.group(1), re.sub(r"<[^>]+>", " ", m.group(2))
        txt = re.sub(r"\s+", " ", html.unescape(txt)).strip()
        if len(txt) < minlen or txt in seen:
            continue
        if href.startswith("//"):
            href = "https:" + href
        elif href.startswith("/"):
            href = base.rstrip("/") + href
        if not href.startswith("http") or (must and not re.search(must, href)):
            continue
        seen.add(txt)
        out.append((txt, href))
        if len(out) >= limit:
            break
    return out


def news():
    srcs = [("profit.bg (бизнес)", "https://profit.bg/", r"profit\.bg/"),
            ("news.bg", "https://news.bg/", r"news\.bg/"),
            ("dnes.bg", "https://www.dnes.bg/", r"dnes\.bg/"),
            ("sportal.bg (спорт)", "https://sportal.bg/", r"sportal\.bg/")]
    for name, url, must in srcs:
        print("\n=== %s ===" % name)
        try:
            base = "/".join(url.split("/")[:3])
            for t, h in anchors(base, get(url), must=must):
                print("- %s | %s" % (t, h))
        except Exception as e:
            print("ГРЕШКА (%s): %s" % (type(e).__name__, str(e)[:80]))
    print("\n=== capital.bg (RSS) ===")
    try:
        x = get("https://www.capital.bg/rss/")
        for it in re.findall(r"<item>(.*?)</item>", x, re.S)[:20]:
            t = re.search(r"<title>(.*?)</title>", it, re.S)
            l = re.search(r"<link>(.*?)</link>", it, re.S)
            if t and l:
                tt = html.unescape(re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1))).strip()
                print("- %s | %s" % (tt, l.group(1).strip()))
    except Exception as e:
        print("ГРЕШКА (%s): %s" % (type(e).__name__, str(e)[:80]))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "weather":
        print(weather())
    elif cmd == "news":
        news()
    elif cmd == "article" and len(sys.argv) > 2:
        # текст на статия (за 2–3 изречения резюме): маха скриптове/менюта, връща първите ~2500 знака
        pg = get(sys.argv[2])
        pg = re.sub(r"(?is)<(script|style|nav|header|footer|aside|form)[^>]*>.*?</>", " ", pg)
        paras = [re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", m))).strip() for m in re.findall(r"(?is)<p[^>]*>(.*?)</p>", pg)]
        print(" ".join(x for x in paras if len(x) > 40)[:2500])
    else:
        print(__doc__)
