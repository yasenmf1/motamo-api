// ★ S36 — Сутрешно време + позитивна мисъл в Telegram (@MOTAMO_BOT), всеки работен ден в 7:00 (София).
// Open-Meteo: безплатно, без ключ. Стара Загора → собственика и групата „МОТАМО“; Хасково + Сливен → шофьора (роля „shofior").
// Vercel cron е в UTC, затова двата реда (04:00 и 05:00 UTC) викат run() и тя праща само ако в София е 7 ч.
const TG = require("./telegram.js");

const CITIES = {
  sz: { name: "Стара Загора", lat: 42.4258, lon: 25.6345 },
  hs: { name: "Хасково", lat: 41.9344, lon: 25.5556 },
  sl: { name: "Сливен", lat: 42.6817, lon: 26.3229 }
};

// WMO код → [емоджи, думи]
function desc(code) {
  const c = Number(code);
  if (c === 0) return ["☀️", "ясно"];
  if (c === 1) return ["🌤", "предимно ясно"];
  if (c === 2) return ["⛅", "променлива облачност"];
  if (c === 3) return ["☁️", "облачно"];
  if (c === 45 || c === 48) return ["🌫", "мъгла"];
  if (c >= 51 && c <= 57) return ["🌦", "ръмеж"];
  if (c >= 61 && c <= 67) return ["🌧", "дъжд"];
  if (c >= 71 && c <= 77) return ["❄️", "сняг"];
  if (c >= 80 && c <= 82) return ["🌦", "превалявания"];
  if (c === 85 || c === 86) return ["🌨", "снеговалеж"];
  if (c >= 95) return ["⛈", "гръмотевична буря"];
  return ["🌡", "променливо"];
}

