#!/usr/bin/env node
/**
 * scripts/mcp-smoke.mjs — end-to-end MCP smoke test.
 *
 * Usage:
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN>
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> --writes
 *   node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> --writes --destroy
 *
 * Reads-only mode:  token must hold `mcp:read` (default).
 * Writes mode:      add `--writes`; token must ALSO hold `mcp:write`
 *                   and MCP_WRITE_ENABLED=1 on the server. Tests
 *                   additive logs (250 ml water, weight snapshot) —
 *                   safe against real accounts, undoable in the UI.
 * Destroy mode:     add `--destroy`; token must ALSO hold `mcp:destroy`
 *                   and MCP_DESTROY_ENABLED=1. Tests confirm=false
 *                   rejection paths only, so no real data is mutated
 *                   by the smoke script itself.
 *
 * Prints one line per check with PASS / FAIL. Exits non-zero if any
 * check failed. Negative-path checks (401 / 403) are required — if they
 * pass, auth or origin gating is broken.
 */

const argv = process.argv.slice(2);
const WRITE_MODE   = argv.includes('--writes');
const DESTROY_MODE = argv.includes('--destroy');
const positional = argv.filter(a => !a.startsWith('--'));
const [BASE, TOKEN] = positional;
if (!BASE || !TOKEN) {
  console.error('usage: node scripts/mcp-smoke.mjs <BASE_URL> <MCP_TOKEN> [--writes] [--destroy]');
  process.exit(2);
}

const URL_ = BASE.replace(/\/+$/, '') + '/api/mcp';
const HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

let pass = 0;
let fail = 0;
let id = 0;

function line(status, label, detail = '') {
  const tag = status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
            : status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m'
            : '\x1b[33mSKIP\x1b[0m';
  console.log(`  ${tag}  ${label}${detail ? '  ' + detail : ''}`);
  if (status === 'PASS') pass++;
  else if (status === 'FAIL') fail++;
}

async function mcp(method, params) {
  const body = { jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) };
  const r = await fetch(URL_, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  // Streamable HTTP replies can be application/json OR text/event-stream.
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    // Take the last `data:` frame; SDK typically emits one for stateless.
    const lines = text.split('\n').filter(l => l.startsWith('data:'));
    const last = lines[lines.length - 1] || '';
    try { json = JSON.parse(last.slice(5).trim()); } catch { /* keep null */ }
  } else {
    try { json = JSON.parse(text); } catch { /* keep null */ }
  }
  return { status: r.status, json, raw: text };
}

async function callTool(name, args = {}) {
  return mcp('tools/call', { name, arguments: args });
}

console.log(`\n\x1b[1mMCP smoke test\x1b[0m  ${URL_}\n`);

// --- Handshake ---
{
  const r = await mcp('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'nt-smoke', version: '1' },
  });
  const info = r.json?.result?.serverInfo;
  if (r.status === 200 && info?.name === 'nutritrace') {
    line('PASS', `initialize`, `serverInfo=${info.name}@${info.version}`);
  } else {
    line('FAIL', `initialize`, `status=${r.status} body=${r.raw.slice(0, 200)}`);
  }
}

// --- tools/list ---
const READ_TOOLS = [
  'get_goals',
  'list_diary_entries',
  'get_daily_totals',
  'search_foods',
  'get_recent_foods',
];
const WRITE_TOOLS = [
  'log_food',
  'log_water',
  'log_meal',
  'log_body_stat',
];
const DESTROY_TOOLS = [
  'delete_diary_entry',
  'edit_diary_entry',
  'create_food',
];
const expected = new Set([
  ...READ_TOOLS,
  ...(WRITE_MODE   ? WRITE_TOOLS   : []),
  ...(DESTROY_MODE ? DESTROY_TOOLS : []),
]);
const EXPECTED_TOOLS = expected;
{
  const r = await mcp('tools/list');
  const tools = r.json?.result?.tools || [];
  const names = new Set(tools.map(t => t.name));
  const missing = [...EXPECTED_TOOLS].filter(n => !names.has(n));
  const leaked = [];
  if (!WRITE_MODE)   leaked.push(...WRITE_TOOLS.filter(n => names.has(n)));
  if (!DESTROY_MODE) leaked.push(...DESTROY_TOOLS.filter(n => names.has(n)));
  if (r.status === 200 && missing.length === 0 && leaked.length === 0) {
    line('PASS', `tools/list`, `${tools.length} tools`);
  } else {
    const notes = [];
    if (missing.length) notes.push(`missing=[${missing.join(',')}]`);
    if (leaked.length)  notes.push(`gated tools leaked: [${leaked.join(',')}]`);
    line('FAIL', `tools/list`, `status=${r.status} ${notes.join(' ')}`);
  }
}

