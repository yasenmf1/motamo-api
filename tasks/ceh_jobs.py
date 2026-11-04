# Агент „Цех“ в облака: сутрешни суровини (stock), вечерна проверка (evening), вечерно нулиране (night).
# Само подрежда изхода на ceh.py / reset_fresh.py в едно съобщение за Telegram; нищо не измисля.
# python ceh_jobs.py <stock|evening|night> [--dry]   (--dry = печата, не праща; night без запис в Barsy)
import json, os, subprocess, sys, datetime, urllib.request
from lib import sofia_now, notify, heartbeat, env

HERE = os.path.dirname(os.path.abspath(__file__))
DRY = "--dry" in sys.argv
JOB = sys.argv[1] if len(sys.argv) > 1 else ""


def run(script, *args, timeout=240):
    p = subprocess.run([sys.executable, os.path.join(HERE, script), *args], capture_output=True, text=True, encoding="utf8", timeout=timeout)
    out = (p.stdout or "").strip()
    return out, p.returncode


def send(text, name):
    print(text)
    if not DRY:
        notify(text)
        heartbeat(name)


def stock():
    out, rc = run("ceh.py", "shortage")
    if rc != 0 or out.startswith("ГРЕШКА"):
        return send("Цех · сутрин: цехът/API не отговаря сега — не мога да сметна недостига.", "ceh-stock")
    lines = out.splitlines()
    n = int(lines[0].split("сметки в разноса")[1]) if "сметки в разноса" in lines[0] else 0
    msg = ["Цех · сутрин " + sofia_now().strftime("%d.%m")]
    if n == 0:
        msg.append("Още няма зареден разнос за деня — не мога да сметна недостига.")
    else:
        raw = [l.split(" | ") for l in lines[1:] if " | " in l]
        sur = [r for r in raw if r[0] == "Суровини"]
        zag = [r[1] for r in raw if r[0] == "Заготовки"]
        if sur:
            msg.append("⚠️ СУРОВИНИ, които НЯМА да стигнат за днешния разнос (купи/зареди преди производство):")
            for r in sur:
                msg.append("• %s: %s, %s → %s" % (r[1], r[2], r[3], r[4]))
        else:
            msg.append("✅ Всички суровини стигат за днешния разнос.")
        if zag:
            msg.append("Заготовки за правене днес: " + ", ".join(zag))
    st, _ = run("ceh.py", "stock")
    zs = []
    for l in st.splitlines():
        p = l.split(" | ")
        if len(p) == 3 and p[0] == "Заготовки":
            try:
                zs.append((float(p[2]), p[1]))
            except ValueError:
                pass
    if zs:
        msg.append("Заготовки в склада (най-ниско първо): " + "; ".join("%s: %g" % (n_, q) for q, n_ in sorted(zs)))
    lk, _ = run("ceh.py", "link")
    if lk.startswith("http"):
        msg.append("Пълен екран: " + lk)
    send("\n".join(msg), "ceh-stock")


