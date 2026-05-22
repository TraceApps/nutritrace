import nodemailer from 'nodemailer';
import db from './db.js';
import { logger } from './logger.js';

/** Seed app_config from env vars at startup (env vars take priority) */
export function seedSmtpFromEnv() {
  const map = {
    SMTP_HOST:   'smtp_host',
    SMTP_PORT:   'smtp_port',
    SMTP_SECURE: 'smtp_secure',
    SMTP_USER:   'smtp_user',
    SMTP_PASS:   'smtp_pass',
    SMTP_FROM:   'smtp_from',
  };
  const upsert = db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  let locked = false;
  for (const [envKey, dbKey] of Object.entries(map)) {
    if (process.env[envKey] != null) {
      upsert.run(dbKey, process.env[envKey]);
      locked = true;
    }
  }
  // Store lock flag so clients can disable the UI fields
  if (locked) upsert.run('smtp_env_locked', 'true');
}

export function isSmtpEnvLocked() {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('smtp_env_locked');
  return row?.value === 'true';
}

/** Read SMTP config from app_config table (env vars already seeded at startup) */
function getSmtpConfig() {
  const rows = db.prepare('SELECT key, value FROM app_config WHERE key LIKE ?').all('smtp_%');
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = value;
  return cfg;
}

/** Build a nodemailer transporter from stored config, or throw if not configured */
function createTransport() {
  const cfg = getSmtpConfig();
  if (!cfg.smtp_host) throw new Error('Email not configured. Ask your admin to set up SMTP in Settings.');
  return nodemailer.createTransport({
    host:   cfg.smtp_host,
    port:   parseInt(cfg.smtp_port || '587'),
    secure: cfg.smtp_secure === 'true',
    auth:   cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass || '' } : undefined,
  });
}

export async function sendMail({ to, subject, html, text }) {
  const cfg = getSmtpConfig();
  const from = cfg.smtp_from || cfg.smtp_user || 'NutriTrace <noreply@nutritrace.app>';
  const transport = createTransport();
  await transport.sendMail({ from, to, subject, html, text });
}

export async function testSmtp() {
  const transport = createTransport();
  await transport.verify();
}

export function isEmailConfigured() {
  const cfg = getSmtpConfig();
  return !!cfg.smtp_host;
}

// ── Email templates ────────────────────────────────────────────────────────

// ── Shared template helpers ────────────────────────────────────────────────

const _FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;

