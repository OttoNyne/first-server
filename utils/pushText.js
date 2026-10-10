// What a push notification says, in each language the site speaks. Deliberately little: who did what, never what they wrote (it shows on a lock
// screen). The language is the one stored on the recipient's account (utils/languages.js); anything else is English.
import { languageOf } from "./languages.js";

const plural = (lang, n) => new Intl.PluralRules(lang).select(n);

const TEXT = {
  // { who, count }
  message: {
    en: ({ who, count }) => `${who} sent you ${count > 1 ? `${count} messages` : "a message"}`,
    es: ({ who, count }) => `${who} te envió ${count > 1 ? `${count} mensajes` : "un mensaje"}`,
    ar: ({ who, count }) => {
      const form = count > 1 ? plural("ar", count) : "one";
      const what = form === "one" ? "رسالة" : form === "two" ? "رسالتين" : form === "few" ? `${count} رسائل` : `${count} رسالة`;
      return `${who} أرسل إليك ${what}`;
    },
  },
  friend_request: { en: ({ who }) => `${who} sent you a friend request`, es: ({ who }) => `${who} te envió una solicitud de amistad`, ar: ({ who }) => `${who} أرسل إليك طلب صداقة` },
  friend_accept: { en: ({ who }) => `${who} accepted your friend request`, es: ({ who }) => `${who} aceptó tu solicitud de amistad`, ar: ({ who }) => `${who} قبل طلب صداقتك` },
  invite_joined: { en: ({ who }) => `${who} joined with your invite link`, es: ({ who }) => `${who} se unió con tu enlace de invitación`, ar: ({ who }) => `${who} انضم عبر رابط دعوتك` },
  group_invite: { en: ({ who }) => `${who} invited you to a group`, es: ({ who }) => `${who} te invitó a un grupo`, ar: ({ who }) => `${who} دعاك إلى مجموعة` },
  friend_birthday: { en: ({ who }) => `${who} has a birthday today`, es: ({ who }) => `${who} cumple años hoy`, ar: ({ who }) => `${who} يحتفل بعيد ميلاده اليوم` },
  comment: { en: ({ who }) => `${who} commented on your post`, es: ({ who }) => `${who} comentó tu publicación`, ar: ({ who }) => `${who} علّق على منشورك` },
  profile_comment: { en: ({ who }) => `${who} left a comment on your profile`, es: ({ who }) => `${who} dejó un comentario en tu perfil`, ar: ({ who }) => `${who} ترك تعليقًا على ملفك الشخصي` },
  media_comment: { en: ({ who }) => `${who} commented on your portfolio`, es: ({ who }) => `${who} comentó tu portafolio`, ar: ({ who }) => `${who} علّق على معرض أعمالك` },
  blog_comment: { en: ({ who }) => `${who} commented on your blog entry`, es: ({ who }) => `${who} comentó tu entrada del blog`, ar: ({ who }) => `${who} علّق على تدوينتك` },
  // { who, mark }
  reaction_post: { en: ({ who, mark }) => `${who} reacted ${mark} to your post`, es: ({ who, mark }) => `${who} reaccionó ${mark} a tu publicación`, ar: ({ who, mark }) => `${who} تفاعل بـ${mark} مع منشورك` },
  reaction_portfolio: { en: ({ who, mark }) => `${who} reacted ${mark} to your portfolio`, es: ({ who, mark }) => `${who} reaccionó ${mark} a tu portafolio`, ar: ({ who, mark }) => `${who} تفاعل بـ${mark} مع معرض أعمالك` },
  event_created: { en: ({ who }) => `${who} is planning an event`, es: ({ who }) => `${who} está organizando un evento`, ar: ({ who }) => `${who} ينظّم فعالية` },
  event_updated: { en: ({ who }) => `${who} changed an event you answered`, es: ({ who }) => `${who} cambió un evento al que respondiste`, ar: ({ who }) => `${who} غيّر فعالية أجبتَ عنها` },
  event_cancelled: { en: ({ who }) => `${who} cancelled an event`, es: ({ who }) => `${who} canceló un evento`, ar: ({ who }) => `${who} ألغى فعالية` },
  event_reminder: { en: () => "An event you're going to is starting soon", es: () => "Un evento al que vas a ir empieza pronto", ar: () => "فعالية ستحضرها ستبدأ قريبًا" },
  live_scheduled: { en: ({ who }) => `${who} scheduled a live`, es: ({ who }) => `${who} programó una transmisión en vivo`, ar: ({ who }) => `${who} حدّد موعدًا لبث مباشر` },
  live_reminder: { en: () => "A live you asked about is starting soon", es: () => "Una transmisión en vivo que pediste recordar empieza pronto", ar: () => "بث مباشر طلبت التذكير به سيبدأ قريبًا" },
  live_started: { en: ({ who }) => `${who} is live now`, es: ({ who }) => `${who} está en vivo ahora`, ar: ({ who }) => `${who} يبث مباشرة الآن` },
  blog_post: { en: ({ who }) => `${who} wrote a blog entry`, es: ({ who }) => `${who} escribió una entrada del blog`, ar: ({ who }) => `${who} كتب تدوينة` },
  help_offer: { en: ({ who }) => `${who} offered to help with your request`, es: ({ who }) => `${who} se ofreció a ayudar con tu petición`, ar: ({ who }) => `${who} عرض المساعدة في طلبك` },
  help_accepted: { en: ({ who }) => `${who} accepted your offer to help`, es: ({ who }) => `${who} aceptó tu oferta de ayuda`, ar: ({ who }) => `${who} قبل عرضك للمساعدة` },
  report_resolved: { en: () => "A moderator looked at your report", es: () => "Un moderador revisó tu denuncia", ar: () => "راجع أحد المشرفين بلاغك" },
  content_removed: { en: () => "A moderator removed something you posted", es: () => "Un moderador eliminó algo que publicaste", ar: () => "أزال أحد المشرفين شيئًا نشرته" },
  credit_request: { en: ({ who }) => `${who} credited you on a piece`, es: ({ who }) => `${who} te dio un crédito en una obra`, ar: ({ who }) => `${who} ذكرك ضمن المشاركين في عمل` },
  credit_accepted: { en: ({ who }) => `${who} accepted a credit on your piece`, es: ({ who }) => `${who} aceptó un crédito en tu obra`, ar: ({ who }) => `${who} قبل الاعتماد في عملك` },
  work_request: { en: ({ who }) => `${who} sent you a request for work`, es: ({ who }) => `${who} te envió una solicitud de trabajo`, ar: ({ who }) => `${who} أرسل إليك طلب عمل` },
  mention: { en: ({ who }) => `${who} mentioned you`, es: ({ who }) => `${who} te mencionó`, ar: ({ who }) => `${who} أشار إليك` },
  follow: { en: ({ who }) => `${who} started following you`, es: ({ who }) => `${who} empezó a seguirte`, ar: ({ who }) => `${who} بدأ بمتابعتك` },
  repost: { en: ({ who }) => `${who} shared your post`, es: ({ who }) => `${who} compartió tu publicación`, ar: ({ who }) => `${who} شارك منشورك` },
  reply: { en: ({ who }) => `${who} replied to your comment`, es: ({ who }) => `${who} respondió a tu comentario`, ar: ({ who }) => `${who} ردّ على تعليقك` },
  scheduled_post: { en: () => "Your scheduled post is now live", es: () => "Tu publicación programada ya está publicada", ar: () => "منشورك المجدول أصبح منشورًا الآن" },
  scheduled_post_failed: { en: () => "Your scheduled post couldn't be published", es: () => "No se pudo publicar tu publicación programada", ar: () => "تعذّر نشر منشورك المجدول" },
  critique_note: { en: ({ who }) => `${who} gave you feedback on a piece`, es: ({ who }) => `${who} te dio su opinión sobre una obra`, ar: ({ who }) => `${who} قدّم لك ملاحظات على أحد أعمالك` },
  critique_thanks: { en: ({ who }) => `${who} thanked you for your feedback`, es: ({ who }) => `${who} te agradeció tu opinión`, ar: ({ who }) => `${who} شكرك على ملاحظاتك` },
  project_message: { en: ({ who }) => `${who} wrote in your project room`, es: ({ who }) => `${who} escribió en tu sala de proyecto`, ar: ({ who }) => `${who} كتب في غرفة مشروعك` },
  call_match: { en: ({ who }) => `${who} posted an open call that fits what you offer`, es: ({ who }) => `${who} publicó una convocatoria que encaja con lo que ofreces`, ar: ({ who }) => `${who} نشر دعوة مفتوحة تناسب ما تقدمه` },
  call_application: { en: ({ who }) => `${who} applied to your open call`, es: ({ who }) => `${who} respondió a tu convocatoria`, ar: ({ who }) => `${who} تقدّم إلى دعوتك المفتوحة` },
  call_answer: { en: ({ who }) => `${who} answered your application to an open call`, es: ({ who }) => `${who} respondió a tu candidatura a una convocatoria`, ar: ({ who }) => `${who} ردّ على طلبك للانضمام إلى دعوة مفتوحة` },
  work_reply: { en: ({ who }) => `${who} answered your request for work`, es: ({ who }) => `${who} respondió a tu solicitud de trabajo`, ar: ({ who }) => `${who} ردّ على طلب العمل الذي أرسلته` },
  cs_verified: { en: () => "You're now CSverified", es: () => "Ya estás verificado en CS", ar: () => "أصبحت الآن موثّقًا في CS" },
  test: { en: () => "Notifications are working on this device", es: () => "Las notificaciones funcionan en este dispositivo", ar: () => "الإشعارات تعمل على هذا الجهاز" },
};

export const PUSH_KINDS = Object.keys(TEXT);

/** The words of one push, in the language of `who` (an account, or a language code); English if unknown. */
export function pushBody(kind, who, params = {}) {
  const lang = typeof who === "string" ? (["en", "es", "ar"].includes(who) ? who : "en") : languageOf(who);
  return TEXT[kind][lang](params);
}
