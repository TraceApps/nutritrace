import crypto from 'node:crypto';

import { logger } from '../logger.js';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REDACTED_KEY = /(authorization|cookie|password|passwd|secret|token|api[_-]?key|recovery|credential|session|csrf)/i;
const DEFAULT_TRACE_BODY_MAX_BYTES = 32 * 1024;
const DEFAULT_TRACE_PATHS = ['/api/diary', '/api/sync/push'];
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const TRACE_LIMITS = {
  maxDepth: 10,
  maxNodes: 2000,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxStringBytes: 2048,
  maxTotalStringBytes: 64 * 1024,
};
const DIAGNOSTICS = Symbol('requestDiagnostics');

function byteCount(value) {
  return Buffer.byteLength(value, 'utf8');
}

function truncateUtf8(value, maxBytes) {
  if (byteCount(value) <= maxBytes) return value;
  const suffix = '[truncated]';
  if (maxBytes <= byteCount(suffix)) return suffix.slice(0, maxBytes);
  let end = maxBytes - byteCount(suffix);
  let output = Buffer.from(value).subarray(0, end).toString('utf8');
  while (end > 0 && output.endsWith('\uFFFD')) {
    output = Buffer.from(value).subarray(0, --end).toString('utf8');
  }
  return output + suffix;
}

function summarizeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `[URL: ${parsed.protocol}//${parsed.host}]`;
    }
    return `[URL: ${parsed.protocol.replace(/:$/, '')}]`;
  } catch {
    return '[URL REDACTED]';
  }
}

function boundedRedactedBody(value, state, keyName = '', depth = 0) {
  if (state.nodes >= TRACE_LIMITS.maxNodes) return '[truncated: node budget]';
  state.nodes += 1;

  if (typeof value === 'string') {
    if (/^data:/i.test(value)) return `[data URL: ${byteCount(value)} bytes]`;
    if (REDACTED_KEY.test(keyName)) return '[REDACTED]';
    if (URL_RE.test(value)) return summarizeUrl(value);
    const remaining = TRACE_LIMITS.maxTotalStringBytes - state.stringBytes;
    if (remaining <= 0) return '[truncated: string budget]';
    const output = truncateUtf8(value, Math.min(TRACE_LIMITS.maxStringBytes, remaining));
    state.stringBytes += byteCount(output);
    return output;
  }
  if (value == null || typeof value !== 'object') return value;
  if (depth >= TRACE_LIMITS.maxDepth) return '[truncated: depth budget]';
  if (state.seen.has(value)) return '[Circular]';
  state.seen.add(value);

  if (Array.isArray(value)) {
    const count = Math.min(value.length, TRACE_LIMITS.maxArrayItems);
    const output = [];
    for (let i = 0; i < count; i += 1) {
      output.push(boundedRedactedBody(value[i], state, keyName, depth + 1));
      if (state.nodes >= TRACE_LIMITS.maxNodes) break;
    }
    if (value.length > count) output.push(`[${value.length - count} more items]`);
    return output;
  }

  const output = {};
  const settingObject = typeof value.key === 'string'
    && Object.prototype.hasOwnProperty.call(value, 'value');
  let keyCount = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (keyCount >= TRACE_LIMITS.maxObjectKeys || state.nodes >= TRACE_LIMITS.maxNodes) {
      output['[truncated]'] = 'additional properties omitted';
      break;
    }
    keyCount += 1;
    if (REDACTED_KEY.test(key) || (settingObject && key === 'value')) {
      output[key] = '[REDACTED]';
    } else {
      output[key] = boundedRedactedBody(value[key], state, key, depth + 1);
    }
  }
  return output;
}

function formatBoundedJson(value, maxBytes) {
  let json;
  try {
    json = JSON.stringify(boundedRedactedBody(value, { nodes: 0, stringBytes: 0, seen: new WeakSet() }));
  } catch (err) {
    return `[unserializable body: ${err.message}]`;
  }
  if (json === undefined) return '[undefined]';
  if (byteCount(json) <= maxBytes) return json;

  const suffix = `... [truncated; bounded body ${formatBytes(byteCount(json))}]`;
  if (maxBytes <= byteCount(suffix)) return '[truncated]'.slice(0, maxBytes);
  let end = maxBytes - byteCount(suffix);
  let prefix = Buffer.from(json).subarray(0, end).toString('utf8');
  while (end > 0 && prefix.endsWith('\uFFFD')) {
    prefix = Buffer.from(json).subarray(0, --end).toString('utf8');
  }
  return prefix + suffix;
}

function parseBoolean(value, name) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '' || ['0', 'false', 'no', 'off'].includes(normalized)) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  throw new Error(`${name} must be one of: 1, 0, true, false, yes, no, on, off`);
}

export function parseTraceBodyLimit(value = process.env.TRACE_BODY_MAX_BYTES) {
  if (value === undefined || String(value).trim() === '') return DEFAULT_TRACE_BODY_MAX_BYTES;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) <= 0 || !Number.isSafeInteger(Number(normalized))) {
    throw new Error('TRACE_BODY_MAX_BYTES must be a positive integer number of bytes');
  }
  return Number(normalized);
}