function emailWrapper(origin, bodyHtml, footerNote, preheaderText) {
  const logoUrl = `${origin}/icons/logo-email.png`;
  const year    = new Date().getFullYear();
  const preheader = preheaderText
    ? `<div style="display:none;font-size:1px;color:#0A0B0F;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheaderText}</div>`
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <style>
    @media (prefers-color-scheme: light) {
      .nt-body     { background-color:#F4F6FA !important; }
      .nt-outer    { background-color:#F4F6FA !important; }
      .nt-header   { background-color:#EDF7F2 !important; border-color:#C8E6D6 !important; }
      .nt-stripe   { background:#00C47A !important; }
      .nt-card     { background-color:#FFFFFF !important; border-color:#DDE3EE !important; }
      .nt-footer   { background-color:#F0F2F7 !important; border-color:#DDE3EE !important; }
      .nt-heading  { color:#0A1A0E !important; }
      .nt-body-txt { color:#4B5563 !important; }
      .nt-muted    { color:#9CA3AF !important; }
      .nt-fb-url   { color:#00A85E !important; }
      .nt-expiry   { color:#6B7280 !important; }
      .nt-expiry strong { color:#374151 !important; }
      .nt-section  { color:#059669 !important; }
      .nt-stat-lbl { color:#4B5563 !important; }
      .nt-stat-val { color:#111827 !important; }
      .nt-stat-div { border-color:#E5E7EB !important; }
    }
  </style>
</head>
<body class="nt-body" style="margin:0;padding:0;background-color:#0A0B0F;">
${preheader}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="nt-outer" style="background-color:#0A0B0F;">
  <tr>
    <td align="center" style="padding:48px 16px 40px;">

      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="520" style="max-width:520px;width:100%;">

        <!-- Header -->
        <tr>
          <td class="nt-header" align="center" style="background-color:#0D1610;padding:36px 40px 30px;border-radius:16px 16px 0 0;border:1px solid #163324;border-bottom:none;">
            <img src="${logoUrl}" alt="NutriTrace" width="60" height="60"
              style="display:block;margin:0 auto 18px;border-radius:14px;" />
            <div style="font-family:${_FONT};font-size:26px;font-weight:700;color:#FFFFFF;letter-spacing:-0.4px;line-height:1;">
              NutriTrace
            </div>
            <div style="font-family:${_FONT};font-size:11px;font-weight:600;color:#00C47A;letter-spacing:0.22em;text-transform:uppercase;margin-top:8px;">
              Trace Every Bite
            </div>
          </td>
        </tr>

        <!-- Accent stripe -->
        <tr>
          <td class="nt-stripe" style="background:linear-gradient(90deg,#0D1610,#00C47A 40%,#00C47A 60%,#0D1610);height:2px;border-left:1px solid #163324;border-right:1px solid #163324;"></td>
        </tr>

        <!-- Body -->
        <tr>
          <td class="nt-card" style="background-color:#111318;padding:36px 40px;border-left:1px solid #1E2330;border-right:1px solid #1E2330;font-family:${_FONT};">
            ${bodyHtml}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td class="nt-footer" style="background-color:#0D0F14;padding:22px 40px 28px;border-radius:0 0 16px 16px;border:1px solid #1A1F2E;border-top:1px solid #252D3D;">
            ${footerNote ? `<p class="nt-muted" style="margin:0 0 10px;font-family:${_FONT};font-size:12px;color:#4A5268;text-align:center;line-height:1.6;">${footerNote}</p>` : ''}
            <p class="nt-muted" style="margin:0;font-family:${_FONT};font-size:11px;color:#323850;text-align:center;">
              &copy; ${year} NutriTrace &nbsp;&middot;&nbsp; Self-hosted &nbsp;&middot;&nbsp; Your data, your rules
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function greeting(name) {
  return `<p class="nt-body-txt" style="margin:0 0 20px;font-size:15px;color:#8A93A8;line-height:1.7;">
    Hi${name ? ' <strong style="color:#FFFFFF;">' + name + '</strong>' : ''},
  </p>`;
}

function ctaButton(href, label) {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td align="center" style="border-radius:10px;background-color:#00C47A;">
          <a href="${href}"
            style="display:inline-block;padding:14px 36px;font-family:${_FONT};font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;letter-spacing:0.01em;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

function fallbackUrl(url) {
  return `<p class="nt-expiry" style="margin:24px 0 0;font-family:${_FONT};font-size:12px;color:#4A5268;text-align:center;line-height:1.6;">
    Button not working? Copy this link into your browser:<br/>
    <a class="nt-fb-url" href="${url}" style="color:#00C47A;word-break:break-all;font-size:11px;">${url}</a>
  </p>`;
}

// ── Templates ──────────────────────────────────────────────────────────────

export async function sendPasswordReset(email, resetUrl) {
  const origin = new URL(resetUrl).origin;
  const body = `
    ${greeting(null)}
    <p class="nt-heading" style="margin:0 0 10px;font-size:20px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      Password Reset Requested
    </p>
    <p class="nt-body-txt" style="margin:0 0 28px;font-size:15px;color:#8A93A8;line-height:1.7;">
      We received a request to reset the password for your NutriTrace account.
      Click the button below to choose a new password.
    </p>
    ${ctaButton(resetUrl, 'Reset My Password')}
    <p class="nt-expiry" style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      This link expires in <strong style="color:#8A93A8;">1 hour</strong>.
      If you didn&rsquo;t request this, you can safely ignore this email.
    </p>
    ${fallbackUrl(resetUrl)}`;

  await sendMail({
    to: email,
    subject: 'Reset your NutriTrace password',
    html: emailWrapper(origin, body, null, 'Reset your NutriTrace password — this link expires in 1 hour.'),
    text: `Reset your NutriTrace password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
}

export async function sendInvite(email, inviteUrl, inviterName) {
  const origin  = new URL(inviteUrl).origin;
  const sender  = inviterName
    ? `<strong style="color:#FFFFFF;">${inviterName}</strong> has invited you to join`
    : `You&rsquo;ve been invited to join`;

  const body = `
    ${greeting(null)}
    <p class="nt-heading" style="margin:0 0 10px;font-size:20px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      You&rsquo;re Invited
    </p>
    <p class="nt-body-txt" style="margin:0 0 16px;font-size:15px;color:#8A93A8;line-height:1.7;">
      ${sender} <strong style="color:#FFFFFF;">NutriTrace</strong> &mdash; a personal nutrition
      tracker built for privacy, where your data lives on your own server and nowhere else.
    </p>
    <p class="nt-body-txt" style="margin:0 0 32px;font-size:15px;color:#8A93A8;line-height:1.7;">
      Log meals, hit your macro goals, track your progress, and visualize everything
      &mdash; beautifully and privately.
    </p>
    ${ctaButton(inviteUrl, 'Accept Invitation')}
    <p class="nt-expiry" style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      This invitation expires in <strong style="color:#8A93A8;">7 days</strong>.
    </p>
    ${fallbackUrl(inviteUrl)}`;

  await sendMail({
    to: email,
    subject: `You've been invited to NutriTrace`,
    html: emailWrapper(origin, body, null, `${inviterName || 'Someone'} invited you to NutriTrace — accept within 7 days.`),
    text: `${inviterName ? inviterName + ' has invited you' : "You've been invited"} to join NutriTrace.\n\nAccept your invitation:\n${inviteUrl}\n\nThis invite expires in 7 days.`,
  });
}

// ── Weekly Summary Email ───────────────────────────────────────────────────

function _statRow(label, value, unit = '') {
  if (value == null) return '';
  return `
    <tr>
      <td class="nt-stat-lbl nt-stat-div" style="padding:8px 0;font-family:${_FONT};font-size:14px;color:#8A93A8;border-bottom:1px solid #1E2330;">${label}</td>
      <td class="nt-stat-val nt-stat-div" style="padding:8px 0;font-family:${_FONT};font-size:14px;font-weight:600;color:#FFFFFF;text-align:right;border-bottom:1px solid #1E2330;">${value}${unit ? ' <span style="font-weight:400;color:#5A6278;">' + unit + '</span>' : ''}</td>
    </tr>`;
}

function _sectionHeader(label) {
  return `<p class="nt-section" style="margin:24px 0 8px;font-family:${_FONT};font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#00C47A;">${label}</p>`;
}

export async function sendWeeklySummaryEmail(userId, origin) {
  try {
    // Get user's email
    const user = db.prepare('SELECT email, full_name, username FROM users WHERE id = ?').get(userId);
    if (!user?.email) return;

    const toEmail  = user.email;
    const name     = user.full_name || user.username || 'there';

    // Date range: last 7 days
    const toDate   = new Date();
    const fromDate = new Date(toDate); fromDate.setDate(toDate.getDate() - 6);
    const fromStr  = fromDate.toISOString().slice(0, 10);
    const toStr    = toDate.toISOString().slice(0, 10);

    // ── Nutrition averages from diary ─────────────────────────────────────
    const diaryRows = db.prepare(
      `SELECT data FROM diary WHERE user_id=? AND date >= ? AND date <= ? AND deleted_at IS NULL`
    ).all(userId, fromStr, toStr);

    let totalCal = 0, totalProt = 0, totalCarb = 0, totalFat = 0, totalWater = 0;
    let daysLogged = 0, goalsHitCount = 0, daysWithGoal = 0;

    // Get user's calorie goal
    const goalRow = db.prepare(`SELECT value FROM user_settings WHERE user_id=? AND key='goals'`).get(userId);
    let calGoal = null;
    try {
      const g = JSON.parse(goalRow?.value || '{}');
      calGoal = g.calories?.max ?? g.calories?.min ?? null;
    } catch {}

    // Energy unit preference (display only; storage stays kcal)
    const euRow = db.prepare(`SELECT value FROM user_settings WHERE user_id=? AND key='energyUnit'`).get(userId);
    let energyUnit = 'kcal';
    try { energyUnit = JSON.parse(euRow?.value || '"kcal"') || 'kcal'; } catch {}
    const _isKj = energyUnit === 'kJ';
    const _eUnit = _isKj ? 'kJ' : 'kcal';
    const _toE = (kcal) => kcal == null ? null : (_isKj ? Math.round(kcal * 4.184) : Math.round(kcal));

    for (const row of diaryRows) {
      try {
        const entry = JSON.parse(row.data);
        if (!entry.items?.length) continue;
        daysLogged++;
        let dayCal = 0, dayProt = 0, dayCarb = 0, dayFat = 0;
        for (const item of entry.items) {
          const n = item.nutrition || {};
          const q = item.quantity || 1;
          dayCal  += (n.calories       || 0) * q;
          dayProt += (n.proteins       || 0) * q;
          dayCarb += (n.carbohydrates  || 0) * q;
          dayFat  += (n.fat            || 0) * q;
        }
        totalCal  += dayCal;
        totalProt += dayProt;
        totalCarb += dayCarb;
        totalFat  += dayFat;
        totalWater += (entry.water || []).reduce((s, l) => s + (l.amount || 0), 0);
        if (calGoal != null) {
          daysWithGoal++;
          if (dayCal >= calGoal * 0.85 && dayCal <= calGoal * 1.15) goalsHitCount++;
        }
      } catch {}
    }

    const avgCal   = daysLogged > 0 ? Math.round(totalCal / daysLogged)  : null;
    const avgProt  = daysLogged > 0 ? Math.round(totalProt / daysLogged) : null;
    const avgCarb  = daysLogged > 0 ? Math.round(totalCarb / daysLogged) : null;
    const avgFat   = daysLogged > 0 ? Math.round(totalFat / daysLogged)  : null;
    const avgWaterL = daysLogged > 0 ? (totalWater / daysLogged / 1000).toFixed(1) : null;
    const goalHitPct = daysWithGoal > 0 ? Math.round(goalsHitCount / daysWithGoal * 100) : null;

    // ── Wellness averages (fitbit + garmin merged) ────────────────────────
    const wRows = db.prepare(
      `SELECT metric_type, AVG(value) as avg FROM wellness_data
       WHERE user_id=? AND date >= ? AND date <= ?
       AND metric_type IN ('steps','calories_out','sleep_duration_min','resting_hr','readiness_score','stress_score')
       GROUP BY metric_type`
    ).all(userId, fromStr, toStr);
    const w = {};
    for (const r of wRows) w[r.metric_type] = r.avg;

    // ── Weight change ────────────────────────────────────────────────────
    const weightRows = db.prepare(
      `SELECT date, value FROM wellness_data
       WHERE user_id=? AND metric_type='weight_kg' AND date >= ? AND date <= ?
       ORDER BY date ASC`
    ).all(userId, fromStr, toStr);
    // Also check diary body stats for weight
    let firstWeight = null, lastWeight = null;
    for (const row of diaryRows) {
      try {
        const entry = JSON.parse(row.data);
        const w = entry.body_stats?.weight ?? entry.bodyStats?.weight ?? null;
        if (w != null) { if (firstWeight == null) firstWeight = w; lastWeight = w; }
      } catch {}
    }
    if (weightRows.length >= 2) {
      firstWeight = weightRows[0].value;
      lastWeight  = weightRows[weightRows.length - 1].value;
    }
    const weightDiff = (firstWeight != null && lastWeight != null) ? lastWeight - firstWeight : null;

    // ── Build email ───────────────────────────────────────────────────────
    const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const fmtDate = (d) => `${DAYS[d.getDay()]} ${d.toLocaleDateString('en-US', { month:'short', day:'numeric' })}`;
    const weekRange = `${fmtDate(fromDate)} – ${fmtDate(toDate)}`;

    const _dispAvgCal = _toE(avgCal);
    const _dispDiff = (avgCal != null && calGoal != null) ? _toE(avgCal - calGoal) : null;
    const _dispDiffSigned = _dispDiff != null ? `${_dispDiff >= 0 ? '+' : ''}${_dispDiff}` : null;
    const nutritionSection = daysLogged > 0 ? `
      ${_sectionHeader(`Nutrition (${daysLogged}/7 days logged)`)}
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${_statRow(_isKj ? 'Avg Daily Energy' : 'Avg Daily Calories', _dispAvgCal, _eUnit)}
        ${_dispDiffSigned != null ? _statRow('vs Goal', _dispDiffSigned, _eUnit) : ''}
        ${goalHitPct != null ? _statRow('Goal Hit Rate', goalHitPct, '%') : ''}
        ${_statRow('Avg Protein', avgProt, 'g')}
        ${_statRow('Avg Carbs', avgCarb, 'g')}
        ${_statRow('Avg Fat', avgFat, 'g')}
        ${_statRow('Avg Water', avgWaterL, 'L')}
      </table>` : '';

    const avgSteps = w.steps ? Math.round(w.steps).toLocaleString() : null;
    const avgSleep = w.sleep_duration_min ? (() => { const h = Math.floor(w.sleep_duration_min/60); return `${h}h ${Math.round(w.sleep_duration_min%60)}m`; })() : null;
    const wellnessSection = (avgSteps || avgSleep || w.resting_hr || w.readiness_score) ? `
      ${_sectionHeader('Activity & Wellness')}
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${_statRow('Avg Daily Steps', avgSteps)}
        ${w.calories_out ? _statRow(_isKj ? 'Avg Energy Burned' : 'Avg Calories Burned', _toE(w.calories_out), _eUnit) : ''}
        ${_statRow('Avg Sleep', avgSleep)}
        ${w.resting_hr ? _statRow('Avg Resting HR', Math.round(w.resting_hr), 'bpm') : ''}
        ${w.readiness_score ? _statRow('Avg Readiness', Math.round(w.readiness_score), '/ 100') : ''}
        ${w.stress_score ? _statRow('Avg Stress Mgmt', Math.round(w.stress_score), '/ 100') : ''}
      </table>` : '';

    const weightSection = (weightDiff != null) ? `
      ${_sectionHeader('Weight')}
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
        ${_statRow('Change this week', `${weightDiff >= 0 ? '+' : ''}${weightDiff.toFixed(1)}`, 'kg')}
      </table>` : '';

    if (!nutritionSection && !wellnessSection) {
      logger.debug(`[email] weekly summary skipped for user ${userId} — no data`);
      return;
    }

    const body = `
      ${greeting(name)}
      <p class="nt-heading" style="margin:0 0 4px;font-size:20px;font-weight:700;color:#FFFFFF;line-height:1.3;">
        Your Weekly Summary
      </p>
      <p class="nt-body-txt" style="margin:0 0 24px;font-size:14px;color:#5A6278;">${weekRange}</p>
      ${nutritionSection}
      ${wellnessSection}
      ${weightSection}`;

    await sendMail({
      to: toEmail,
      subject: `NutriTrace Weekly Summary — ${weekRange}`,
      html: emailWrapper(origin, body, 'To stop receiving these emails, turn off Weekly Summary in Settings &rarr; Notifications.', `Your NutriTrace week: ${_dispAvgCal != null ? _dispAvgCal + ' avg ' + _eUnit : ''}${avgSteps ? ', ' + avgSteps + ' avg steps' : ''}`),
      text: `Weekly Summary (${weekRange})\n\n` +
        (_dispAvgCal != null ? `Avg ${_isKj ? 'energy' : 'calories'}: ${_dispAvgCal} ${_eUnit}\n` : '') +
        (avgProt  ? `Avg protein: ${avgProt}g\n` : '') +
        (avgSteps ? `Avg steps: ${avgSteps}\n` : '') +
        (avgSleep ? `Avg sleep: ${avgSleep}\n` : '') +
        (goalHitPct != null ? `Goal hit rate: ${goalHitPct}%\n` : '') +
        (weightDiff != null ? `Weight change: ${weightDiff >= 0 ? '+' : ''}${weightDiff.toFixed(1)} kg\n` : ''),
    });

    logger.info(`[email] weekly summary sent to user ${userId} (${toEmail})`);
  } catch (e) {
    logger.warn(`[email] weekly summary failed for user ${userId}: ${e.message}`);
  }
}
