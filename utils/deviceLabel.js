// A short, plain description of a browser for the person's own list of where they're signed in ("Chrome on Windows").
// Only a label from fixed lists is ever kept, never any of the browser's own text, so nothing a browser sends can end up
// on someone's page.
const BROWSERS = [
  [/EdgA?\/|Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/CrOS/, "Chromebook"],
  [/Linux|X11/, "Linux"],
];

export function deviceLabel(userAgent) {
  const ua = typeof userAgent === "string" ? userAgent.slice(0, 500) : "";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? (system ? `A browser on ${system}` : "A browser");
}
