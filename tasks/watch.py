# MOTAMO — агент „Точка“: следене на поръчките от сайта. САМО ЧЕТЕНЕ в Barsy (през /api/peek, host shop).
# Пуска се от задача `motamo-tochka-poruchki` (на 10 мин, 09:00–21:30). При проблем праща ЕДИН ред към собственика (notify.py), иначе мълчи.
# Какво НЕ дублираме (вече го следят други):
#   • доставка (D-…) на „Очаква куриер“ ≥15 мин      → GitHub `dlvwatch` (lib/dlv-watch.js, 11–20 ч Пн–Сб)
#   • Barsy не отговаря (публичен/резервен вход)      → GitHub `barsywatch` (на час)
# Какво добавя това:
#   (а) онлайн поръчка от сайта чака приемане ≥ WAIT_ACCEPT_MIN мин (всичките редове още „нови“)
#   (в) онлайн КАРТОВА поръчка е още ОТВОРЕНА ≥ CARD_OPEN_MIN мин (плащане, което може да не е затворило сметката — reconcile-card не е насрочен)
#   (г) поръчка със статус на грешка/отказ
#   „Платено в сайта, но без сметка в Barsy“ е невъзможно по устройство (сметката се отваря ПРЕДИ плащането, виж api/pay-return.js).
# python watch.py            → реална проба
# python watch.py --selftest → вътрешна проба със симулирани данни (не чете Barsy, не праща нищо)
import datetime, json, os, subprocess, sys, urllib.request

sys.stdout.reconfigure(encoding="utf8")

# ── прагове ──────────────────────────────────────────────────────────────────
WAIT_ACCEPT_MIN = 10      # онлайн поръчка, която още не е приета
CARD_OPEN_MIN = 30        # картова поръчка, още отворена
LOOKBACK_MIN = 180        # гледаме само поръчки от последните 3 часа
SITE_POS_ID = 2           # „Motamo Online“
HOURS = (9.0, 21.5)       # работно време на проверката (София)
ERR_RE = r"грешк|отказ|анулир|неуспеш|провал"

import re
from lib import env, sofia_now as _sofia_now, notify, state_get, state_put


def key(name):
    return env(name)


def peek(action, params):
    body = json.dumps({"token": key("PEEK_TOKEN"), "action": action, "host": "shop", "params": params}).encode()
    r = urllib.request.Request("https://motamo-api.vercel.app/api/peek", body, {"content-type": "application/json"})
    d = json.load(urllib.request.urlopen(r, timeout=40))
    return d.get("data")


def listify(x):
    if isinstance(x, list):
        return x
    if isinstance(x, dict):
        return x.get("list") or list(x.values())
    return []


def stage_of(r):
    t = str(r.get("order_status_title") or "")
    if re.search(r"изпълн|обслужен|сервиран|предадена", t, re.I):
        return 4
    if re.search(r"очаква куриер|готов", t, re.I):
        return 3
    if re.search(r"приготв", t, re.I):
        return 2
    return 1


