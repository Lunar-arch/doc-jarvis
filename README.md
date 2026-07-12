# doc-jarvis

A bridge that connects Google Docs to [OpenClaw](https://github.com/openclaw/openclaw). It monitors your Google Drive for documents containing a keyword, detects prompts addressed to an AI assistant (e.g. `@jarvis`), sends them to OpenClaw, and streams the response back into the document in real time.

## How It Works

1. **Drive Discovery** — Scans Google Drive for docs containing a configured keyword
2. **Content Polling** — Periodically fetches doc content via the Google Docs API
3. **Prompt Detection** — Finds `@jarvis` (or configured trigger) followed by a text block
4. **Typing Guard** — Waits for the user to stop typing before sending the prompt
5. **Prompt Dispatch** — Sends the extracted prompt to the OpenClaw Gateway
6. **Response Streaming** — Writes the response back into the doc in ~500ms increments below the prompt
7. **Prompt Tracking** — Remembers which prompts have been responded to — no duplicates

## Setup

```bash
npm install
cp config.example.json config.json
cp .env.example .env
# Fill in Google OAuth credentials and OpenClaw Gateway URL
npm run build
npm start
```

First run opens a browser for Google OAuth consent. Tokens are stored locally and auto-refreshed.

## Configuration

See `config.example.json` for all options. Key settings:

- `trigger_keyword` — The token that triggers a prompt (default: `@jarvis`)
- `drive_search_keyword` — Keyword to filter docs in Drive
- `poll_interval_ms` — How often to poll docs (default: 30000)
- `stream_interval_ms` — Response write interval (default: 500)
- `openclaw.gateway_url` — OpenClaw Gateway endpoint
- `google.client_id` / `google.client_secret` — OAuth credentials

## Requirements

- Node.js 18+
- A Google Cloud project with Drive API and Docs API enabled
- An OpenClaw Gateway instance running and accessible

## License

MIT