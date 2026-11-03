// MOTAMO API — бърза проверка преди/след публикуване (без мрежа, без тайни).
// 1) синтаксис на всеки файл; 2) вграденият скрипт на екраните (template string) е валиден JS.
const fs = require("fs"), path = require("path"), vm = require("vm");
let bad = 0;
for (const dir of ["api", "lib"]) {
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".js"))) {
    const p = path.join(dir, f), src = fs.readFileSync(p, "utf8");
    try { new vm.Script(src, { filename: p }); }
    catch (e) { bad++; console.error("✗ СИНТАКСИС", p, "—", e.message); continue; }
    // вградени <script> блокове в страниците: взимаме всички от литералите и ги проверяваме
    const re = /<script>([\s\S]*?)<\/script>/g; let m, n = 0;
    while ((m = re.exec(src))) {
      let js = m[1];
      if (/\$\{|\`/.test(js)) continue;            // с интерполация/ескейпи — пропускаме (не са чист JS)
      js = js.replace(/\\/g, "\\").replace(/\n/g, "\n");   // как го вижда браузърът от template string
      n++;
      try { new vm.Script(js, { filename: p + "#script" + n }); }
      catch (e) { bad++; console.error("✗ ВГРАДЕН СКРИПТ", p, "#" + n, "—", e.message); }
    }
  }
}
if (bad) { console.error("\n" + bad + " проблема"); process.exit(1); }
console.log("✓ ci-check: всички файлове са с валиден синтаксис");
