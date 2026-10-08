// The words of every email the site sends, in each language it speaks. The language is the one the person chose on the site (stored on their
// account, see utils/languages.js); anything else is English. An email's text is plain: links are put in as given, never built from what a person typed.
import { languageOf } from "./languages.js";

const FOOTER_NOT_YOU = {
  en: "If that wasn't you, change your password right away and sign out other devices from your profile settings.",
  es: "Si no fuiste tú, cambia tu contraseña de inmediato y cierra la sesión en los demás dispositivos desde los ajustes de tu perfil.",
  ar: "إذا لم يكن ذلك أنت، فغيّر كلمة المرور فورًا وأنهِ جلسات الأجهزة الأخرى من إعدادات ملفك الشخصي.",
};

const hi = {
  en: (name) => `Hi ${name},`,
  es: (name) => `Hola, ${name}:`,
  ar: (name) => `مرحبًا ${name}،`,
};

const join = (lang, name, ...parts) => [hi[lang](name), ...parts].join("\n\n");

const KINDS = {
  // Someone asked to reset a password: p = { name, link }
  resetLink: {
    en: (p) => ({
      subject: "Reset your CreativesSelect password",
      text: `Hi ${p.name},\n\nSomeone asked to reset the password for your CreativesSelect account. To choose a new one, open this link within an hour:\n\n${p.link}\n\nIf that wasn't you, ignore this email — your password stays as it is.`,
    }),
    es: (p) => ({
      subject: "Restablece tu contraseña de CreativesSelect",
      text: join("es", p.name, "Alguien pidió restablecer la contraseña de tu cuenta de CreativesSelect. Para elegir una nueva, abre este enlace en el plazo de una hora:", p.link, "Si no fuiste tú, ignora este correo: tu contraseña no cambia."),
    }),
    ar: (p) => ({
      subject: "إعادة تعيين كلمة مرور CreativesSelect",
      text: join("ar", p.name, "طلب أحدهم إعادة تعيين كلمة المرور لحسابك في CreativesSelect. لاختيار كلمة مرور جديدة، افتح هذا الرابط خلال ساعة:", p.link, "إذا لم يكن ذلك أنت، فتجاهل هذه الرسالة — تبقى كلمة مرورك كما هي."),
    }),
  },
  // The password was reset: p = { name, removedPasskeys }
  passwordReset: {
    en: (p) => ({
      subject: "Your CreativesSelect password was changed",
      text: `Hi ${p.name},\n\nThe password for your CreativesSelect account was just reset. If that was you, there's nothing to do. ${p.removedPasskeys ? "Any passkeys on the account were removed too, as a precaution: add them again from your profile settings. " : ""}If it wasn't, reset it again right away.`,
    }),
    es: (p) => ({
      subject: "Se cambió la contraseña de tu cuenta de CreativesSelect",
      text: join("es", p.name, `Acabamos de restablecer la contraseña de tu cuenta de CreativesSelect. Si fuiste tú, no tienes que hacer nada. ${p.removedPasskeys ? "También se quitaron las claves de acceso de la cuenta, por precaución: vuelve a añadirlas desde los ajustes de tu perfil. " : ""}Si no fuiste tú, restablécela de nuevo de inmediato.`),
    }),
    ar: (p) => ({
      subject: "تم تغيير كلمة مرور حسابك في CreativesSelect",
      text: join("ar", p.name, `تمت إعادة تعيين كلمة المرور لحسابك في CreativesSelect قبل قليل. إذا كنت أنت من فعل ذلك فلا تحتاج إلى أي إجراء. ${p.removedPasskeys ? "أُزيلت أيضًا مفاتيح المرور المرتبطة بالحساب كإجراء احترازي: أضفها مجددًا من إعدادات ملفك الشخصي. " : ""}وإذا لم تكن أنت، فأعد تعيينها مرة أخرى فورًا.`),
    }),
  },
  // Confirm the address of a new account: p = { name, link }
  verify: {
    en: (p) => ({
      subject: "Confirm your CreativesSelect email",
      text: `Hi ${p.name},\n\nWelcome to CreativesSelect. Please confirm this is your email address by opening this link within 24 hours:\n\n${p.link}\n\nIf you didn't create an account, you can ignore this email.`,
    }),
    es: (p) => ({
      subject: "Confirma tu correo de CreativesSelect",
      text: join("es", p.name, "Te damos la bienvenida a CreativesSelect. Confirma que esta es tu dirección de correo abriendo este enlace en el plazo de 24 horas:", p.link, "Si no creaste una cuenta, puedes ignorar este correo."),
    }),
    ar: (p) => ({
      subject: "أكّد بريدك الإلكتروني في CreativesSelect",
      text: join("ar", p.name, "أهلًا بك في CreativesSelect. يرجى تأكيد أن هذا هو عنوان بريدك الإلكتروني بفتح هذا الرابط خلال 24 ساعة:", p.link, "إذا لم تنشئ حسابًا، يمكنك تجاهل هذه الرسالة."),
    }),
  },
  // To the NEW address: p = { name, username, link }
  emailChangeConfirm: {
    en: (p) => ({
      subject: "Confirm your new CreativesSelect email",
      text: `Hi ${p.name},\n\nSomeone asked to use this address for the CreativesSelect account "${p.username}". To confirm it is yours and make the change, open this link within an hour:\n\n${p.link}\n\nIf you didn't ask for this, ignore this email: nothing will change.`,
    }),
    es: (p) => ({
      subject: "Confirma tu nuevo correo de CreativesSelect",
      text: join("es", p.name, `Alguien pidió usar esta dirección para la cuenta de CreativesSelect «${p.username}». Para confirmar que es tuya y hacer el cambio, abre este enlace en el plazo de una hora:`, p.link, "Si no lo pediste, ignora este correo: no cambiará nada."),
    }),
    ar: (p) => ({
      subject: "أكّد بريدك الإلكتروني الجديد في CreativesSelect",
      text: join("ar", p.name, `طلب أحدهم استخدام هذا العنوان لحساب CreativesSelect «${p.username}». للتأكد من أنه عنوانك وإتمام التغيير، افتح هذا الرابط خلال ساعة:`, p.link, "إذا لم تطلب ذلك، فتجاهل هذه الرسالة: لن يتغير شيء."),
    }),
  },
  // To the OLD address, when a change was asked for: p = { name, masked }
  emailChangeAsked: {
    en: (p) => ({
      subject: "A change of email was asked for on your CreativesSelect account",
      text: `Hi ${p.name},\n\nSomeone who knew your password asked to change the email address of your CreativesSelect account to ${p.masked}. Nothing has changed yet: it only changes if the link sent to that address is opened within an hour.\n\nIf that was you, there's nothing to do. If it wasn't, change your password right away from your profile settings.`,
    }),
    es: (p) => ({
      subject: "Se pidió un cambio de correo en tu cuenta de CreativesSelect",
      text: join("es", p.name, `Alguien que conocía tu contraseña pidió cambiar la dirección de correo de tu cuenta de CreativesSelect a ${p.masked}. Todavía no ha cambiado nada: solo cambiará si se abre en el plazo de una hora el enlace enviado a esa dirección.`, "Si fuiste tú, no tienes que hacer nada. Si no fuiste tú, cambia tu contraseña de inmediato desde los ajustes de tu perfil."),
    }),
    ar: (p) => ({
      subject: "طُلب تغيير البريد الإلكتروني لحسابك في CreativesSelect",
      text: join("ar", p.name, `طلب شخص يعرف كلمة مرورك تغيير عنوان البريد الإلكتروني لحسابك في CreativesSelect إلى ${p.masked}. لم يتغير شيء بعد: لن يتغير إلا إذا فُتح خلال ساعة الرابط المرسل إلى ذلك العنوان.`, "إذا كنت أنت من فعل ذلك فلا تحتاج إلى أي إجراء. وإذا لم تكن أنت، فغيّر كلمة المرور فورًا من إعدادات ملفك الشخصي."),
    }),
  },
  // To the old address, once the change was made: p = { name, masked, link }
  emailChanged: {
    en: (p) => ({
      subject: "The email on your CreativesSelect account was changed",
      text: `Hi ${p.name},\n\nThe email address of your CreativesSelect account was just changed to ${p.masked}.\n\nIf that was you, there's nothing to do.\n\nIf it wasn't, open this link within 7 days to put this address back and sign every device out:\n\n${p.link}\n\nThen use "Forgot password" to choose a new password.`,
    }),
    es: (p) => ({
      subject: "Se cambió el correo de tu cuenta de CreativesSelect",
      text: join("es", p.name, `La dirección de correo de tu cuenta de CreativesSelect acaba de cambiar a ${p.masked}.`, "Si fuiste tú, no tienes que hacer nada.", "Si no fuiste tú, abre este enlace en el plazo de 7 días para volver a poner esta dirección y cerrar la sesión en todos los dispositivos:", p.link, "Después usa «¿Olvidaste tu contraseña?» para elegir una nueva."),
    }),
    ar: (p) => ({
      subject: "تم تغيير البريد الإلكتروني لحسابك في CreativesSelect",
      text: join("ar", p.name, `تم تغيير عنوان البريد الإلكتروني لحسابك في CreativesSelect قبل قليل إلى ${p.masked}.`, "إذا كنت أنت من فعل ذلك فلا تحتاج إلى أي إجراء.", "وإذا لم تكن أنت، فافتح هذا الرابط خلال 7 أيام لإعادة هذا العنوان وإنهاء جلسات جميع الأجهزة:", p.link, "ثم استخدم «نسيت كلمة المرور؟» لاختيار كلمة مرور جديدة."),
    }),
  },
  // The way back was used: p = { name, masked }
  emailRestored: {
    en: (p) => ({
      subject: "Your CreativesSelect email was put back",
      text: `Hi ${p.name},\n\nThe email address of your CreativesSelect account is ${p.masked} again, and every device was signed out. Any passkeys were removed too, as a precaution: add them again from your profile settings. Use "Forgot password" on the login page to choose a new password.`,
    }),
    es: (p) => ({
      subject: "Se restituyó tu correo de CreativesSelect",
      text: join("es", p.name, `La dirección de correo de tu cuenta de CreativesSelect vuelve a ser ${p.masked} y se cerró la sesión en todos los dispositivos. También se quitaron las claves de acceso, por precaución: vuelve a añadirlas desde los ajustes de tu perfil. Usa «¿Olvidaste tu contraseña?» en la página de inicio de sesión para elegir una nueva.`),
    }),
    ar: (p) => ({
      subject: "تمت إعادة بريدك الإلكتروني في CreativesSelect",
      text: join("ar", p.name, `عاد عنوان البريد الإلكتروني لحسابك في CreativesSelect إلى ${p.masked}، وأُنهيت جلسات جميع الأجهزة. أُزيلت أيضًا مفاتيح المرور كإجراء احترازي: أضفها مجددًا من إعدادات ملفك الشخصي. استخدم «نسيت كلمة المرور؟» في صفحة تسجيل الدخول لاختيار كلمة مرور جديدة.`),
    }),
  },
  // A passkey was added: p = { name, keyName }
  passkeyAdded: {
    en: (p) => ({
      subject: "A passkey was added to your CreativesSelect account",
      text: `Hi ${p.name},\n\nA passkey called "${p.keyName}" was just added to your CreativesSelect account. It can now be used to log in without your password.\n\n${FOOTER_NOT_YOU.en}`,
    }),
    es: (p) => ({
      subject: "Se añadió una clave de acceso a tu cuenta de CreativesSelect",
      text: join("es", p.name, `Se acaba de añadir una clave de acceso llamada «${p.keyName}» a tu cuenta de CreativesSelect. Ahora se puede usar para iniciar sesión sin tu contraseña.`, FOOTER_NOT_YOU.es),
    }),
    ar: (p) => ({
      subject: "أُضيف مفتاح مرور إلى حسابك في CreativesSelect",
      text: join("ar", p.name, `أُضيف قبل قليل مفتاح مرور باسم «${p.keyName}» إلى حسابك في CreativesSelect. يمكن الآن استخدامه لتسجيل الدخول دون كلمة المرور.`, FOOTER_NOT_YOU.ar),
    }),
  },
  passkeyRemoved: {
    en: (p) => ({
      subject: "A passkey was removed from your CreativesSelect account",
      text: `Hi ${p.name},\n\nThe passkey called "${p.keyName}" was just removed from your CreativesSelect account.\n\n${FOOTER_NOT_YOU.en}`,
    }),
    es: (p) => ({
      subject: "Se quitó una clave de acceso de tu cuenta de CreativesSelect",
      text: join("es", p.name, `Se acaba de quitar la clave de acceso llamada «${p.keyName}» de tu cuenta de CreativesSelect.`, FOOTER_NOT_YOU.es),
    }),
    ar: (p) => ({
      subject: "أُزيل مفتاح مرور من حسابك في CreativesSelect",
      text: join("ar", p.name, `أُزيل قبل قليل مفتاح المرور المسمّى «${p.keyName}» من حسابك في CreativesSelect.`, FOOTER_NOT_YOU.ar),
    }),
  },
  twoFactorOn: {
    en: (p) => ({
      subject: "Two-step sign-in was turned on",
      text: `Hi ${p.name},\n\nTwo-step sign-in was just turned on for your CreativesSelect account. From now on, logging in needs a code from your authenticator app.\n\n${FOOTER_NOT_YOU.en}`,
    }),
    es: (p) => ({
      subject: "Se activó el inicio de sesión en dos pasos",
      text: join("es", p.name, "Se acaba de activar el inicio de sesión en dos pasos en tu cuenta de CreativesSelect. A partir de ahora, para iniciar sesión hace falta un código de tu aplicación de autenticación.", FOOTER_NOT_YOU.es),
    }),
    ar: (p) => ({
      subject: "تم تفعيل تسجيل الدخول بخطوتين",
      text: join("ar", p.name, "تم تفعيل تسجيل الدخول بخطوتين لحسابك في CreativesSelect قبل قليل. من الآن فصاعدًا يتطلب تسجيل الدخول رمزًا من تطبيق المصادقة.", FOOTER_NOT_YOU.ar),
    }),
  },
  twoFactorOff: {
    en: (p) => ({
      subject: "Two-step sign-in was turned off",
      text: `Hi ${p.name},\n\nTwo-step sign-in was just turned off for your CreativesSelect account.\n\n${FOOTER_NOT_YOU.en}`,
    }),
    es: (p) => ({
      subject: "Se desactivó el inicio de sesión en dos pasos",
      text: join("es", p.name, "Se acaba de desactivar el inicio de sesión en dos pasos en tu cuenta de CreativesSelect.", FOOTER_NOT_YOU.es),
    }),
    ar: (p) => ({
      subject: "تم إيقاف تسجيل الدخول بخطوتين",
      text: join("ar", p.name, "تم إيقاف تسجيل الدخول بخطوتين لحسابك في CreativesSelect قبل قليل.", FOOTER_NOT_YOU.ar),
    }),
  },
  // A sign-in from a device not seen before: p = { name, device, when }
  newSignIn: {
    en: (p) => ({
      subject: "New sign-in to your CreativesSelect account",
      text: [
        `Hi ${p.name},`,
        `Your CreativesSelect account was just signed in to from a browser or phone we haven't seen before: ${p.device}, at ${p.when}.`,
        "If that was you, there's nothing to do.",
        "If it wasn't, change your password right away (that signs every other device out) and turn on two-step sign-in, both from your profile settings.",
        'You can turn these emails off under "Where you\'re signed in" in your profile settings.',
      ].join("\n\n"),
    }),
    es: (p) => ({
      subject: "Nuevo inicio de sesión en tu cuenta de CreativesSelect",
      text: join(
        "es",
        p.name,
        `Se acaba de iniciar sesión en tu cuenta de CreativesSelect desde un navegador o teléfono que no habíamos visto antes: ${p.device}, el ${p.when}.`,
        "Si fuiste tú, no tienes que hacer nada.",
        "Si no fuiste tú, cambia tu contraseña de inmediato (así se cierra la sesión en todos los demás dispositivos) y activa el inicio de sesión en dos pasos, ambas cosas desde los ajustes de tu perfil.",
        "Puedes desactivar estos correos en «Dónde has iniciado sesión», dentro de los ajustes de tu perfil."
      ),
    }),
    ar: (p) => ({
      subject: "تسجيل دخول جديد إلى حسابك في CreativesSelect",
      text: join(
        "ar",
        p.name,
        `سُجّل الدخول قبل قليل إلى حسابك في CreativesSelect من متصفح أو هاتف لم نره من قبل: ${p.device}، في ${p.when}.`,
        "إذا كنت أنت من فعل ذلك فلا تحتاج إلى أي إجراء.",
        "وإذا لم تكن أنت، فغيّر كلمة المرور فورًا (فذلك ينهي جلسات جميع الأجهزة الأخرى) وفعّل تسجيل الدخول بخطوتين، من إعدادات ملفك الشخصي في الحالتين.",
        "يمكنك إيقاف هذه الرسائل من «الأجهزة المسجَّل الدخول عليها» في إعدادات ملفك الشخصي."
      ),
    }),
  },
};

export const EMAIL_KINDS = Object.keys(KINDS);

/** { subject, text } for one kind of email, in the language of `user` (or of a language code), English if there is none. */
export function emailFor(kind, who, params) {
  const lang = typeof who === "string" ? (["en", "es", "ar"].includes(who) ? who : "en") : languageOf(who);
  return KINDS[kind][lang](params);
}
