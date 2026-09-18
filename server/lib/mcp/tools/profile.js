/**
 * MCP tool: get_profile
 *
 * Returns the user's gender and date of birth so agents can personalize
 * coaching math (TDEE, pace tables, RDA context) without guessing.
 *
 * Two storage locations exist by design: users.birthday / users.gender
 * are written by the Profile page (and admin user management), while
 * the onboarding Wizard stores the same facts as 'dob' / 'gender'
 * user_settings rows via the settings sync. The users columns are the
 * canonical source and win when both are present; user_settings is the
 * fallback for users who only completed the Wizard. Tombstoned
 * user_settings rows (deleted_at IS NOT NULL) are ignored, same as
 * get_goals.
 */
import db from '../../../db.js';
import { safeJson, toolResult } from '../_util.js';

/** Read one user_settings key, ignoring tombstoned rows. Settings sync
 *  stores JSON.stringify(value), so a JSON string with quotes is the
 *  normal shape; a bare string is accepted as a legacy fallback. */
function _setting(userId, key) {
  const row = db.prepare(
    `SELECT value FROM user_settings
      WHERE user_id = ? AND key = ? AND deleted_at IS NULL`
  ).get(userId, key);
  if (row?.value == null) return null;
  const parsed = safeJson(row.value, row.value);
  return typeof parsed === 'string' && parsed.trim() ? parsed.trim() : null;
}

/**
 * Core lookup, shared by the MCP tool below and the public REST API at
 * GET /api/v1/profile. Either field is null when the user never set it.
 */
export function getProfileCore(userId) {
  const user = db.prepare(
    'SELECT birthday, gender FROM users WHERE id = ?'
  ).get(userId);
  const birthday = typeof user?.birthday === 'string' && user.birthday.trim()
    ? user.birthday.trim() : null;
  const gender = typeof user?.gender === 'string' && user.gender.trim()
    ? user.gender.trim() : null;
  return {
    gender:   gender   || _setting(userId, 'gender'),
    birthday: birthday || _setting(userId, 'dob'),
  };
}

export function registerGetProfile(server, { userId }) {
  server.registerTool(
    'get_profile',
    {
      title: 'Get Profile',
      description:
        "Return the user's gender and date of birth, as set on the " +
        'Profile page or during onboarding. Either field is null when ' +
        'the user never set it.',
      inputSchema: {},
    },
    async () => toolResult(getProfileCore(userId))
  );
}
