// How a person can style their own profile. Everything is a choice from a fixed list (or a plain colour), checked here: there is no free
// text and no custom CSS, so a profile can be made to look very different without anyone being able to hide things on it, cover the page,
// or load anything from elsewhere.

export const FONTS = [
  "system-ui, sans-serif",
  "Georgia, serif",
  "'Courier New', monospace",
  "'Trebuchet MS', sans-serif",
  "Verdana, Geneva, sans-serif",
  "'Palatino Linotype', Palatino, 'Book Antiqua', serif",
  "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif",
  "'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', cursive",
  "Impact, 'Arial Narrow Bold', sans-serif",
  "'Lucida Console', Monaco, monospace",
];

export const STYLE_CHOICES = {
  cardStyle: ["solid", "outline", "glass", "flat"],
  corners: ["square", "rounded", "soft"],
  density: ["compact", "comfortable", "roomy"],
  headings: ["caps", "plain", "serif"],
  avatarShape: ["circle", "rounded", "square"],
  width: ["narrow", "standard", "wide"],
  // an older setting that no longer does anything; still accepted so a profile saved with it can be saved again
  layoutStyle: ["grid", "stacked"],
};
export const COLOR_KEYS = ["bgColor", "textColor", "accentColor"];
export const THEME_KEYS = [...COLOR_KEYS, "fontFamily", ...Object.keys(STYLE_CHOICES)];

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A change to a profile's theme, from a request: { value } with each key either a checked value or null (take that setting away, back to
 * the default), or { error }. Only the keys sent are in it.
 */
export function checkTheme(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "theme must be an object" };
  const value = {};
  for (const [key, setting] of Object.entries(input)) {
    if (!THEME_KEYS.includes(key)) return { error: `Unknown theme setting: ${key.slice(0, 30)}` };
    if (setting === null || setting === "") {
      value[key] = null;
    } else if (COLOR_KEYS.includes(key)) {
      if (typeof setting !== "string" || !HEX.test(setting)) return { error: `${key} must be a colour like #1a2b3c` };
      value[key] = setting.toLowerCase();
    } else if (key === "fontFamily") {
      if (typeof setting !== "string" || !FONTS.includes(setting)) return { error: "That font isn't one of the choices" };
      value[key] = setting;
    } else {
      if (typeof setting !== "string" || !STYLE_CHOICES[key].includes(setting)) return { error: `${key} must be one of: ${STYLE_CHOICES[key].join(", ")}` };
      value[key] = setting;
    }
  }
  return { value };
}

/** The theme as it is after a change: the old settings with the new ones put in and the ones set to null taken out. */
export function applyThemeChange(current, change) {
  const next = { ...(current ?? {}) };
  for (const [key, setting] of Object.entries(change)) {
    if (setting === null) delete next[key];
    else next[key] = setting;
  }
  return next;
}
