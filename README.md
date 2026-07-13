# doc-jarvis

A bridge that connects Google Docs to [OpenClaw](https://github.com/openclaw/openclaw). It monitors your Google Drive for documents with a keyword in the title, detects prompts addressed to an AI assistant (e.g. `@jarvis`), sends them to OpenClaw with per-document session routing, and streams the response back into the document in real time.

## How It Works

1. **Drive Discovery** — Scans Google Drive for docs with a keyword in the **title** (instant results, no full-text indexing delay)
2. **Content Polling** — Periodically fetches the content of discovered docs via the Google Docs API (default: every 10s)
3. **Command Detection** — Checks for command tokens (`@gateway-start`, `@model`, `@clear`, etc.) before prompt detection
4. **Prompt Detection** — Finds `@jarvis` (case-insensitive) followed by a text block ending at a blank line
5. **Typing Guard** — Compares content across polls to detect active typing; requires stable polls before sending
6. **Dedup via 👀 Marker** — When a prompt or command is detected, 👀 is inserted after it permanently. The scanner skips anything that already has 👀 — no separate state file needed
7. **Prompt Dispatch** — Sends the prompt to OpenClaw via `/v1/chat/completions` with `x-openclaw-session-key: <docId>` for per-doc conversation context
8. **Response Streaming** — Streams the response back into the doc, buffered and flushed every 1 second, prefixed with `Jarvis: `

## Setup

```bash
npm install
cp config.example.json config.json
cp .env.example .env
# Fill in Google OAuth credentials and OpenClaw Gateway token
npm run build
npm start
```

First run auto-opens your browser for Google OAuth consent. Tokens are stored locally at `tokens/google-token.json` and auto-refreshed.

## Configuration

Settings can be configured via `.env`, `config.json`, or changed at runtime using config commands (see below). Priority: `.env` > `config.json` > defaults.

### Environment Variables (`.env`)

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
OPENCLAW_GATEWAY_URL=http://localhost:18789
OPENCLAW_GATEWAY_TOKEN=your-gateway-token
```

### Config File (`config.json`)

See `config.example.json` for the full template. Key settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `trigger_keyword` | `@jarvis` | Token that triggers a prompt (case-insensitive) |
| `drive_search_keyword` | `jarvis` | Keyword to search for in Google Doc **titles** |
| `poll_interval_ms` | `10000` | How often to poll Drive for docs |
| `stream_interval_ms` | `500` | Base streaming interval |
| `response_prefix` | `Jarvis: ` | Text prefixed before each response |
| `seen_marker` | 👀 | Dedup marker inserted after processed prompts/commands |
| `commands_enabled` | `true` | Enable/disable inline command processing |
| `openclaw.gateway_url` | `http://localhost:18789` | OpenClaw Gateway URL |
| `openclaw.gateway_token` | `""` | Gateway auth token |
| `openclaw.model` | `openclaw` | Default model name |
| `google.client_id` | `""` | OAuth client ID |
| `google.client_secret` | `""` | OAuth client secret |
| `google.redirect_uri` | `http://localhost:8080/oauth2callback` | OAuth callback URI |

## Commands

Type these directly into any Google Doc that has the search keyword in its title:

### Prompt

| Command | Description |
|---------|-------------|
| `@jarvis <prompt>` | Send a prompt to OpenClaw (case-insensitive: `@Jarvis`, `@JARVIS` work) |

### Gateway Management

| Command | Description |
|---------|-------------|
| `@gateway-start` | Start the OpenClaw gateway, poll until online |
| `@gateway-restart` | Restart the gateway, poll until online |
| `@gateway-stop` | Stop the gateway, poll until offline |

### Session & Model

| Command | Description |
|---------|-------------|
| `@model <name>` | Change the OpenClaw model via admin RPC (hot-reload, no restart). Supports full (`ollama/glm-5.2:cloud`) or short (`glm-5.2:cloud` — auto-prepends current provider) |
| `@clear` | Clear the OpenClaw session for this doc — next prompt starts a fresh conversation |

### Runtime Config

| Command | Description |
|---------|-------------|
| `@trigger-word <word>` | Change the prompt trigger keyword |
| `@drive-search-word <word>` | Change the Drive title search keyword |
| `@poll-ms <number>` | Change the poll interval in milliseconds |
| `@gateway-port <port>` | Change the gateway port |
| `@gateway-token <token>` | Change the gateway auth token |
| `@response-prefix <prefix>` | Change the text prefixed before responses |
| `@seen-marker <marker>` | Change the dedup marker (default 👀) |
| `@commands-enabled <bool>` | Enable/disable command processing |

All commands insert the seen marker (👀 by default) as a permanent indicator so they don't re-trigger on subsequent polls. Config changes apply at runtime — no restart needed.

## Response Format

```
@jarvis what is the capital of France? 👀

Jarvis: The capital of France is Paris.
```

- 👀 is inserted right after the prompt text (never removed)
- `Jarvis: <response>` appears on the next line, streamed in 1-second buffered chunks
- Each doc gets its own OpenClaw session, so Jarvis remembers the conversation context
- `@clear` starts a fresh session for that doc

## Requirements

- Node.js 18+
- A Google Cloud project with Drive API + Docs API enabled
- OAuth 2.0 credentials (Web application type, redirect URI `http://localhost:8080/oauth2callback`)
- Scopes: `https://www.googleapis.com/auth/drive` and `https://www.googleapis.com/auth/documents`
- An OpenClaw Gateway instance running on port 18789
- OpenClaw config with HTTP endpoints enabled:
  ```json
  "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } }
  ```
- `admin-http-rpc` plugin enabled (for `@model` command)

## Google Cloud Setup

1. Create a Google Cloud project at the [console](https://console.cloud.google.com/)
2. Enable **Google Drive API** and **Google Docs API**
3. Configure OAuth consent screen (External, add yourself as test user)
4. Add scopes: `.../auth/drive` and `.../auth/documents`
5. Create OAuth client ID (Web application)
6. Authorized redirect URI: `http://localhost:8080/oauth2callback`
7. Copy Client ID + Secret into `.env`

## Development

```bash
npm run dev          # tsx watch — hot reload dev mode
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit
npm start            # node dist/index.js

DEBUG=true node dist/index.js   # Shows [DEBUG] log lines
```

## How Tool Execution Works

When Jarvis uses tools (web search, browser, code execution), all tool execution happens server-side on the OpenClaw gateway. Only the final text response streams back to doc-jarvis. Tool calls in the SSE stream are silently ignored — we only extract the text content.

## License

MIT