/**
 * Coaching: who coaches whom, and the one guard every coach endpoint uses.
 *
 * A coach (the Coach role, or an admin) asks; the client accepts or declines.
 * Accepting is the consent: before it, the coach sees nothing. Either side can
 * end it, and an admin can end any pairing. The role is read from the
 * database on every request, not from the sign-in token, so a role an admin
 * takes away stops working at once.
 *
 * Nothing here returns a full user row: people are { id, name } only.
 */
import db from '../db.js';
import { userMgmtActive } from '../middleware/auth.js';

/** What /api/auth/status reports, so an app can hide coaching on an older server. */
export const COACHING_VERSION = 1;
export const NOTE_MAX = 500;

export const canCoach = (role) => role === 'coach' || role === 'admin';

export function roleOf(userId) {
  if (userId == null) return null;
  return db.prepare('SELECT role FROM users WHERE id = ?').get(userId)?.role || null;
}

/** The name the sharing picker shows: full name, else username. */
export const personName = (u) => (u?.full_name || u?.username || '');
export const person = (id, full_name, username) => ({ id, name: personName({ full_name, username }) });

/**
 * The one guard: an active pairing between this coach and this client,
 * with the coach still allowed to coach. Null otherwise.
 */
export function activePairing(coachId, clientId) {
  if (coachId == null || clientId == null) return null;
  return db.prepare(`
    SELECT cc.* FROM coach_clients cc
      JOIN users c ON c.id = cc.coach_id
     WHERE cc.coach_id = ? AND cc.client_id = ? AND cc.status = 'active'
       AND c.role IN ('coach', 'admin')
  `).get(coachId, clientId) || null;
}

/** Signed in, with accounts on: coaching needs more than one person. */
function _signedIn(req, res) {
  if (!userMgmtActive() || !req.user?.id) {
    res.status(401).json({ error: 'Not authenticated', code: 'not_signed_in' });
    return false;
  }
  return true;
}

/** Middleware: the signed-in account may coach (Coach role or admin). */
export function requireCoachRole(req, res, next) {
  if (!_signedIn(req, res)) return;
  if (!canCoach(roleOf(req.user.id))) return res.status(403).json({ error: 'Only coaches can do this.', code: 'coaches_only' });
  next();
}

/** Middleware: the signed-in account is signed in with accounts on. */
export function requireAccount(req, res, next) {
  if (!_signedIn(req, res)) return;
  next();
}

/**
 * Middleware for every route under /clients/:clientId. Answers the same 404
 * for another coach's client, a pending request, an ended pairing and an
 * account that doesn't exist, so a coach learns nothing about other people.
 */
export function requireCoachOf(req, res, next) {
  if (!_signedIn(req, res)) return;
  if (!canCoach(roleOf(req.user.id))) return res.status(403).json({ error: 'Only coaches can do this.', code: 'coaches_only' });
  const clientId = Number(req.params.clientId);
  const pairing = Number.isInteger(clientId) ? activePairing(req.user.id, clientId) : null;
  if (!pairing) return res.status(404).json({ error: 'Client not found', code: 'client_not_found' });
  req.pairing = pairing;
  next();
}

