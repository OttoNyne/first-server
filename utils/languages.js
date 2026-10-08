// The languages the site speaks. The page decides which one a person sees; the server only remembers it so what it sends on its own
// (emails) can be in the same language.
export const LANGUAGES = ["en", "es", "ar"];

export const isLanguage = (value) => LANGUAGES.includes(value);

/** The language stored for a person, English when there is none (an older account, or a missing field). */
export const languageOf = (user) => (isLanguage(user?.language) ? user.language : "en");
