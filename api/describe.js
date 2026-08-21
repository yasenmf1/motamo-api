/**
 * Разбор на описанието от Барси в еднакви полета.
 *
 * Описанията се пишат на ръка в касата и всяко е различно: „Тегло:", „Тегло -",
 * „Тегло 170 гр." без двоеточие, „Количество", „Хапки", „бр." без число, „Сътав"
 * с изпусната буква. На картата това изглежда като шейсет различни продукта от
 * шейсет различни магазина.
 *
 * Затова разборът е тук, а не в Барси и не в браузъра:
 * - В Барси не е, защото правилото на проекта е цените, снимките, описанията и
 *   грамажите да се пишат САМО в касата и да идват сами. Препишем ли ги тук, ще
 *   се разминат при първата поправка и собственикът ще поддържа две менюта.
 * - В браузъра не е, защото разборът трябва да е един за сайта и за всичко, което
 *   утре чете същото API.
 *
 * Разборът е нарочно търпелив към входа и строг към изхода: приема както е
 * написано, връща винаги едно и също. Каквото не разпознае, остава в описанието —
 * текст на собственика не се губи, само защото не е сложил етикет.
 */

// Етикетите, както реално се срещат в касата. „Сътав" е печатна грешка при
// Нобунага; по-лесно е да се приеме, отколкото да се чака поправка, а поправката
// в Барси и без това ще проработи.
const LABELS = [
  { key: "composition", re: /^[ \t]*(?:състав|сътав|сьстав)[ \t]*[:：\-–—]?[ \t]*(.*)$/i },
  { key: "weight",      re: /^[ \t]*тегло[ \t]*[:：\-–—]?[ \t]*(.*)$/i },
  { key: "count",       re: /^[ \t]*(?:количество|хапки|брой)[ \t]*[:：\-–—]?[ \t]*(.*)$/i }
];

/** HTML от редактора на Барси → чист текст с редове. */
function toText(raw) {
  if (!raw) return "";
  let s = String(raw)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  // Барси връща entity-та (&nbsp;, &amp;) — разкодират се тук, а сайтът после
  // ги вкарва като текстови nodes, не като HTML, така че „оживяване" на таг няма.
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
       .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
       .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  return s.replace(/ /g, " ")
          .replace(/\r/g, "")
          .replace(/[ \t]{2,}/g, " ")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
}

/** „115 гр." · „110 гр" · „ 85 гр." → „115 г". Без число — нищо. */
function normWeight(v) {
  const m = String(v).match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|гр|g|г)?\b/i);
  if (!m) return null;
  const n = m[1].replace(",", ".");
  const kg = /^(кг|kg)$/i.test(m[2] || "");
  return kg ? `${n} кг` : `${Math.round(Number(n))} г`;
}

/** „8 бр." · „1бр." · „4 бр" → „8 бр.". „бр." без число → нищо, а не „0 бр." */
function normCount(v, unit) {
  const m = String(v).match(/(\d+)\s*(бр|хапк|парч)?/i);
  if (!m) return null;
  return `${m[1]} ${unit || "бр."}`;
}

/**
 * Сетовете нямат ред „Количество" — броят им живее в рекламния текст („40 хапки
 * за голяма sushi вечер"). Изваждаме го оттам, вместо да оставим полето празно:
 * това е истинско число на собственика, не измислено от нас.
 */
function countFromLead(lead) {
  const m = String(lead).match(/(\d+)\s*хапк/i);
  return m ? `${m[1]} хапки` : null;
}

/**
 * @param {string} raw   description_ml.bg_BG от Барси
 * @param {string} name  публичното име — само за да махнем повторено заглавие
 * @returns {{lead:string|null, composition:string|null, weight:string|null, count:string|null}}
 */
function parseDescription(raw, name) {
  const text = toText(raw);
  if (!text) return { lead: null, composition: null, weight: null, count: null };

  const lines = text.split("\n");
  const lead = [];
  const found = { composition: [], weight: [], count: [] };
  let current = null;

  lines.forEach(function (line) {
    for (const { key, re } of LABELS) {
      const m = line.match(re);
      if (!m) continue;
      // „Състав: 4 бр." при Саке Криспи е сбъркан етикет — стойността издава кое
      // поле е било замислено. Числото с „бр." не е състав на ролка.
      const rest = m[1].trim();
      const key2 = (key === "composition" && /^\d+\s*(бр|хапк)/i.test(rest)) ? "count" : key;
      current = key2;
      if (rest) found[key2].push(rest);
      return;
    }
    // Умами Сет е с изпуснат етикет „Състав:" — редът с разбивката стои гол.
    // Ред, който целият е изброяване „Име - N бр.", е състав по форма, каквото и
    // да пише пред него; проза така не изглежда. Тесен нарочно: две съставки
    // минимум и целият ред трябва да съвпадне.
    if (!current && /^(?:[^\-–—]{2,40}[\-–—]\s*\d+\s*бр\.?\s*){2,}$/i.test(line.trim())) {
      found.composition.push(line.trim());
      current = "composition";
      return;
    }
    // Ред без етикет продължава последното поле, а преди първия етикет е описание.
    (current ? found[current] : lead).push(line);
  });

  // Преходите на редове идват от редактора на Барси — там някой е натиснал Enter,
  // за да се събере в кутийката, не защото е нов абзац. На картата се сглобяват
  // в един слят текст: иначе една ролка е на три реда, съседната на един, и
  // решетката изглежда неподредена, без нито едно описание да е сгрешено.
  const join = (a) => a.join(" ").replace(/\s+/g, " ").trim() || null;
  let leadText = join(lead);

  // „КИОТО СЕТ" като първи ред на Киото Сет не казва нищо ново — името вече е
  // заглавието на картата.
  if (leadText && name) {
    const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const parts = leadText.split("\n");
    if (norm(parts[0]) === norm(name)) leadText = parts.slice(1).join("\n").trim() || null;
  }

  const composition = join(found.composition);
  const weight = found.weight.length ? normWeight(found.weight.join(" ")) : null;
  let count = found.count.length ? normCount(found.count.join(" ")) : null;
  if (!count && leadText) count = countFromLead(leadText);

  return { lead: leadText, composition, weight, count };
}

module.exports = { parseDescription, toText };
