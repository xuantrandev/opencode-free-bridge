#!/usr/bin/env node
// OpenAI-compatible reverse proxy for:
//   1) opencode serve free models  (upstream: OPENCODE_SERVE, /session API)
//   2) opencode-go models          (upstream: OPENCODE_GO_BASE /v1, API key)
// Listens on 127.0.0.1:5577. NO auth, NO external exposure.

import http from 'node:http';
import fs from 'node:fs';

const UPSTREAM = process.env.OPENCODE_UPSTREAM || 'http://127.0.0.1:4577';
const PORT = parseInt(process.env.PORT || '5577', 10);
const HOST = '127.0.0.1';
const AGENT = 'general';
const SYSTEM_DEFAULT = 'You are a helpful assistant.';

const OPENCODE_GO_BASE = (process.env.OPENCODE_GO_BASE || 'https://opencode.ai/zen/go/v1').replace(/\/$/, '');
const OPENCODE_KEY_FILE = process.env.OPENCODE_KEY_FILE || '/root/.hermes/scripts/opencode.key';
let OPENCODE_GO_KEY = process.env.OPENCODE_GO_API_KEY || '';
if (!OPENCODE_GO_KEY) {
  try { OPENCODE_GO_KEY = fs.readFileSync(OPENCODE_KEY_FILE, 'utf8').trim(); } catch {}
}

// Free models served by opencode serve (verified working; nemotron models crash
// the session and take the bridge down, so they are excluded).
const FREE_MODELS = [
  { id: 'big-pickle',                          context: 200000, output: 32000 },
  { id: 'hy3-free',                            context: 190000, output: 64000 },
  { id: 'mimo-v2.5-free',                      context: 200000, output: 32000 },
  { id: 'muse-spark-1.2-contributor-free',     context: 1048576, output: 131072 },
];
const FREE_MODEL_IDS = new Set(FREE_MODELS.map(m => m.id));

// Static fallback list of opencode-go models (used if live fetch fails).
const OC_GO_FALLBACK = [
  'deepseek-v4-flash', 'deepseek-v4-flash-high', 'deepseek-v4-flash-max',
  'kimi-k2.6', 'kimi-k2.7-code', 'minimax-m2.5', 'minimax-m3',
  'glm-5.3', 'longcat-2.0', 'mimo-v2.5',
];

// ---- opencode-go model discovery (cached) ----
let ocGoModels = [];
let ocGoFetchedAt = 0;

async function loadOcGoModels() {
  try {
    const res = await fetch(`${OPENCODE_GO_BASE}/models`, { headers: { 'Authorization': `Bearer ${OPENCODE_GO_KEY}` } });
    if (!res.ok) throw new Error(`models ${res.status}`);
    const j = await res.json();
    // Drop models known to 500 upstream (e.g. muse-spark-1.2-contributor); the
    // working free variant muse-spark-1.2-contributor-free is served separately.
    ocGoModels = (j.data || [])
      .filter(m => !/^muse-spark-1\.2-contributor$/.test(m.id))
      .map(m => ({
        id: m.id,
        context: m.context_length || 200000,
        output: (m.capabilities && m.capabilities.max_output_tokens) || 32000,
      }));
    ocGoFetchedAt = Date.now();
    console.log(`[opencode-free-bridge] loaded ${ocGoModels.length} opencode-go models`);
  } catch (e) {
    console.error('[opencode-free-bridge] failed to load opencode-go models:', e.message);
    if (ocGoModels.length === 0) {
      ocGoModels = OC_GO_FALLBACK.map(id => ({ id, context: 200000, output: 32000 }));
    }
  }
}

// ---- opencode serve session pool (lazy, per-process) ----
let sessionId = null;
let sessionLock = null;

