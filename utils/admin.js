// Who is an administrator. Set ADMIN_EMAILS on the server to a comma-separated list of the email addresses of the people who may
// moderate. Being listed is not enough on its own: the address must also be CONFIRMED on that account, so nobody can gain access by
// signing up with someone else's address (they could not open the confirmation link).

export function adminEmails() {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminUser(user) {
  return Boolean(user && user.emailVerified && user.email && adminEmails().includes(String(user.email).toLowerCase()));
}
