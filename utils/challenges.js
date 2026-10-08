// The weekly creative challenge: every week has one short prompt, the same for everyone, and people enter one of their portfolio pieces.
//
// Nobody has to run it. The week (Monday to Sunday, UTC) names itself, "2026-W41", and the prompt is picked from this list by the week,
// so every server agrees without anything being stored, and it comes round again after the list has been through.
import { isLanguage } from "./languages.js";

export const PROMPTS = [
  { en: "Reflection", es: "Reflejo", ar: "انعكاس" },
  { en: "Night market", es: "Mercado nocturno", ar: "سوق الليل" },
  { en: "Hands at work", es: "Manos trabajando", ar: "أيادٍ تعمل" },
  { en: "A color you never use", es: "Un color que nunca usas", ar: "لون لا تستخدمه أبدًا" },
  { en: "Home", es: "Hogar", ar: "الوطن" },
  { en: "Tiny", es: "Diminuto", ar: "صغير جدًا" },
  { en: "The sound of rain", es: "El sonido de la lluvia", ar: "صوت المطر" },
  { en: "Made from scraps", es: "Hecho con restos", ar: "مصنوع من البقايا" },
  { en: "Two of a kind", es: "Un par", ar: "اثنان متشابهان" },
  { en: "Golden hour", es: "La hora dorada", ar: "الساعة الذهبية" },
  { en: "A letter to someone", es: "Una carta a alguien", ar: "رسالة إلى شخص ما" },
  { en: "Pattern", es: "Patrón", ar: "نمط" },
  { en: "Something you fixed", es: "Algo que arreglaste", ar: "شيء أصلحته" },
  { en: "Crowd", es: "Multitud", ar: "حشد" },
  { en: "Quiet", es: "Silencio", ar: "هدوء" },
  { en: "A creature that doesn't exist", es: "Una criatura que no existe", ar: "مخلوق غير موجود" },
  { en: "Shadows", es: "Sombras", ar: "ظلال" },
  { en: "Street food", es: "Comida callejera", ar: "طعام الشارع" },
  { en: "Thirty minutes only", es: "Solo treinta minutos", ar: "ثلاثون دقيقة فقط" },
  { en: "Memory", es: "Recuerdo", ar: "ذكرى" },
  { en: "Handmade gift", es: "Regalo hecho a mano", ar: "هدية صُنعت يدويًا" },
  { en: "Water", es: "Agua", ar: "ماء" },
  { en: "Old and new", es: "Lo viejo y lo nuevo", ar: "القديم والجديد" },
  { en: "A view from your window", es: "La vista desde tu ventana", ar: "المنظر من نافذتك" },
  { en: "Only two colors", es: "Solo dos colores", ar: "لونان فقط" },
  { en: "Celebration", es: "Celebración", ar: "احتفال" },
];

const WEEK = /^(\d{4})-W(\d{2})$/;
const DAY = 86_400_000;

/** The Monday (00:00 UTC) that starts the ISO week containing `date`. */
function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setTime(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  return d;
}

/** The ISO week containing `date`: its key ("2026-W41") and the moment it starts and ends. */
export function weekOf(date = new Date()) {
  const start = mondayOf(date);
  const thursday = new Date(start.getTime() + 3 * DAY); // the ISO year and week number are those of the week's Thursday
  const year = thursday.getUTCFullYear();
  const firstThursday = mondayOf(new Date(Date.UTC(year, 0, 4))).getTime() + 3 * DAY;
  const number = 1 + Math.round((thursday.getTime() - firstThursday) / (7 * DAY));
  return { key: `${year}-W${String(number).padStart(2, "0")}`, start, end: new Date(start.getTime() + 7 * DAY) };
}

/** The week before the one containing `date`. */
export const previousWeek = (date = new Date()) => weekOf(new Date(mondayOf(date).getTime() - DAY));

/** The week a key names (`null` if it is not a real week of a real year). */
export function weekFromKey(key) {
  const match = typeof key === "string" ? WEEK.exec(key) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  if (year < 2020 || year > 2100 || number < 1 || number > 53) return null;
  const week1Monday = mondayOf(new Date(Date.UTC(year, 0, 4)));
  const week = weekOf(new Date(week1Monday.getTime() + (number - 1) * 7 * DAY));
  return week.key === key ? week : null;
}

/** The prompt for a week, in a language (English when it is not one we have). */
export function promptFor(week, language = "en") {
  const [, year, number] = WEEK.exec(week.key);
  const prompt = PROMPTS[(Number(year) * 53 + Number(number)) % PROMPTS.length];
  return prompt[isLanguage(language) ? language : "en"];
}
