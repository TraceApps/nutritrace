/**
 * Sends one weekly summary email from the real server code, at a fixed
 * moment, to a stand-in SMTP server, and prints what arrived as JSON.
 * Used by scripts/week-start.test.js (#232).
 *
 * Env: DB_PATH (a fresh file), NOW (ISO instant), FIRST_DAY (a setting
 * value, or empty for one never saved), USER_TZ (the timezone setting,
 * or empty).
 */
import { createServer } from 'node:net';

const FIXED = Date.parse(process.env.NOW);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length === 0) super(FIXED); else super(...a); }
  static now() { return FIXED; }
};

const mails = [];
const smtp = await new Promise((res) => {
  const s = createServer((sock) => {
    let data = false, buf = '', msg = '';
    sock.write('220 stub\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; mails.push(msg); msg = ''; sock.write('250 ok\r\n'); } else msg += line + '\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 stub\r\n');
        else if (cmd === 'DATA') { data = true; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
  });
  s.listen(0, '127.0.0.1', () => res(s));
});

const { default: db } = await import('../../server/db.js');
const cfg = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
cfg.run('smtp_host', '127.0.0.1');
cfg.run('smtp_port', String(smtp.address().port));
cfg.run('smtp_secure', 'false');
cfg.run('smtp_from', 'nt@example.com');
const uid = db.prepare(`INSERT INTO users (username, password_hash, email) VALUES ('wk', 'x', 'wk@example.com')`).run().lastInsertRowid;
const set = db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)');
if (process.env.FIRST_DAY) set.run(uid, 'firstDayOfWeek', JSON.stringify(process.env.FIRST_DAY));
if (process.env.USER_TZ) set.run(uid, 'timezone', JSON.stringify(process.env.USER_TZ));

// 28 days around NOW, each eaten day worth its day of the month x 100
// kcal, so the average names the days the summary read.
const day = new RealDate(FIXED);
day.setUTCDate(day.getUTCDate() - 21);
const diary = db.prepare('INSERT INTO diary (user_id, date, items) VALUES (?, ?, ?)');
for (let i = 0; i < 28; i++) {
  const iso = day.toISOString().slice(0, 10);
  const kcal = Number(iso.slice(8)) * 100;
  diary.run(uid, iso, JSON.stringify([{ name: 'Day', quantity: 1, nutrition: { calories: kcal } }]));
  day.setUTCDate(day.getUTCDate() + 1);
}

const { sendWeeklySummaryEmail } = await import('../../server/email.js');
await sendWeeklySummaryEmail(uid, 'http://localhost');
smtp.close();
const raw = mails[0] || '';
const head = raw.split('\n\n')[0].replace(/\n[ \t]+/g, ' ');
const encoded = ((/^Subject: (.*)$/m.exec(head) || [])[1] || '').replace(/\?=\s+=\?UTF-8\?Q\?/gi, '');
const subject = encoded.replace(/=\?UTF-8\?Q\?(.*?)\?=/gi, (_, q) => Buffer.from(q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'));
const body = raw.replace(/=\r?\n/g, '');
const avg = (/Avg calories: (\d+)/.exec(body) || [])[1];
process.stdout.write(JSON.stringify({ sent: mails.length, subject, avg: avg ? Number(avg) : null }));
process.exit(0);
