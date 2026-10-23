// Who may reach the server's own network when a feature fetches an
// address a user chose. The same file in all four Trace apps.
//
// Features made for services on the home network (push, Mealie, CookTrace,
// NutriTrace, Navidrome) allow it for everyone and don't ask here.
// Features made for the public web ask ownerOrOptIn(): an admin may; other
// accounts only when the owner sets that feature's ALLOW_PRIVATE_* variable.
// A single-user install has no sign-in, so every visitor would count as
// the owner; there only the variable opens it.
import { userMgmtActive } from '../middleware/auth.js';

export function envOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

export function ownerOrOptIn(req, envVar) {
  return (userMgmtActive() && req?.user?.role === 'admin') || envOn(process.env[envVar]);
}
