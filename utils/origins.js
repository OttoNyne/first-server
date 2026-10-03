// CLIENT_URL names the website(s) allowed to call this API. It can hold more than one
// address, separated by commas, so the site can be reached on two addresses at once (for example
// its own domain and the original *.vercel.app one). The first is the "primary" address, the one
// used when the server has to build a link to the site itself (such as in a password-reset email).
//
//   CLIENT_URL=https://www.example.com,https://my-app.vercel.app
export function clientOrigins() {
  const raw = process.env.CLIENT_URL || "http://localhost:3000";
  const list = raw
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return list.length ? list : ["http://localhost:3000"];
}

export const primaryClientUrl = () => clientOrigins()[0];

// Origins are compared exactly (scheme, host and port): "https://example.com" does not
// match "https://www.example.com" or "http://example.com".
export const isAllowedOrigin = (origin) => clientOrigins().includes(origin);