def parse_dt(s):
    try:
        return datetime.datetime.strptime(str(s)[:19], "%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def ref_of(a):
    m = re.search(r"\b([WMD]-[A-Z0-9]{4,8})\b", str(a.get("description") or ""))
    return m.group(1) if m else ("#%s" % a.get("account_id"))


def evaluate(accounts, orders_of, now, state):
    """accounts: списък сметки; orders_of(account_id) → редове на поръчката; now: naive datetime (София).
    Връща списък от кратки текстове за проблеми, които още не са изпращани (state се допълва)."""
    sent = state.setdefault("sent", {})
    alerts = []
    for a in accounts:
        if a.get("close_date"):
            continue                                   # затворена = приключена
        created = parse_dt(a.get("create_date"))
        if created is None:
            continue
        age = (now - created).total_seconds() / 60
        if age > LOOKBACK_MIN or age < 0:
            continue
        online = int(a.get("pos_id") or 0) == SITE_POS_ID or re.match(r"[WMD]-", ref_of(a)) is not None
        if not online:
            continue
        ref = ref_of(a)
        text_blob = " ".join(str(a.get(k) or "") for k in ("description", "account_alias", "notes", "payment_name"))
        rows = []
        try:
            rows = [r for r in listify(orders_of(a["account_id"])) if isinstance(r, dict)]
        except Exception:
            rows = []
        problems = []
        # (г) грешка/отказ
        titles = [str(r.get("order_status_title") or "") for r in rows] + [str(a.get("service_status_name") or "")]
        if any(re.search(ERR_RE, t, re.I) for t in titles):
            problems.append(("err", "статус на грешка/отказ"))
        # (а) чака приемане
        if rows and not problems and min(stage_of(r) for r in rows) == 1 and age >= WAIT_ACCEPT_MIN:   # при грешка не дублираме с „чака приемане“
            problems.append(("accept", "чака приемане %d мин" % age))
        # (в) картова, още отворена
        if re.search(r"карта", text_blob, re.I) and age >= CARD_OPEN_MIN:
            problems.append(("card", "картова, още отворена %d мин — виж плащането" % age))
        for kind, what in problems:
            k = "%s:%s" % (a["account_id"], kind)
            if k in sent:
                continue
            sent[k] = now.isoformat()
            alerts.append("%s (сметка %s): %s" % (ref, a["account_id"], what))
    # чистим стари записи (>2 дни)
    for k in list(sent):
        try:
            if (now - datetime.datetime.fromisoformat(sent[k])).days > 2:
                del sent[k]
        except Exception:
            del sent[k]
    return alerts


def sofia_now():
    return _sofia_now()


def main():
    now = sofia_now()
    hh = now.hour + now.minute / 60
    if not (HOURS[0] <= hh <= HOURS[1]):
        return
    state = state_get("watch-poruchki")
    try:
        accounts = listify(peek("Accounts_getlist", {"order_by": "account_id desc", "length": 40}))
        alerts = evaluate(accounts, lambda i: peek("Orders_getlist", {"filters": {"account_id": i}}), now, state)
    except Exception as e:
        # мрежова/Barsy грешка: не спамим — един запис на ден
        k = "watch_error:%s" % now.date()
        if k not in state.setdefault("sent", {}):
            state["sent"][k] = now.isoformat()
            state_put("watch-poruchki", state)
            notify("Поръчки: не мога да чета Barsy (%s)" % type(e).__name__)
        return
    state_put("watch-poruchki", state)
    if alerts:
        text = "📦 Поръчки от сайта: " + "; ".join(alerts)[:700]
        notify(text)
        print(text)


def selftest():
    now = datetime.datetime(2026, 11, 3, 12, 0, 0)
    def acc(i, mins, desc, pos=2, close=None, alias=None):
        return {"account_id": i, "create_date": (now - datetime.timedelta(minutes=mins)).strftime("%Y-%m-%d %H:%M:%S"), "description": desc, "pos_id": pos, "close_date": close, "account_alias": alias}
    accounts = [
        acc(1, 15, "Поръчка M-TEST1 · Тест · ВЗЕМАНЕ ОТ МЯСТО"),                    # чака приемане 15 мин → (а)
        acc(2, 40, "Поръчка M-TEST2 · Тест · ВЗЕМАНЕ ОТ МЯСТО", alias="ОНЛАЙН · С КАРТА"),  # картова отворена 40 мин → (в) (и приета)
        acc(3, 5, "Поръчка M-TEST3 · Тест"),                                         # 5 мин — още рано → нищо
        acc(4, 20, "Поръчка M-TEST4 · Тест"),                                        # със статус на грешка → (г)
        acc(5, 90, "Поръчка M-TEST5", close="2026-11-03 11:00:00"),                  # затворена → нищо
        acc(6, 20, None, pos=3),                                                     # каса, не е онлайн → нищо
    ]
    orders = {1: [{"order_status_title": "Нова"}], 2: [{"order_status_title": "Приготвя се"}], 3: [{"order_status_title": "Нова"}],
              4: [{"order_status_title": "Грешка при печат"}], 5: [{"order_status_title": "Изпълнено"}], 6: [{"order_status_title": "Нова"}]}
    st = {}
    first = evaluate(accounts, lambda i: orders[i], now, st)
    second = evaluate(accounts, lambda i: orders[i], now + datetime.timedelta(minutes=2), st)   # пак същите проблеми → без дубликати; сметка 3 още е <10 мин
    print("1-во пускане:"); [print("  ", x) for x in first]
    print("2-ро пускане (дубликати):", second)
    ok = len(first) == 3 and any("чака приемане" in x for x in first) and any("картова" in x for x in first) and any("грешка" in x for x in first) and second == []
    print("САМОПРОБА:", "ОК" if ok else "ПРОВАЛ")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    selftest() if "--selftest" in sys.argv else main()
