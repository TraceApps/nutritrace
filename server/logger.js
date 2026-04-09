/**
 * Simple structured logger — outputs to stdout/stderr with timestamps.
 * Set LOG_LEVEL env var to 'error' | 'warn' | 'info' | 'debug' (default: info)
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function log(level, ...args) {
  if (LEVELS[level] > LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const line = [`[${ts}] [${level.toUpperCase().padEnd(5)}]`, ...args];
  if (level === 'error') console.error(...line);
  else console.log(...line);
}

export const logger = {
  error: (...a) => log('error', ...a),
  warn:  (...a) => log('warn',  ...a),
  info:  (...a) => log('info',  ...a),
  debug: (...a) => log('debug', ...a),
};

/** Wraps an async Express route handler so thrown errors reach the error middleware. */
export const wrap = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