async function forecast(city) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}`
    + `&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max`
    + `&hourly=temperature_2m&timezone=Europe%2FSofia&forecast_days=1&wind_speed_unit=kmh`;
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("open-meteo " + r.status);
  const j = await r.json();
  const d = j.daily || {}, h = (j.hourly || {}).temperature_2m || [];
  return {
    code: (d.weathercode || [])[0], max: Math.round((d.temperature_2m_max || [])[0]), min: Math.round((d.temperature_2m_min || [])[0]),
    rain: (d.precipitation_probability_max || [])[0], wind: Math.round((d.windspeed_10m_max || [])[0]),
    t8: h[8] != null ? Math.round(h[8]) : null, t13: h[13] != null ? Math.round(h[13]) : null, t19: h[19] != null ? Math.round(h[19]) : null
  };
}

function tip(f) {
  if (f.code >= 95) return "⚠️ Очаква се буря — внимателно по пътя.";
  if (f.code >= 71 && f.code <= 86) return "❄️ Сняг — по-бавно и с повече дистанция.";
  if (f.rain >= 60) return "☂️ Вероятен дъжд — вземи чадър.";
  if (f.max >= 33) return "🥵 Много горещо — пий вода и пази продуктите на хладно.";
  if (f.min <= 0) return "🧣 Студено сутринта — облечи се топло.";
  if (f.wind >= 45) return "💨 Силен вятър — внимателно навън.";
  return "";
}

function line(city, f) {
  const [em, w] = desc(f.code);
  const temps = f.t8 != null && f.t13 != null && f.t19 != null ? `${f.t8}° сутрин · ${f.t13}° обед · ${f.t19}° вечер` : `${f.min}° … ${f.max}°`;
  return `${em} <b>${TG.escHtml(city.name)}</b> — ${w}\n🌡 ${temps}\n🌧 дъжд ${f.rain == null ? "?" : f.rain + "%"} · 💨 вятър до ${f.wind} км/ч`;
}

// Кратки, добри мисли — по една на ден (въртят се по деня от годината).
const THOUGHTS = [
  "Всяка хапка, приготвена с грижа, радва някого. Днес правим точно това. 🍣",
  "Малките неща, направени добре, правят големите успехи.",
  "Усмивката е най-евтиният подарък — и най-добре се връща.",
  "Днес е нов ден и нова възможност да направим нещо хубаво.",
  "Заедно сме по-силни, по-бързи и по-усмихнати. 💪",
  "Добра дума струва малко, а значи много. Кажете една днес.",
  "Всеки клиент, който си тръгва доволен, е нашата най-хубава реклама.",
  "Не е важно колко бавно вървиш, стига да не спираш.",
  "Грижата за детайла е това, което ни отличава.",
  "Хубавият ден започва с добро настроение — а то е заразно. 😊",
  "Благодарността превръща обикновения ден в добър.",
  "Който работи с желание, умората го хваща по-късно.",
  "Свежа храна, чисти ръце, топла усмивка — това е рецептата ни.",
  "Всяка трудност е стъпало към нещо по-хубаво.",
  "Гордейте се с това, което правите — хората го усещат.",
  "Днес някой ще се наслади на обяда си заради вас. Това е хубаво. 🥢",
  "Търпението и постоянството побеждават всичко.",
  "Смелите малки стъпки водят до големи промени.",
  "Хубавите екипи се познават по това как се подкрепят в трудния час.",
  "Дори да е сиво навън, ние го правим цветно — с вкус и усмивка. 🌈",
  "Не сравнявай деня си с чужд. Просто бъди по-добър от вчера.",
  "Доброто настроение е най-важната съставка на всяка поръчка.",
  "Правиш повече, отколкото си мислиш — и се вижда.",
  "Започни с малкото, което можеш, и се радвай на всяко свършено нещо.",
  "Здравето и спокойствието са истинското богатство. Пазете се!",
  "Ден по ден, поръчка по поръчка — така се строи нещо голямо.",
  "Който се смее първи, печели деня. 😄",
  "Качеството се помни дълго след като цената е забравена.",
  "Бъдете мили — не знаете каква битка води човекът отсреща.",
  "Всяко „благодаря“ от клиент е причина да продължаваме.",
  "Работата става по-лека, когато имаш до себе си хората, на които държиш.",
  "Утрото е най-добрият момент да решиш, че днес ще е хубав ден. ☀️",
  "Честността и вниманието са най-силните ни страни.",
  "Нека днес е ден, за който ще си спомняме с усмивка.",
  "Успехът е сбор от малки усилия, повтаряни всеки ден.",
  "Спри за миг, вдишай дълбоко и се усмихни — имаш го! 🙌",
  "Най-вкусното нещо в кухнята е любовта към занаята.",
  "Помогни на колега днес и утре някой ще помогне на теб.",
  "Мечтай смело, работи упорито, радвай се на пътя.",
  "Добрите навици се учат всеки ден — един по един.",
  "Благодарни сме за всеки гост, всеки кадър и всеки добре свършен ден.",
  "Днес е добър ден за добър ден. Хайде! 🚀",
  "С чиста кухня и ясна глава всичко е по-лесно.",
  "Усмихнатият екип прави усмихнати клиенти.",
  "Малко спокойствие в най-натоварения час прави чудеса.",
  "Не бързай да бъдеш перфектен — бъди последователен.",
  "Който сее добро, добро жъне. 🌱",
  "Всяка сутрин е втори шанс да направиш деня си прекрасен.",
  "Силни сме, когато работим заедно. Благодаря ви за това! ❤️"
];

function thoughtOfDay(date) {
  const d = new Date(date + "T12:00:00Z");
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const doy = Math.floor((d.getTime() - start) / 86400000);
  return THOUGHTS[doy % THOUGHTS.length];
}

const sofiaHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(new Date()));
const sofiaWeekday = () => new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Sofia", weekday: "short" }).format(new Date());

// opts: { force:true — без проверка за час/ден; to:"owner" — само към собственика (тест) }
async function run(opts) {
  opts = opts || {};
  const date = TG.sofiaDate();
  if (!opts.force) {
    if (sofiaHour() !== 7) return { ok: true, skipped: "not_7am" };
    if (["Sat", "Sun"].indexOf(sofiaWeekday()) !== -1) return { ok: true, skipped: "weekend" };
  }
  const out = { ok: true, date, sent: {} };
  const [sz, hs, sl] = await Promise.all([forecast(CITIES.sz), forecast(CITIES.hs), forecast(CITIES.sl)].map(p => p.catch(() => null)));
  const keep = TG.plusDays(date, 1);

  if (sz) {
    const t = tip(sz);
    const text = `☀️ <b>Добро утро, екип!</b>\n\n${line(CITIES.sz, sz)}${t ? "\n\n" + t : ""}\n\n✨ <i>${TG.escHtml(thoughtOfDay(date))}</i>`;
    const o = await TG.tgSend(text, TG.OWNER_CHAT_ID, keep).catch(() => ({}));
    out.sent.owner = !!o.ok;
    if (opts.to !== "owner") {
      const g = await TG.tgSend(text, TG.CEX_CHAT_ID, keep).catch(() => ({}));
      out.sent.group = !!g.ok;
    }
  } else out.sent.sz = "no_forecast";

  if (hs || sl) {
    const parts = [hs && line(CITIES.hs, hs), sl && line(CITIES.sl, sl)].filter(Boolean).join("\n\n");
    const tips = [hs && tip(hs), sl && tip(sl)].filter(Boolean);
    const text = `🚚 <b>Добро утро, Митко!</b> Времето по маршрута днес:\n\n${parts}${tips.length ? "\n\n" + [...new Set(tips)].join("\n") : ""}\n\n🛣 Приятно и безопасно пътуване!`;
    if (opts.to === "owner") out.sent.driver_preview = !!(await TG.tgSend("(тест — така ще види шофьорът)\n\n" + text, TG.OWNER_CHAT_ID, keep).catch(() => ({}))).ok;
    else out.sent.driver = await TG.sendToRole("shofior", text, keep).catch(() => 0);
  } else out.sent.driver = "no_forecast";
  return out;
}

module.exports = { run, thoughtOfDay, CITIES };