export function parseTracePaths(value = process.env.TRACE_REQUEST_PATHS) {
  if (value === undefined) return [...DEFAULT_TRACE_PATHS];
  const normalized = String(value).trim();
  if (normalized === '' || normalized.toLowerCase() === 'none') return [];
  const paths = normalized.split(',').map(path => path.trim()).filter(Boolean);
  for (const path of paths) {
    if (path !== '*' && !path.startsWith('/')) {
      throw new Error(`TRACE_REQUEST_PATHS entry must start with '/': ${path}`);
    }
  }
  return paths;
}

export function validateRequestLoggingConfig() {
  parseBoolean(process.env.TRACE_REQUEST_BODIES, 'TRACE_REQUEST_BODIES');
  parseTraceBodyLimit();
  parseTracePaths();
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function formatTraceBody(body, maxBytes = DEFAULT_TRACE_BODY_MAX_BYTES) {
  return formatBoundedJson(body, maxBytes);
}

export function requestLogPath(req) {
  return `${req.baseUrl || ''}${req.path || ''}` || '/';
}

function isApiPath(path) {
  return path === '/api' || path.startsWith('/api/');
}

function requestId(req) {
  const supplied = req.get('x-request-id');
  return supplied && REQUEST_ID_RE.test(supplied) ? supplied : crypto.randomUUID();
}

function declaredBodyBytes(req) {
  const value = req.get('content-length');
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function diagnostic(req) {
  return req[DIAGNOSTICS] || null;
}

export function shouldTraceRequestBody(req) {
  if (!logger.isEnabled('trace')
      || !parseBoolean(process.env.TRACE_REQUEST_BODIES, 'TRACE_REQUEST_BODIES')) return false;
  if (!BODY_METHODS.has(req.method) || req.body === undefined) return false;

  const path = req.path || '/';
  return parseTracePaths().some(allowed => allowed === '*'
    || path === allowed
    || path.startsWith(`${allowed.replace(/\/$/, '')}/`));
}

export function formatTraceRequestBody(req, maxBytes = parseTraceBodyLimit()) {
  return formatBoundedJson(req.body, maxBytes);
}

export function captureRequestTraceBody(req, res, next) {
  const details = diagnostic(req);
  if (details && shouldTraceRequestBody(req)) {
    details.traceBody = formatTraceRequestBody(req);
  }
  next();
}

export function recordParserBodyError(req, err) {
  const details = diagnostic(req);
  if (!details) return;
  details.parserBytesReceived = Number.isFinite(err?.received) ? err.received : null;
  details.limitBytes = Number.isFinite(err?.limit) ? err.limit : null;
}

export function requestBodySizeDetails(req) {
  const details = diagnostic(req);
  if (!details) {
    return { declaredBytes: null, wireBytesReceived: 0, parserBytesReceived: null, limitBytes: null };
  }
  return {
    declaredBytes: details.declaredBytes,
    wireBytesReceived: details.wireBytesReceived,
    parserBytesReceived: details.parserBytesReceived,
    limitBytes: details.limitBytes,
  };
}

/**
 * Observes an API request from arrival through response completion without
 * retaining its body. Register this before body parsers so parser failures and
 * interrupted uploads are included in request diagnostics.
 */
export function requestLogging(req, res, next) {
  if (!isApiPath(req.path || '/')) return next();

  const details = {
    id: requestId(req),
    method: req.method,
    path: requestLogPath(req),
    startedAt: Date.now(),
    declaredBytes: declaredBodyBytes(req),
    wireBytesReceived: 0,
    parserBytesReceived: null,
    limitBytes: null,
    traceBody: null,
    finalized: false,
  };
  req[DIAGNOSTICS] = details;
  req.requestId = details.id;
  res.setHeader('X-Request-ID', details.id);

  req.on('data', chunk => { details.wireBytesReceived += chunk.length; });

  const finalize = outcome => {
    if (details.finalized) return;
    details.finalized = true;
    const completed = outcome === 'finished';
    const status = completed || res.headersSent ? res.statusCode : null;
    const level = !completed || status >= 400 ? 'warn' : 'info';
    const fields = [
      `request_id=${details.id}`,
      `outcome=${outcome}`,
      `duration_ms=${Date.now() - details.startedAt}`,
      `wire_bytes_received=${details.wireBytesReceived}`,
    ];
    if (details.declaredBytes !== null) fields.push(`declared_bytes=${details.declaredBytes}`);
    if (details.parserBytesReceived !== null) fields.push(`parser_bytes_received=${details.parserBytesReceived}`);
    if (details.limitBytes !== null) fields.push(`limit_bytes=${details.limitBytes}`);
    logger[level](`${details.method} ${details.path} → ${status ?? 'incomplete'} (${fields.join(', ')})`);

    if (details.traceBody) {
      logger.trace(`request_id=${details.id} ${details.method} ${details.path} body: ${details.traceBody}`);
    }
  };

  req.once('aborted', () => finalize('aborted'));
  res.once('finish', () => finalize('finished'));
  res.once('close', () => {
    if (!res.writableFinished) finalize('closed');
  });

  next();
}
