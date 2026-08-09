import { logger } from '../logger.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REDACTED_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|recovery|credential|session|csrf)/i;
const DEFAULT_TRACE_BODY_MAX_BYTES = 32 * 1024;
const DEFAULT_TRACE_PATHS = ['/api/diary', '/api/sync/push'];

function byteCount(value) {
  return Buffer.byteLength(value, 'utf8');
}

function envEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function redactedBody(value, seen = new WeakSet()) {
  if (typeof value === 'string' && /^data:/i.test(value)) {
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

function traceBodyLimit() {
  const configured = Number.parseInt(process.env.TRACE_BODY_MAX_BYTES || '', 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TRACE_BODY_MAX_BYTES;
}

function tracePaths() {
  const configured = process.env.TRACE_REQUEST_PATHS;
  if (configured === undefined || configured.trim() === '') return DEFAULT_TRACE_PATHS;
  return configured.split(',').map(path => path.trim()).filter(Boolean);
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
  if (json === undefined) return '[undefined]';
  if (byteCount(json) <= maxBytes) return json;

  const suffix = `... [truncated; serialized body ${formatBytes(byteCount(json))}]`;
  if (maxBytes <= byteCount(suffix)) return '[truncated]'.slice(0, maxBytes);
  let end = Math.max(0, maxBytes - byteCount(suffix));
  let prefix = Buffer.from(json).subarray(0, end).toString('utf8');
  while (end > 0 && prefix.endsWith('\uFFFD')) {
    prefix = Buffer.from(json).subarray(0, --end).toString('utf8');
  }
  return prefix + suffix;
}

export function requestLogPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

export function shouldTraceRequestBody(req) {
  if (!logger.isEnabled('trace') || !envEnabled(process.env.TRACE_REQUEST_BODIES)) return false;
  if (!BODY_METHODS.has(req.method) || req.body === undefined) return false;

  const path = req.path || '/';
  return tracePaths().some(allowed => allowed === '*'
    || path === allowed
    || path.startsWith(`${allowed.replace(/\/$/, '')}/`));
}

/**
 * Register before body parsers so rejected requests are still measured. The
 * data listener observes chunks without retaining them, preserving parser
 * limits while making oversized-request diagnostics useful.
 */
export function requestLogging(req, res, next) {
  const startedAt = Date.now();
  const method = req.method;
  const requestPath = requestLogPath(req); // Deliberately excludes query strings.
  const declaredBytes = Number.parseInt(req.get('content-length') || '', 10);
  let receivedBytes = 0;

  req.on('data', chunk => { receivedBytes += chunk.length; });

  res.on('finish', () => {
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const measuredBytes = receivedBytes || (Number.isFinite(declaredBytes) ? declaredBytes : 0);
    const size = BODY_METHODS.has(method) ? `, body ${formatBytes(measuredBytes)}` : '';
    logger[level](`${method} ${requestPath} → ${status} (${Date.now() - startedAt}ms${size})`);

    if (shouldTraceRequestBody(req)) {
      logger.trace(`${method} ${requestPath} body: ${formatTraceBody(req.body, traceBodyLimit())}`);
    }
  });

  next();
}
