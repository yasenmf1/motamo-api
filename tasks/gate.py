# Врата за слотове: GitHub пуска задачите със закъснение и в UTC, затова гледаме часа в София.
# gate.py <име> <дни 1-5> <HH:MM> [<HH:MM> ...]  → печата "run" и излиза 0, ако има слот [начало, начало+55 мин), който още не е изпълнен днес; иначе излиза 1.
import sys
from datetime import timedelta
from lib import sofia_now, state_get, state_put

name, days, slots = sys.argv[1], sys.argv[2], sys.argv[3:]
now = sofia_now()
wd = (now.weekday() + 1) % 7   # 1=пн … 6=сб, 0=нд
if "-" in days:
    a, b = (int(x) for x in days.split("-")); allowed = set(range(a, b + 1))
elif days == "*":
    allowed = set(range(7))
else:
    allowed = {int(x) for x in days.split(",")}
if wd not in allowed:
    sys.exit(1)
st = state_get("gate:" + name)
done = st.get("done", {})
today = now.strftime("%Y-%m-%d")
done = {k: v for k, v in done.items() if k.startswith(today)}
for s in slots:
    h, m = (int(x) for x in s.split(":"))
    start = now.replace(hour=h, minute=m, second=0)
    key = today + " " + s
    if start <= now < start + timedelta(minutes=55) and key not in done:
        done[key] = now.isoformat()
        state_put("gate:" + name, {"done": done})
        print("run " + s)
        sys.exit(0)
sys.exit(1)