async function getSession() {
  if (sessionId) return sessionId;
  if (sessionLock) return sessionLock;
  sessionLock = (async () => {
    const res = await fetch(`${UPSTREAM}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) {
      sessionLock = null;
      throw new Error(`session create failed: ${res.status} ${await res.text()}`);
    }
    const j = await res.json();
    sessionId = j.id;
    return sessionId;
  })();
  return sessionLock;
}

async function postMessage(sessionId, modelId, parts) {
  const res = await fetch(`${UPSTREAM}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: { providerID: 'opencode', modelID: modelId },
      agent: AGENT,
      parts,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 404) sessionId = null;
    throw new Error(`opencode message ${res.status}: ${txt}`);
  }
  return res.json();
}

function partsFromOpenAIMessages(messages) {
  const sys = messages.find(m => m.role === 'system');
  const userTurns = messages.filter(m => m.role === 'user');
  const lastUser = userTurns.at(-1);
  if (!lastUser) throw new Error('no user message');
  const text = (typeof lastUser.content === 'string')
    ? lastUser.content
    : (lastUser.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') || '');
  const parts = [{ type: 'text', text }];
  return { parts, system: sys?.content || SYSTEM_DEFAULT };
}

function jsonResponse(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function notFoundOpenAIError(res, msg) {
  jsonResponse(res, 404, { error: { message: msg, type: 'invalid_request_error', code: 'model_not_found' } });
}

// Collapse an opencode.ai SSE stream into one OpenAI chat.completion (non-streaming).
function sseToCompletion(text, model) {
  const contentParts = [];
  let finishReason = null;
  let usage = null;
  let created = Math.floor(Date.now() / 1000);
  let respId = `chatcmpl-${Date.now()}`;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('data:')) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let chunk;
    try { chunk = JSON.parse(payload); } catch { continue; }
    if (chunk.id) respId = chunk.id;
    if (chunk.created) created = chunk.created;
    for (const ch of chunk.choices || []) {
      const delta = ch.delta || {};
      if (delta.content != null) contentParts.push(delta.content);
      if (ch.finish_reason) finishReason = ch.finish_reason;
    }
    if (chunk.usage) usage = chunk.usage;
  }
  return {
    id: respId,
    object: 'chat.completion',
    created,
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: contentParts.join('') },
      finish_reason: finishReason || 'stop',
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function pickModel(reqModel) {
  if (!reqModel) return FREE_MODELS[0];
  if (FREE_MODEL_IDS.has(reqModel)) return { id: reqModel, free: true };
  if (ocGoModels.find(m => m.id === reqModel)) return { id: reqModel, free: false };
  return null;
}

// ---- handlers ----
async function handleListModels(req, res) {
  const data = [
    ...FREE_MODELS.map(m => ({
      id: m.id, object: 'model', created: 1700000000, owned_by: 'opencode-free',
      context_window: m.context, max_output_tokens: m.output, free: true,
    })),
    ...ocGoModels.map(m => ({
      id: m.id, object: 'model', created: 1700000000, owned_by: 'opencode-go',
      context_window: m.context, max_output_tokens: m.output,
    })),
  ];
  jsonResponse(res, 200, { object: 'list', data });
}

async function handleChatCompletions(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch { return jsonResponse(res, 400, { error: { message: 'invalid json' } }); }

  const model = pickModel(body.model);
  if (!model) return notFoundOpenAIError(res, `unknown model '${body.model}'. available: ${[...FREE_MODEL_IDS, ...ocGoModels.map(m => m.id)].join(', ')}`);

  // Route free models to opencode serve, everything else to opencode-go.
  if (model.free) return handleFreeCompletion(req, res, body);
  return handleOcGoCompletion(req, res, body);
}

async function handleFreeCompletion(req, res, body) {
  const { parts, system } = partsFromOpenAIMessages(body.messages || []);
  const fullParts = system ? [{ type: 'text', text: `[system]\n${system}\n\n[user]\n` }, ...parts] : parts;
  let sid;
  try { sid = await getSession(); } catch (e) { return jsonResponse(res, 502, { error: { message: String(e.message || e) } }); }

  const stream = !!body.stream;
  if (!stream) {
    try {
      const out = await postMessage(sid, body.model, fullParts);
      const text = (out.parts || []).filter(p => p.type === 'text').map(p => p.text).join('');
      const usage = out.info?.tokens || {};
      jsonResponse(res, 200, {
        id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: out.info?.finish || 'stop' }],
        usage: { prompt_tokens: usage.input || 0, completion_tokens: usage.output || 0, total_tokens: usage.total || 0 },
      });
    } catch (e) { jsonResponse(res, 502, { error: { message: String(e.message || e) } }); }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const completionId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  sseWrite(res, { id: completionId, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  try {
    const out = await postMessage(sid, body.model, fullParts);
    const text = (out.parts || []).filter(p => p.type === 'text').map(p => p.text).join('');
    const tokens = text.match(/.{1,30}/gs) || [text];
    for (const t of tokens) sseWrite(res, { id: completionId, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
    const usage = out.info?.tokens || {};
    sseWrite(res, { id: completionId, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: out.info?.finish || 'stop' }] });
    sseWrite(res, '[DONE]');
    res.end();
  } catch (e) {
    sseWrite(res, { error: { message: String(e.message || e) } });
    sseWrite(res, '[DONE]');
    res.end();
  }
}

async function handleOcGoCompletion(req, res, body) {
  const stream = !!body.stream;
  const target = `${OPENCODE_GO_BASE}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  const auth = req.headers['authorization'];
  if (auth) headers['Authorization'] = auth;
  else if (OPENCODE_GO_KEY) headers['Authorization'] = `Bearer ${OPENCODE_GO_KEY}`;

  // opencode.ai always answers with SSE; force it upstream and normalize downstream.
  const upstreamBody = { ...body, stream: true };
  let upstreamRes;
  try {
    upstreamRes = await fetch(target, { method: 'POST', headers, body: JSON.stringify(upstreamBody) });
  } catch (e) {
    return jsonResponse(res, 502, { error: { message: `opencode-go upstream unreachable: ${String(e.message || e)}` } });
  }

  if (upstreamRes.status >= 400) {
    const errText = await upstreamRes.text();
    let errPayload;
    try { errPayload = JSON.parse(errText); } catch { errPayload = { error: { type: 'upstream_error', message: errText.slice(0, 500) } }; }
    return jsonResponse(res, upstreamRes.status, errPayload);
  }

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload && payload !== '[DONE]') res.write(`data: ${payload}\n\n`);
        }
      }
    } catch (e) {
      sseWrite(res, { error: { message: String(e.message || e) } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Non-streaming: collect SSE and collapse to one JSON object.
  const text = await upstreamRes.text();
  jsonResponse(res, 200, sseToCompletion(text, body.model));
}

const server = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return jsonResponse(res, 403, { error: { message: 'loopback only' } });
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') return handleListModels(req, res);
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return handleChatCompletions(req, res);
  if (url.pathname === '/healthz' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, upstream: UPSTREAM, opencode_go: OPENCODE_GO_BASE, free: FREE_MODELS.length, opencode_go_models: ocGoModels.length });

  return jsonResponse(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, HOST, async () => {
  console.log(`[opencode-free-bridge] listening on http://${HOST}:${PORT}  (free upstream ${UPSTREAM}, opencode-go ${OPENCODE_GO_BASE})`);
  console.log(`[opencode-free-bridge] free models: ${FREE_MODELS.map(m => m.id).join(', ')}`);
  await loadOcGoModels();
  setInterval(loadOcGoModels, 10 * 60 * 1000);
});
