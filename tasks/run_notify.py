# Пуска скрипт от tasks/ и праща изхода му в Telegram. Празен изход или „SKIP“ = мълчи.
# python run_notify.py <име-за-пулс> <скрипт.py> [аргументи…]
import os, subprocess, sys
from lib import notify, heartbeat

name, script, args = sys.argv[1], sys.argv[2], sys.argv[3:]
p = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), script), *args], capture_output=True, text=True, encoding="utf8", timeout=420)
out = (p.stdout or "").strip()
print(out)
if p.returncode != 0 or out.startswith("ГРЕШКА"):
    notify("%s: не успях (%s)" % (name, (out or (p.stderr or "")[-200:]).splitlines()[0][:150] if (out or p.stderr) else "код %s" % p.returncode))
elif out and out != "SKIP":
    notify(out)
heartbeat(name)
