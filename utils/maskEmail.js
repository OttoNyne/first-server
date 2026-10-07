// "zoe@example.com" -> "z**@e******.com": enough for the owner to recognise an address, not enough for anyone else to learn it.
// Used where an address is mentioned to someone who didn't type it (the notice to the old address about a requested change).
export function maskEmail(email) {
  const [local = "", domain = ""] = String(email).toLowerCase().split("@");
  const stars = (s) => "*".repeat(Math.max(1, s.length - 1));
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}${stars(local)}@${host.slice(0, 1)}${stars(host)}${tld}`;
}
