import { logger } from '../logger.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const REDACTED_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|client[_-]?secret|recovery|credential)/i;
const DEFAULT_TRACE_BODY_MAX_BYTES = 32 * 1024;

function byteCount(value) {
  return Buffer.byteLength(value, 'utf8');
}

function redactedBody(value, seen = new WeakSet()) {
  if (typeof value === 'string' && value.startsWith('data:')) {
    return `[data URL: ${byteCount(value)} bytes]`;
  }
  if (value == null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map(item => redactedBody(item, seen));

  const settingCarriesSecret = typeof value.key === 'string' && REDACTED_KEY.test(value.key);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (REDACTED_KEY.test(key)) return [key, '[REDACTED]'];
    if (settingCarriesSecret && key === 'value') return [key, '[REDACTED]'];
    return [key, redactedBody(item, seen)];
  }));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatTraceBody(body, maxBytes = DEFAULT_TRACE_BODY_MAX_BYTES) {
  let json;
  try {
    json = JSON.stringify(redactedBody(body));
  } catch (err) {
    return `[unserializable body: ${err.message}]`;
  }
  if (byteCount(json) <= maxBytes) return json;

  const suffix = `… [truncated; serialized body ${formatBytes(byteCount(json))}]`;
  return Buffer.from(json).subarray(0, Math.max(0, maxBytes - byteCount(suffix))).toString('utf8') + suffix;
}

export function requestLogPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

function traceBodyLimit() {
  const configured = Number.parseInt(process.env.TRACE_BODY_MAX_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TRACE_BODY_MAX_BYTES;
}

/**
 * Register before body parsers so rejected requests are still measured/logged.
 * The data listener observes the same chunks as body-parser; it does not retain
 * them, which keeps the body-size protection effective.
 */
export function requestLogging(req, res, next) {
  const startedAt = Date.now();
  const method = req.method;
  // Exclude query strings: OAuth callbacks and other endpoints can carry
  // authorization codes/tokens in the URL.
  const requestPath = requestLogPath(req);
  const declaredBytes = Number.parseInt(req.get('content-length') || '', 10);
  let receivedBytes = 0;

  req.on('data', chunk => { receivedBytes += chunk.length; });

  res.on('finish', () => {
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const measuredBytes = receivedBytes || (Number.isFinite(declaredBytes) ? declaredBytes : 0);
    const size = BODY_METHODS.has(method) ? `, body ${formatBytes(measuredBytes)}` : '';
    logger[level](`${method} ${requestPath} → ${status} (${Date.now() - startedAt}ms${size})`);

    if (BODY_METHODS.has(method) && req.body !== undefined) {
      logger.trace(`${method} ${requestPath} body: ${formatTraceBody(req.body, traceBodyLimit())}`);
    }
  });

  next();
}
