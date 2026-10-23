/**
 * Birthday and gender belong to the account (users.birthday, users.gender):
 * that is what Profile, the API, MCP and Trace read for anyone signed in.
 *
 * The first-run setup asks for them too, and stores its answers as the 'dob'
 * and 'gender' settings (local mode has no account, and the calorie formula
 * reads them from there). Those answers never reached the account, so a
 * person who set up their server saw an empty Profile (#269). Here they are
 * copied onto the account, only where the account has none: a birthday or
 * gender already on the account is never replaced.
 */

// The choices Profile offers. Setup asks "male" or "female" (it picks the
// calorie formula), so the same answer is written the way Profile shows it.
export const GENDERS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];

/** A gender as Profile names it, any other value as it was, blank as null. */
export function normalizeGender(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  return GENDERS.find(g => g.toLowerCase() === v.toLowerCase()) || v;
}

const _DATE = /^\d{4}-\d{2}-\d{2}$/;

function _settingValue(raw) {
  if (raw == null) return null;
  let v = raw;
  try { v = JSON.parse(raw); } catch { /* stored bare */ }
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Fill an account's empty birthday and gender from its setup answers.
 * `userId` limits it to one account; without it, every account. Returns how
 * many accounts changed.
 */
export function fillProfileFromSetup(db, userId = null) {
  const rows = db.prepare(`
    SELECT u.id, u.birthday, u.gender,
      (SELECT value FROM user_settings s WHERE s.user_id = u.id AND s.key = 'dob' AND s.deleted_at IS NULL) AS dob,
      (SELECT value FROM user_settings s WHERE s.user_id = u.id AND s.key = 'gender' AND s.deleted_at IS NULL) AS sex
    FROM users u ${userId == null ? '' : 'WHERE u.id = ?'}
  `).all(...(userId == null ? [] : [userId]));
  const update = db.prepare('UPDATE users SET birthday = ?, gender = ? WHERE id = ?');
  let changed = 0;
  for (const u of rows) {
    const hasBirthday = typeof u.birthday === 'string' && u.birthday.trim();
    const hasGender = typeof u.gender === 'string' && u.gender.trim();
    const dob = _settingValue(u.dob);
    const birthday = hasBirthday ? u.birthday : (dob && _DATE.test(dob) ? dob : null);
    // An account's own value is kept as it is, only written the way Profile
    // names it ("female" from an older app becomes "Female").
    const gender = hasGender ? normalizeGender(u.gender) : normalizeGender(_settingValue(u.sex));
    if ((birthday || null) === (hasBirthday ? u.birthday : null) && (gender || null) === (hasGender ? u.gender : null)) continue;
    update.run(birthday || null, gender || null, u.id);
    changed++;
  }
  return changed;
}

/** After settings were written: if they were setup answers, fill the account. */
export function fillIfSetupAnswers(db, userId, keys) {
  if (userId == null) return 0;
  for (const k of keys) if (k === 'dob' || k === 'gender') return fillProfileFromSetup(db, userId);
  return 0;
}
