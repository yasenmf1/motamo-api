# motamo-api — серверни функции за MOTAMO (Vercel)

⚠ Репото е ПУБЛИЧНО: никакви ключове, токени, пароли, клиентски данни и вътрешни цени в кода, коментарите, комит съобщенията и този файл. Тайните са във Vercel env (само за писане) и в `~/.claude/motamo-tokens.env` на машината.

Общият контекст (бизнес, правила, стил) е в другото репо: `C:\Claude_Motamo` → `CLAUDE.md`, `memory/project-handoff.md`, `docs/PROJECT.md`. Чети ги първо.

## Структура
- `api/menu.js`, `api/order.js` — сайтът (меню, поръчки → Barsy `Accounts_create`).
- `api/cex-plan.js` — цех: калкулатор на деня, заявки от магазините, дашборд, Telegram. Най-големият файл.
- `api/transfer.js` — прехвърляния, часове, заплати (`lib/salary.js`), бот на шофьора.
- `api/shop-dash.js`, `api/peek.js` (само четене от Barsy), `api/wolt-drive.js`, `api/pay-return.js`, `api/order-settle.js`, `api/reconcile-card.js`.
- `lib/` — общи модули (`route.js` маршрути, `promo.js`, `handoff.js`, `timeclock.js` …).

## Правила за тази кодова база
- **Преди качване на промяна в цеха:** `node tools/cex-dry-harness.js` (сух тест). `tools/tc_dry.js` — часове.
- **В страниците на `cex-plan.js` никакви `onclick` с кавички вътре** — чупят страницата. Използвай `data-*` атрибути и `addEventListener`.
- Записите към Barsy (производство, сметки, зареждане) — само през инструментите и след изрично „да“ на собственика. Четенето е свободно (`api/peek.js`).
- Vercel е с cron най-много 1×/ден; по-често чупи деплоя.
- Env във Vercel не се чете обратно: пренаписва се в таблото на Vercel, после `vercel --prod --force` и проверка по поведение (не по CLI).
- Кешът на API е 5 мин — при проверка добавяй `?x=<число>`.
- `git push` в `main` деплойва сам. След деплой: `node C:/Claude_Motamo/tools/smoke.js`.
- Липсващи бройки в цеха се записват през инструмента (`amount == amount_prod`), не ръчно в Barsy.

## Две Barsy бизнес-единици
motamoshop (точка/сайт) и motamo (цех, собствен API потребител). Два хоста с различни самоличности — подробности в `memory/motamo-two-barsy-businesses.md` и `docs/PROJECT.md` в другото репо.
