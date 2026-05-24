import { Router } from 'express';
import { requireAuth, userMgmtActive } from '../middleware/auth.js';
import { wrap } from '../logger.js';
import { getAiConfig } from '../ai.js';
import { makeRateLimiter } from '../middleware/rate-limit.js';
import db from '../db.js';

const router = Router();
const aiChatLimit = makeRateLimiter({ max: 30, windowMs: 60_000, label: 'ai' });

const uid = req => userMgmtActive() ? req.user.id : null;
const MAX_HISTORY = 200; // rows kept per user

// ── GET /api/ai/history ───────────────────────────────────────────────────────
router.get('/history', requireAuth, wrap((req, res) => {
  const u = uid(req);
  const rows = u == null
    ? db.prepare(`SELECT role, content, created_at FROM ai_chat_history WHERE user_id IS NULL ORDER BY created_at ASC LIMIT 100`).all()
    : db.prepare(`SELECT role, content, created_at FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC LIMIT 100`).all(u);
  res.json(rows);
}));

// ── POST /api/ai/history ──────────────────────────────────────────────────────
// Dedup guard: if the most recent row for this user is identical (same role
// and content) and was written within the last 3s, skip the insert. Prevents
// duplicate rows from network retries, the tool-use loop emitting twice, or
// two devices racing to record the same message — which previously poisoned
// the chat list with rows the Svelte 5 each-key collision check would throw
// on (#40). 3s is loose enough to absorb client retries; tighter than the
// human typing cadence so two genuine consecutive messages still go through.
router.post('/history', requireAuth, wrap((req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: 'role and content required' });
  const u = uid(req);

  const recentSql = u == null
    ? `SELECT role, content FROM ai_chat_history WHERE user_id IS NULL AND created_at >= datetime('now', '-3 seconds') ORDER BY created_at DESC LIMIT 1`
    : `SELECT role, content FROM ai_chat_history WHERE user_id = ? AND created_at >= datetime('now', '-3 seconds') ORDER BY created_at DESC LIMIT 1`;
  const recent = u == null ? db.prepare(recentSql).get() : db.prepare(recentSql).get(u);
  if (recent && recent.role === role && recent.content === content) {
    return res.json({ ok: true, deduped: true });
  }

  if (u == null) {
    db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (NULL, ?, ?)`).run(role, content);
    // Trim oldest beyond MAX_HISTORY
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id IS NULL AND id NOT IN (SELECT id FROM ai_chat_history WHERE user_id IS NULL ORDER BY created_at DESC LIMIT ?)`).run(MAX_HISTORY);
  } else {
    db.prepare(`INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, ?, ?)`).run(u, role, content);
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id = ? AND id NOT IN (SELECT id FROM ai_chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`).run(u, u, MAX_HISTORY);
  }
  res.json({ ok: true });
}));

// ── DELETE /api/ai/history ────────────────────────────────────────────────────
router.delete('/history', requireAuth, wrap((req, res) => {
  const u = uid(req);
  if (u == null) {
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id IS NULL`).run();
  } else {
    db.prepare(`DELETE FROM ai_chat_history WHERE user_id = ?`).run(u);
  }
  res.json({ ok: true });
}));

const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

// Models Google has shut down (404) or scheduled for shutdown.
// Saved env-locked configs pointing at any of these are remapped to the
// current default so the proxy doesn't 404 against a dead endpoint.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

/**
 * POST /api/ai/chat
 * Server-side proxy for AI calls — used when AI config is env-locked.
 * The API key never leaves the server; clients send only messages + systemPrompt.
 */
// Payload caps to bound a misbehaving client (or compromised account) from
// burning through the admin's AI API budget with one giant request.
const AI_MAX_MESSAGES   = 60;
const AI_MAX_BYTES      = 200_000; // ~200 KB combined messages + system prompt

router.post('/chat', requireAuth, aiChatLimit, wrap(async (req, res) => {
  const { messages, systemPrompt } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  if (messages.length > AI_MAX_MESSAGES) {
    return res.status(413).json({ error: `Too many messages (max ${AI_MAX_MESSAGES})` });
  }
  const payloadBytes = JSON.stringify(messages).length + (typeof systemPrompt === 'string' ? systemPrompt.length : 0);
  if (payloadBytes > AI_MAX_BYTES) {
    return res.status(413).json({ error: `Payload too large (${payloadBytes} bytes; max ${AI_MAX_BYTES})` });
  }

  const cfg = getAiConfig();
  if (!cfg.ai_api_key) return res.status(503).json({ error: 'AI not configured on server. Set AI_API_KEY in environment.' });

  const provider = cfg.ai_provider || 'claude';
  const model    = cfg.ai_model    || AI_DEFAULT_MODELS[provider] || '';
  const apiKey   = cfg.ai_api_key;

  let text;
  switch (provider) {
    case 'claude':  text = await _callClaude(apiKey, model, messages, systemPrompt); break;
    case 'openai':  text = await _callOpenAI(apiKey, model, messages, systemPrompt); break;
    case 'gemini':  text = await _callGemini(apiKey, model, messages, systemPrompt); break;
    default: return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }
  res.json({ text });
}));

export default router;

// ── Provider implementations (server-side) ────────────────────────────────────

async function _callClaude(apiKey, model, messages, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
  return data.content[0].text;
}

async function _callOpenAI(apiKey, model, messages, systemPrompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI API error ${res.status}`);
  return data.choices[0].message.content;
}

async function _callGemini(apiKey, model, messages, systemPrompt) {
  const m = GEMINI_RETIRED.has(model) ? AI_DEFAULT_MODELS.gemini : (model || AI_DEFAULT_MODELS.gemini);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: msg.content }],
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
  return data.candidates[0].content.parts[0].text;
}
