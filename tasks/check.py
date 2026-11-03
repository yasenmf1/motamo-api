# Спрени от продажба артикули: каталог (allergens.js) минус живото меню (source=point).
# Само чете Barsy/API; пише единствено state.json до себе си.
import datetime, io, json, os, random, re, sys, urllib.request
from lib import ROOT, state_get, state_put

sys.stdout.reconfigure(encoding='utf-8')
CATALOG_PATHS = [os.path.join(ROOT, 'lib', 'allergens.js'), os.path.join(ROOT, 'api', 'allergens.js')]
EXPECTED = 58

src = next((p for p in CATALOG_PATHS if os.path.exists(p)), None)
if not src:
    print('ГРЕШКА: не намирам allergens.js в C:\\motamo-api (lib/ или api/).')
    sys.exit(1)
body = io.open(src, encoding='utf-8').read().split('const ALLERGENS = {', 1)[1]
rows = re.findall(r'^\s*(\d+):\s*(?:\[[^\]]*\]|null)\s*,\s*//\s*(.+?)\s*$', body, re.M)
print('КАТАЛОГ: %d артикула (%s)' % (len(rows), src))
if abs(len(rows) - EXPECTED) > 10:
    print('ГРЕШКА: очаквах около %d реда — таблицата е променена. Спирам.' % EXPECTED)
    sys.exit(1)

try:
    url = 'https://motamo-api.vercel.app/api/menu?source=point&cb=%d' % random.randint(1, 10**9)
    menu = json.loads(urllib.request.urlopen(url, timeout=60).read().decode('utf-8'))
    live = {str(i['id']): (c.get('category'), i.get('name')) for c in menu for i in c.get('items', [])}
except Exception as e:
    print('ГРЕШКА: API-то не отговаря (%s). Спирам.' % e)
    sys.exit(1)
if not live:
    print('ГРЕШКА: менюто се върна празно. Спирам.')
    sys.exit(1)
print('МЕНЮ: %d артикула' % len(live))

state = state_get('sutrin-stopped')
today = datetime.date.today()
stopped = [(i, n) for i, n in rows if i not in live]
state = {i: state.get(i, today.isoformat()) for i, _ in stopped}
state_put('sutrin-stopped', state)

if not stopped:
    print('СПРЕНИ: няма')
for i, n in stopped:
    days = (today - datetime.date.fromisoformat(state[i][:10])).days
    print('СПРЯН: %s (id %s) — от %d дни%s' % (n, i, days, ' — НАД 7 ДНИ' if days > 7 else ''))

known = {i for i, _ in rows}
for i, (cat, name) in live.items():
    if i not in known:
        print('БЕЗ АЛЕРГЕНИ В ТАБЛИЦАТА: %s (id %s, %s)' % (name, i, cat))
