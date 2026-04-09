import nodemailer from 'nodemailer';
import db from './db.js';

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

function emailWrapper(origin, bodyHtml, footerNote) {
  const logoUrl = `${origin}/icons/logo.png`;
  const year    = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <style>
    /* Light mode overrides — supported by Apple Mail, Outlook macOS, Fastmail, etc. */
    @media (prefers-color-scheme: light) {
      .nt-body     { background-color:#F4F6FA !important; }
      .nt-outer    { background-color:#F4F6FA !important; }
      .nt-header   { background-color:#EDF7F2 !important; border-color:#C8E6D6 !important; }
      .nt-stripe   { background:#00C47A !important; }
      .nt-card     { background-color:#FFFFFF !important; border-color:#DDE3EE !important; }
      .nt-footer   { background-color:#F0F2F7 !important; border-color:#DDE3EE !important; }
      .nt-title    { color:#0A1A0E !important; }
      .nt-body-txt { color:#4B5563 !important; }
      .nt-copy-cr  { color:#9CA3AF !important; }
      .nt-fb-url   { color:#00A85E !important; }
      .nt-expiry   { color:#6B7280 !important; }
      .nt-expiry strong { color:#374151 !important; }
    }
  </style>
</head>
<body class="nt-body" style="margin:0;padding:0;background-color:#0A0B0F;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="nt-outer" style="background-color:#0A0B0F;">
  <tr>
    <td align="center" style="padding:48px 16px 40px;">

      <!-- Card -->
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="520" style="max-width:520px;width:100%;">

        <!-- Header -->
        <tr>
          <td class="nt-header" align="center" style="background-color:#0D1610;padding:36px 40px 30px;border-radius:16px 16px 0 0;border:1px solid #163324;border-bottom:none;">
            <img src="${logoUrl}" alt="NutriTrace" width="60" height="60"
              style="display:block;margin:0 auto 18px;border-radius:14px;" />
            <div class="nt-title" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;color:#FFFFFF;letter-spacing:-0.4px;line-height:1;">
              NutriTrace
            </div>
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;font-weight:600;color:#00C47A;letter-spacing:0.22em;text-transform:uppercase;margin-top:8px;">
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
          <td class="nt-card" style="background-color:#111318;padding:36px 40px;border-left:1px solid #1E2330;border-right:1px solid #1E2330;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
            ${bodyHtml}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td class="nt-footer" style="background-color:#0D0F14;padding:22px 40px 28px;border-radius:0 0 16px 16px;border:1px solid #1A1F2E;border-top:1px solid #252D3D;">
            ${footerNote ? `<p style="margin:0 0 10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#4A5268;text-align:center;line-height:1.6;">${footerNote}</p>` : ''}
            <p class="nt-copy-cr" style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:11px;color:#323850;text-align:center;">
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

function ctaButton(href, label) {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td align="center" style="border-radius:10px;background-color:#00C47A;">
          <a href="${href}"
            style="display:inline-block;padding:14px 36px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;letter-spacing:0.01em;">
            ${label}
          </a>
        </td>
      </tr>
    </table>`;
}

function fallbackUrl(url) {
  return `<p class="nt-expiry" style="margin:24px 0 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#4A5268;text-align:center;line-height:1.6;">
    Button not working? Copy this link into your browser:<br/>
    <a class="nt-fb-url" href="${url}" style="color:#00C47A;word-break:break-all;font-size:11px;">${url}</a>
  </p>`;
}

// ── Templates ──────────────────────────────────────────────────────────────

export async function sendPasswordReset(email, resetUrl) {
  const origin = new URL(resetUrl).origin;
  const body = `
    <p class="nt-title" style="margin:0 0 10px;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      Password reset requested
    </p>
    <p class="nt-body-txt" style="margin:0 0 28px;font-size:15px;color:#8A93A8;line-height:1.7;">
      We received a request to reset the password for your NutriTrace account.
      Click the button below to choose a new password.
    </p>
    ${ctaButton(resetUrl, 'Reset My Password')}
    <p class="nt-expiry" style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      ⏱ This link expires in <strong style="color:#8A93A8;">1 hour</strong>.
      If you didn&rsquo;t request this, you can safely ignore this email.
    </p>
    ${fallbackUrl(resetUrl)}`;

  await sendMail({
    to: email,
    subject: 'Reset your NutriTrace password',
    html: emailWrapper(origin, body, null),
    text: `Reset your NutriTrace password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
  });
}

export async function sendInvite(email, inviteUrl, inviterName) {
  const origin  = new URL(inviteUrl).origin;
  const sender  = inviterName
    ? `<strong style="color:#FFFFFF;">${inviterName}</strong> has invited you to join`
    : `You&rsquo;ve been invited to join`;

  const body = `
    <p class="nt-title" style="margin:0 0 6px;font-size:22px;font-weight:700;color:#FFFFFF;line-height:1.3;">
      You&rsquo;re invited! &nbsp;🎉
    </p>
    <p class="nt-body-txt" style="margin:0 0 16px;font-size:15px;color:#8A93A8;line-height:1.7;">
      ${sender} <strong style="color:#FFFFFF;">NutriTrace</strong> &mdash; a personal nutrition
      tracker built for privacy, where your data lives on your own server and nowhere else.
    </p>
    <p class="nt-body-txt" style="margin:0 0 32px;font-size:15px;color:#8A93A8;line-height:1.7;">
      Log meals, hit your macro goals, track your progress, and visualize everything
      &mdash; beautifully and privately.
    </p>
    ${ctaButton(inviteUrl, 'Accept Invitation &rarr;')}
    <p class="nt-expiry" style="margin:24px 0 0;font-size:13px;color:#5A6278;text-align:center;line-height:1.6;">
      ⏱ This invitation expires in <strong style="color:#8A93A8;">7 days</strong>.
    </p>
    ${fallbackUrl(inviteUrl)}`;

  await sendMail({
    to: email,
    subject: `You've been invited to NutriTrace`,
    html: emailWrapper(origin, body, null),
    text: `${inviterName ? inviterName + ' has invited you' : "You've been invited"} to join NutriTrace.\n\nAccept your invitation:\n${inviteUrl}\n\nThis invite expires in 7 days.`,
  });
}
