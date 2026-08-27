#!/usr/bin/env node
// OpenAI-compatible reverse proxy for opencode serve (free models only).
// Listens on 127.0.0.1:5577. NO auth, NO external exposure.

import http from 'node:http';

const UPSTREAM = process.env.OPENCODE_UPSTREAM || 'http://127.0.0.1:4577';
const PORT = parseInt(process.env.PORT || '5577', 10);
const HOST = '127.0.0.1';
const AGENT = 'general';
const SYSTEM_DEFAULT = 'You are a helpful assistant.';

// 6 free models from /config/providers (OpenCode Zen, $0 cost).
// Only the IDs we need at runtime are listed; full metadata is fetched lazily.
const FREE_MODELS = [
  { id: 'big-pickle',                          context: 200000, output: 32000 },
  { id: 'hy3-free',                            context: 190000, output: 64000 },
  { id: 'mimo-v2.5-free',                      context: 200000, output: 32000 },
  { id: 'muse-spark-1.2-contributor-free',     context: 1048576, output: 131072 },
  { id: 'nemotron-3-ultra-free',               context: 1000000, output: 128000 },
  { id: 'nemotron-3.5-lightning-free',         context: 262144, output: 262144 },
];

// ---- opencode session pool (lazy, per-process) ----
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
    if (res.status === 404) {
      // session went away; reset
      sessionId = null;
    }
    throw new Error(`opencode message ${res.status}: ${txt}`);
  }
  return res.json();
}

function partsFromOpenAIMessages(messages) {
  // merge all user/tool messages into a single text part (free models = no real tool use)
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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function notFoundOpenAIError(res, msg) {
  jsonResponse(res, 404, { error: { message: msg, type: 'invalid_request_error', code: 'model_not_found' } });
}

function pickModel(reqModel) {
  if (!reqModel) return FREE_MODELS[0];
  const m = FREE_MODELS.find(x => x.id === reqModel);
  if (!m) return null;
  return m;
}

// ---- handlers ----
async function handleListModels(req, res) {
  jsonResponse(res, 200, {
    object: 'list',
    data: FREE_MODELS.map(m => ({
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: 'opencode-free',
      context_window: m.context,
      max_output_tokens: m.output,
      free: true,
    })),
  });
}

async function handleChatCompletions(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try { body = JSON.parse(raw); } catch { return jsonResponse(res, 400, { error: { message: 'invalid json' } }); }

  const model = pickModel(body.model);
  if (!model) return notFoundOpenAIError(res, `unknown free model '${body.model}'. available: ${FREE_MODELS.map(m => m.id).join(', ')}`);

  const { parts, system } = partsFromOpenAIMessages(body.messages || []);
  const fullParts = system ? [{ type: 'text', text: `[system]\n${system}\n\n[user]\n` }, ...parts] : parts;
  // opencode supports a system string; we already merged via text. To be safe use a separate system if free-text pre-merge.
  let sid;
  try { sid = await getSession(); } catch (e) { return jsonResponse(res, 502, { error: { message: String(e.message || e) } }); }

  const stream = !!body.stream;

  if (!stream) {
    try {
      const out = await postMessage(sid, model.id, fullParts);
      const text = (out.parts || [])
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('');
      const usage = out.info?.tokens || {};
      jsonResponse(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: out.info?.finish || 'stop',
        }],
        usage: {
          prompt_tokens: usage.input || 0,
          completion_tokens: usage.output || 0,
          total_tokens: usage.total || 0,
        },
      });
    } catch (e) {
      jsonResponse(res, 502, { error: { message: String(e.message || e) } });
    }
    return;
  }

  // streaming SSE — opencode returns the full message in one shot, so we chunk the text
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const completionId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const roleChunk = { id: completionId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
  sseWrite(res, roleChunk);

  try {
    const out = await postMessage(sid, model.id, fullParts);
    const text = (out.parts || [])
      .filter(p => p.type === 'text')
      .map(p => p.text)
      .join('');
    // chunk by ~30 chars to feel like streaming
    const tokens = text.match(/.{1,30}/gs) || [text];
    for (const t of tokens) {
      sseWrite(res, { id: completionId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] });
    }
    const usage = out.info?.tokens || {};
    sseWrite(res, { id: completionId, object: 'chat.completion.chunk', created, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: out.info?.finish || 'stop' }] });
    sseWrite(res, `[DONE]`);
    res.end();
  } catch (e) {
    sseWrite(res, { error: { message: String(e.message || e) } });
    sseWrite(res, `[DONE]`);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  // refuse anything not on loopback
  const remote = req.socket.remoteAddress;
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return jsonResponse(res, 403, { error: { message: 'loopback only' } });
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // CORS preflight
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
  if (url.pathname === '/healthz' && req.method === 'GET') return jsonResponse(res, 200, { ok: true, upstream: UPSTREAM, models: FREE_MODELS.length });

  return jsonResponse(res, 404, { error: { message: 'not found' } });
});

server.listen(PORT, HOST, () => {
  console.log(`[opencode-free-bridge] listening on http://${HOST}:${PORT}  (upstream ${UPSTREAM})`);
  console.log(`[opencode-free-bridge] free models: ${FREE_MODELS.map(m => m.id).join(', ')}`);
});
