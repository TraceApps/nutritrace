/**
 * file-stamp.js: "YYYY-MM-DDTHH-MM-SS" in this device's own time, for the
 * names of backups made on the device (TraceApps/notetrace#44). The server
 * names its backups in the schedule's zone (server/lib/backup-schedule.js).
 */
export function localFileStamp(date = new Date()) {
  const d = new Date(date);
  const two = (n) => String(n).padStart(2, '0');
  // With the offset from UTC, as the server's names have (backup-schedule.js).
  const off = -d.getTimezoneOffset(), a = Math.abs(off);
  const suffix = `${off < 0 ? '-' : '+'}${two(Math.floor(a / 60))}${two(a % 60)}`;
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}${suffix}`;
}