// --- Each tool ---
async function checkTool(name, args, resultKey, note) {
  const r = await callTool(name, args);
  const sc = r.json?.result?.structuredContent;
  if (r.status === 200 && sc && (resultKey ? resultKey in sc : true)) {
    const preview = resultKey ? JSON.stringify(sc[resultKey]).slice(0, 80) : '';
    line('PASS', name, note ? `${note} ${preview}` : preview);
  } else if (r.status === 200 && r.json?.result?.isError) {
    line('FAIL', name, `tool returned isError: ${r.json.result.content?.[0]?.text}`);
  } else {
    line('FAIL', name, `status=${r.status} body=${r.raw.slice(0, 200)}`);
  }
}

await checkTool('get_goals',           {},                       'goals');
await checkTool('get_daily_totals',    {},                       'totals',    '(today)');
await checkTool('list_diary_entries',  {},                       'items',     '(today)');
await checkTool('search_foods',        { query: 'a', limit: 3 }, 'items',     '(q=a)');
await checkTool('get_recent_foods',    { limit: 3 },             'items');

// --- Write tools (opt-in with --writes) ---
if (WRITE_MODE) {
  // log_water: safe, additive, verifiable.
  await checkTool('log_water', { amount_ml: 250 }, 'total_ml_on_day', '(+250 ml)');
  // log_body_stat: additive, merges — logs a weight snapshot.
  await checkTool('log_body_stat', { stats: { weight: 75.0 } }, 'current_stats', '(weight=75)');
  // log_food / log_meal require real ids from the user's catalog, so
  // just check that the tools exist and reject a bogus id cleanly.
  {
    const r = await callTool('log_food', { food_id: 999999999 });
    const err = r.json?.result?.isError;
    if (err) line('PASS', 'log_food (bogus id → clean tool error)');
    else     line('FAIL', 'log_food (bogus id)', `did not return isError`);
  }
  {
    const r = await callTool('log_meal', { meal_id: 999999999 });
    const err = r.json?.result?.isError;
    if (err) line('PASS', 'log_meal (bogus id → clean tool error)');
    else     line('FAIL', 'log_meal (bogus id)', `did not return isError`);
  }
}

// --- Destructive tools (opt-in with --destroy) ---
// These check the gate/reject paths ONLY — no actual data is mutated
// by the smoke script, because deletes/edits need a live entry_index
// that varies per user and would need a live-log-then-delete flow.
if (DESTROY_MODE) {
  // Every destructive tool must refuse without confirm=true.
  {
    const r = await callTool('delete_diary_entry', { entry_index: 0 });
    const err = r.json?.result?.isError;
    const msg = r.json?.result?.content?.[0]?.text || '';
    if (err && /confirm/i.test(msg)) line('PASS', 'delete_diary_entry (no confirm → refused)');
    else                             line('FAIL', 'delete_diary_entry (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
  }
  {
    const r = await callTool('edit_diary_entry', { entry_index: 0, patch: { quantity: 2 } });
    const err = r.json?.result?.isError;
    const msg = r.json?.result?.content?.[0]?.text || '';
    if (err && /confirm/i.test(msg)) line('PASS', 'edit_diary_entry (no confirm → refused)');
    else                             line('FAIL', 'edit_diary_entry (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
  }
  {
    const r = await callTool('create_food', {
      name: 'smoke-test-food-should-not-persist',
      portion: 100, unit: 'g', nutrition: { calories: 100 },
    });
    const err = r.json?.result?.isError;
    const msg = r.json?.result?.content?.[0]?.text || '';
    if (err && /confirm/i.test(msg)) line('PASS', 'create_food (no confirm → refused)');
    else                             line('FAIL', 'create_food (no confirm)', `err=${err} msg=${msg.slice(0, 60)}`);
  }
}

// --- Negative: no bearer → 401 ---
{
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
  });
  if (r.status === 401) line('PASS', 'no-bearer → 401');
  else                  line('FAIL', 'no-bearer → 401', `got ${r.status}`);
}

// --- Negative: disallowed origin → 403 ---
{
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { ...HEADERS, origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 998, method: 'tools/list' }),
  });
  if (r.status === 403) line('PASS', 'bad-origin → 403');
  else                  line('FAIL', 'bad-origin → 403', `got ${r.status}`);
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
