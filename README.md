# opencode-free-bridge

Tiny **OpenAI-compatible HTTP API** for the free models exposed by the
[`opencode`](https://github.com/sst/opencode) CLI. No API key. No external
exposure — the proxy only listens on the loopback interface.

## What it does

`opencode serve` ships its own REST API, but the shape is its own
(`/session`, `/session/{id}/message`, ...). This thin proxy translates the
industry-standard OpenAI Chat Completions API onto opencode's free models so
you can drop it into anything that speaks OpenAI.

```
┌──────────────┐      /v1/chat/completions       ┌──────────────┐      opencode /session/{id}/message      ┌────────────────────┐
│  any client  │ ──────────────────────────────▶ │   bridge     │ ───────────────────────────────────────▶ │  opencode serve    │
│  (curl, SDK) │ ◀──── OpenAI-shaped JSON/SSE ── │  :5577 lo    │ ◀──────── free model response ──────── │  :4577 lo          │
└──────────────┘                                 └──────────────┘                                          └────────────────────┘
                                                                                                              │
                                                                                                              ▼
                                                                                                       OpenCode Zen (free tier)
```

## Features

- `GET /v1/models` — list the 6 free models
- `POST /v1/chat/completions` — sync + streaming (`stream:true`, SSE)
- `GET /healthz` — health probe
- OpenAI Python / Node / curl clients work out of the box
- **Loopback only** — refuses any non-`127.0.0.1` / `::1` source with 403
- Zero deps (Node 18+ builtins only)

## Free models

All served by OpenCode Zen, no API key, no quota from your side:

| ID                                  | Context  | Max output | Notes                        |
| ----------------------------------- | -------- | ---------- | ---------------------------- |
| `big-pickle`                        | 200K     | 32K        | reasoning                    |
| `hy3-free`                          | 190K     | 64K        | reasoning                    |
| `mimo-v2.5-free`                    | 200K     | 32K        | reasoning, audio/image in    |
| `muse-spark-1.2-contributor-free`   | 1.0M     | 131K       | reasoning, multimodal (in)   |
| `nemotron-3-ultra-free`             | 1.0M     | 128K       | reasoning                    |
| `nemotron-3.5-lightning-free`       | 262K     | 262K       | reasoning                    |

## Install

```bash
git clone https://github.com/raksix/opencode-free-bridge.git
cd opencode-free-bridge
sudo install -m 0755 <(curl -fsSL https://raw.githubusercontent.com/raksix/opencode-free-bridge/main/scripts/opencode-free-bridge) /usr/local/bin/opencode-free-bridge
```

> The launcher expects `opencode` on `$PATH` (the upstream CLI).

## Run

```bash
opencode-free-bridge start     # starts opencode serve :4577 + bridge :5577
opencode-free-bridge status    # ports + health
opencode-free-bridge logs      # tail both logs
opencode-free-bridge stop
opencode-free-bridge restart
```

### systemd (auto-start on boot)

```bash
sudo install -m 0644 scripts/opencode-free-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now opencode-free-bridge.service
```

## Usage

### curl

```bash
curl -s http://127.0.0.1:5577/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "mimo-v2.5-free",
    "messages": [{"role":"user","content":"2+2=? Number only."}],
    "max_tokens": 20
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:5577/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:5577/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="mimo-v2.5-free",
    messages=[{"role": "user", "content": "Say hi in one word."}],
)
print(resp.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "yes or no?"}],
    stream=True,
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
print()
```

### OpenAI Node SDK

```js
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "http://127.0.0.1:5577/v1",
  apiKey: "not-needed",
});
const r = await client.chat.completions.create({
  model: "hy3-free",
  messages: [{ role: "user", content: "hello" }],
});
console.log(r.choices[0].message.content);
```

## Security

- Listens on `127.0.0.1` only. Any connection from a non-loopback address is
  rejected with `403`.
- No auth required *because* it's loopback-only. If you ever expose it, put
  it behind a reverse proxy with auth — the bridge itself does not implement
  user authentication.
- No filesystem access, no shell exec, no env passthrough — the only thing
  it does is translate HTTP.

## Architecture

| File                                  | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `server.mjs`                          | Zero-dep Node HTTP server, OpenAI-shaped endpoints, SSE chunking        |
| `scripts/opencode-free-bridge`        | Launcher — boots `opencode serve` + the bridge, writes pid files, health |
| `scripts/opencode-free-bridge.service`| systemd unit for boot-time autostart                                    |

The bridge keeps a single `opencode` session in-process and reuses it across
requests, so each `/v1/chat/completions` call costs one POST upstream.

## License

MIT