def evening():
    ra, rc1 = run("ceh.py", "razos")
    bx, rc2 = run("ceh.py", "boxes")
    ex, rc3 = run("ceh.py", "expiring", "3")
    ob, _ = run("ceh.py", "oborot")
    if rc1 != 0 or rc2 != 0 or rc3 != 0 or "ГРЕШКА" in ra + bx + ex:
        return send("Цех: не мога да чета склада/разноса.", "ceh-vecher")
    msg = ["Цех · вечер " + sofia_now().strftime("%d.%m")]
    rl = ra.splitlines()
    shops = [l for l in rl[1:] if l]
    without = [l for l in shops if l.startswith("БЕЗ")]
    if not shops:
        msg.append("Днес няма разнос.")
    elif without:
        msg.append("⚠️ Без стокова: " + "; ".join(" ".join(w.split(" | ")[1:3]).strip() for w in without))
    bl = bx.splitlines()
    if shops:
        poke_t = next((l for l in bl if l.startswith("ПОКЕ")), "")
        sushi_t = next((l for l in bl if l.startswith("СУШИ")), "")
        pk = [l.strip() for l in bl[bl.index(poke_t) + 1:bl.index(sushi_t)]] if poke_t and sushi_t else []
        su = [l.strip() for l in bl[bl.index(sushi_t) + 1:]] if sushi_t else []
        msg.append("Днес: " + poke_t.replace("ПОКЕ (купи) общо:", "поке").strip() + " купи (" + ", ".join(pk) + ")")
        msg.append("Суши: " + sushi_t.replace("СУШИ (кутии) общо:", "").strip() + " кутии (" + ", ".join(su) + ")")
    el = ex.splitlines()
    soon = [l for l in el[1:] if l.startswith("изтича")]
    gone = [l for l in el[1:] if l.strip() and not l.startswith("изтича") and not l.startswith("ИЗТЕКЛИ")]
    if soon:
        msg.append("Изтичат до 3 дни:")
        msg += ["• " + l.replace("изтича ", "", 1) for l in soon]
    if gone:
        msg.append("Вече изтекли с наличност: %d (най-стари: %s)" % (len(gone), "; ".join(g.strip() for g in gone[:3])))
    # оборот на цеха без ДДС: ден, седмица, месец; пн — и минала седмица; 1-во число — и минал месец
    today = sofia_now()
    want = ["ДЕН", "СЕДМИЦА до днес", "МЕСЕЦ до днес"] + (["МИНАЛА СЕДМИЦА"] if today.weekday() == 0 else []) + (["МИНАЛ МЕСЕЦ"] if today.day == 1 else [])
    msg.append("Оборот цех без ДДС:")
    for l in ob.splitlines():
        if any(l.startswith(w + ":") for w in want):
            msg.append("• " + l.split(" [")[0])
    if not soon and not gone and not without:
        msg.append("✅ Цех: днес няма проблеми.")
    send("\n".join(msg), "ceh-vecher")


def night():
    today = sofia_now().strftime("%Y-%m-%d")
    brak = []
    try:
        rq = urllib.request.Request("https://motamo-api.vercel.app/api/transfer", json.dumps({"token": env("PEEK_TOKEN"), "action": "brak_today", "date": today}).encode(), {"content-type": "application/json"})
        d = json.load(urllib.request.urlopen(rq, timeout=60))
        if not d.get("ok"):
            raise RuntimeError(d.get("error"))
        for r in d.get("rows") or []:
            for it in (r.get("items") or []):
                brak.append("%s — %s" % (it.get("name"), it.get("qty")))
        brak_txt = "Записан брак днес: " + "; ".join(brak) if brak else "Точката не е записала брак днес."
    except Exception:
        brak_txt = "Записаният брак не се чете от облака (журналът е затворен) — виж го в Barsy на точката."
    out, rc = run("reset_fresh.py", *(() if DRY else ("night",)), timeout=300)
    if rc != 0:
        return send("Цех: не успях вечерното нулиране — скриптът върна грешка (код %s)." % rc, "ceh-nulirane")
    lines = [l for l in out.splitlines() if l.strip()]
    # 04.11 (собственикът: „изпращай всяка вечер“): сверка на точката след брака и нулирането — артикули с отрицателна наличност
    # (системата е изписала по рецепти повече, отколкото е заредено) и големи положителни остатъци; само показва, нищо не записва.
    sver = ""
    try:
        rq = urllib.request.Request("https://motamo-api.vercel.app/api/peek", json.dumps({"token": env("PEEK_TOKEN"), "action": "Articles_getlistobject", "host": "shop", "params": {"filters": {"depot_id": 1}, "extra_properties": ["store_amount"]}}).encode(), {"content-type": "application/json"})
        dd = json.load(urllib.request.urlopen(rq, timeout=60)).get("data")
        L = dd if isinstance(dd, list) else (dd.get("list") or list(dd.values()))
        neg = sorted([(float(a.get("store_amount") or 0), a.get("article_name")) for a in L if float(a.get("store_amount") or 0) < -0.05 and a.get("article_name") != "Вода"])
        if neg:
            sver = "⚠️ Сверка точка — минус наличност (изписано по рецепти повече от заредено): " + "; ".join("%s %s" % (n, round(q, 2)) for q, n in neg[:12]) + (" …" if len(neg) > 12 else "")
        else:
            sver = "✅ Сверка точка: няма артикули с минус наличност."
    except Exception:
        sver = "Сверката на точката не се прочете тази вечер."
    msg = ["Цех · вечер (нулиране) " + sofia_now().strftime("%d.%m"), brak_txt, sver]
    msg += [l[:300] for l in lines]
    send("\n".join(msg)[:3400], "ceh-nulirane")


{"stock": stock, "evening": evening, "night": night}.get(JOB, lambda: print(__doc__))()
