// ★ S36 — „Пийте вода“ в групата „МОТАМО“ (Пн–Пт, на всеки 2 часа: 11, 13, 15, 17 ч София).
// Vercel cron е в UTC и вика всеки час 08–15 UTC; run() праща само в точните часове на София.
const TG = require("./telegram.js");

const HOURS = [11, 13, 15, 17];
const LINES = [
  "💧 Време е за чаша вода! Пийте и усмихвайте се. 🙂",
  "🥤 Водичка, момичета! Тялото ви ще каже „благодаря“.",
  "💦 Малка пауза — една чаша вода и пак на линия!",
  "🚰 Не забравяйте да пиете вода — по-добре се работи с хидратиран екип.",
  "💧 Чаша вода сега = по-ясна глава и повече енергия. 💪",
  "🥛 Хидратация! Вода, преди да сте усетили жажда.",
  "💦 Пийнете вода и си поемете дълбоко въздух. Справяте се страхотно! 🌟",
  "🧊 Студена вода за топъл екип! Наздраве! 🙂",
  "💧 Напомняне от бота: вода! После продължаваме с поръчките. 🍣",
  "🌊 Нова чаша вода — нов прилив от сили!"
];

const sofiaHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(new Date()));
const sofiaWeekday = () => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", weekday: "short" }).format(new Date());

async function run(opts) {
  opts = opts || {};
  const h = sofiaHour();
  if (!opts.force) {
    if (["Sat", "Sun"].indexOf(sofiaWeekday()) !== -1) return { ok: true, skipped: "weekend" };
    if (HOURS.indexOf(h) === -1) return { ok: true, skipped: "not_water_hour", hour: h };
  }
  const date = TG.sofiaDate();
  const text = LINES[(Math.floor(new Date(date + "T12:00:00Z").getTime() / 86400000) * 4 + Math.max(0, HOURS.indexOf(h))) % LINES.length];
  const r = await TG.tgSend(text, opts.to === "owner" ? TG.OWNER_CHAT_ID : TG.CEX_CHAT_ID, date).catch(() => ({}));
  return { ok: !!r.ok, hour: h, to: opts.to || "group" };
}

module.exports = { run };