/** Where this person stands in coaching, for their own screens. */
export function coachingState(userId) {
  const role = roleOf(userId);
  const rows = db.prepare(`
    SELECT cc.id, cc.status, cc.note, cc.requested_at, cc.responded_at,
           u.id AS coach_id, u.full_name, u.username
      FROM coach_clients cc JOIN users u ON u.id = cc.coach_id
     WHERE cc.client_id = ? AND cc.status IN ('pending', 'active')
     ORDER BY cc.requested_at DESC, cc.id DESC
  `).all(userId);
  const row = rows.find(r => r.status === 'active');
  const counts = { pending: 0, active: 0, recent: 0 };
  for (const r of db.prepare(`
    SELECT status, COUNT(*) AS c FROM coach_clients
     WHERE coach_id = ? AND status IN ('pending', 'active') GROUP BY status
  `).all(userId)) counts[r.status] = r.c;
  // Answers from the last week the coach's list still shows (a declined
  // request, a client who left), so an admin who coaches keeps the tab to see them.
  counts.recent = db.prepare(`
    SELECT COUNT(*) AS c FROM coach_clients
     WHERE coach_id = ?
       AND ((status = 'declined' AND responded_at >= datetime('now', '-7 days'))
         OR (status = 'ended' AND ended_by IS NOT coach_id AND ended_at >= datetime('now', '-7 days')))
  `).get(userId).c;
  // Messages the other person sent that this one hasn't read: per pairing.
  const unreadStmt = db.prepare(`SELECT COUNT(*) AS c FROM coach_messages WHERE pairing_id = ? AND sender_id != ? AND read_at IS NULL AND deleted_at IS NULL`);
  const unread = (pid) => unreadStmt.get(pid, userId).c;
  // Coaching that ended keeps its conversation for the client (not the coach).
  const past = db.prepare(`
    SELECT cc.id, cc.ended_at, cc.responded_at, u.id AS coach_id, u.full_name, u.username
      FROM coach_clients cc JOIN users u ON u.id = cc.coach_id
     WHERE cc.client_id = ? AND cc.status = 'ended'
       AND EXISTS (SELECT 1 FROM coach_messages m WHERE m.pairing_id = cc.id)
     ORDER BY cc.ended_at DESC
  `).all(userId).map(r => ({ id: r.id, coach: person(r.coach_id, r.full_name, r.username), ended_at: r.ended_at, unread: unread(r.id) }));
  const coachActive = canCoach(role)
    ? db.prepare(`SELECT id FROM coach_clients WHERE coach_id = ? AND status = 'active' ORDER BY id`).all(userId).map(r => r.id)
    : [];
  counts.active_ids = coachActive;
  counts.unread = coachActive.reduce((n, id) => n + unread(id), 0);
  const asClientUnread = row ? unread(row.id) : 0;
  const requests = rows.filter(r => r.status === 'pending');
  // Recommendations waiting for this person's answer (from their coach).
  // `awaiting` (the dot) leaves day plans out: one past its date is Expired,
  // and only the person's device knows their date, so the app counts those
  // itself. `recommendations` counts them all, so an answer anywhere shows.
  const pendingRecs = db.prepare(`
    SELECT COUNT(*) AS c FROM coach_recommendations r JOIN coach_clients cc ON cc.id = r.pairing_id
     WHERE r.client_id = ? AND r.status = 'pending' AND cc.status = 'active' AND r.deleted_at IS NULL
  `).get(userId).c;
  const pendingNotPlans = db.prepare(`
    SELECT COUNT(*) AS c FROM coach_recommendations r JOIN coach_clients cc ON cc.id = r.pairing_id
     WHERE r.client_id = ? AND r.status = 'pending' AND cc.status = 'active' AND r.deleted_at IS NULL AND r.kind != 'day_plan'
  `).get(userId).c;
  return {
    role,
    can_coach: canCoach(role),
    // The coach, once accepted.
    as_client: row ? {
      id: row.id,
      status: row.status,
      coach: person(row.coach_id, row.full_name, row.username),
      note: row.note || null,
      requested_at: row.requested_at,
      responded_at: row.responded_at || null,
      unread: asClientUnread,
    } : null,
    // Requests waiting for this person's answer, newest first.
    requests: requests.map(r => ({
      id: r.id,
      coach: person(r.coach_id, r.full_name, r.username),
      note: r.note || null,
      requested_at: r.requested_at,
    })),
    // Ended coaching whose conversation the client can still read.
    past,
    as_coach: counts,
    // For the dot on Goals: unread messages, and things waiting for this
    // person's answer (requests now; recommendations later).
    unread: asClientUnread + past.reduce((n, x) => n + x.unread, 0) + counts.unread,
    awaiting: requests.length + pendingNotPlans,
    recommendations: pendingRecs,
    // The newest recommendation made to this person: a replacement keeps the
    // count the same, so this is what tells the app to look again.
    latest_recommendation: db.prepare(`SELECT MAX(id) AS m FROM coach_recommendations WHERE client_id = ?`).get(userId).m || 0,
  };
}

/**
 * A short fingerprint of coachingState, sent as a header on the settings
 * refresh the app already makes, so a new request or an ended pairing shows
 * up without an extra request or timer for people not in coaching.
 */
export function coachingSignature(userId) {
  const s = coachingState(userId);
  const c = s.as_client ? String(s.as_client.id) : '-';
  const r = s.requests.map(x => x.id).join(',') || '-';
  const p = s.past.map(x => x.id).join(',') || '-';
  return `${s.role || '-'};${c};${r};${s.as_coach.pending}.${s.as_coach.active};${p};${s.unread};${s.awaiting};${s.latest_recommendation}`;
}

/** End a pairing (pending or active). What the coach recommended and the
 *  client hasn't answered is withdrawn. Returns true when one was ended. */
export function endPairing(pairingId, byUserId) {
  const r = db.prepare(`
    UPDATE coach_clients
       SET status = 'ended', ended_at = datetime('now'), ended_by = ?, updated_at = datetime('now')
     WHERE id = ? AND status IN ('pending', 'active')
  `).run(byUserId ?? null, pairingId);
  if (r.changes > 0) {
    db.prepare(`UPDATE coach_recommendations SET status = 'withdrawn', updated_at = datetime('now') WHERE pairing_id = ? AND status = 'pending'`).run(pairingId);
  }
  return r.changes > 0;
}

/**
 * Someone who can no longer coach (their role changed to User) stops
 * coaching: their pending requests and active pairings end.
 */
export function endCoachingIfNotCoach(userId, byUserId) {
  if (canCoach(roleOf(userId))) return 0;
  const rows = db.prepare(`SELECT id FROM coach_clients WHERE coach_id = ? AND status IN ('pending', 'active')`).all(userId);
  for (const r of rows) endPairing(r.id, byUserId);
  return rows.length;
}

/** A pending request the invite named, made when the invited account is created. */
export function requestFromInvite(coachId, clientId) {
  if (coachId == null || coachId === clientId || !canCoach(roleOf(coachId))) return null;
  try {
    return db.prepare(`INSERT INTO coach_clients (coach_id, client_id, status) VALUES (?, ?, 'pending')`)
      .run(coachId, clientId).lastInsertRowid;
  } catch { return null; }
}
