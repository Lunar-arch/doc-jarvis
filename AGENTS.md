# doc-jarvis — Project Overview & Agent Log

> **Purpose:** This file is the single source of truth for project state. All agents **must** read this before starting work to avoid re-doing completed tasks and to understand what's next.

---

## Project Overview

A **Google Docs to OpenClaw bridge** that monitors a user's Google Drive for documents containing a keyword, periodically pulls doc content, detects prompts addressed to an AI assistant (e.g. `@jarvis`), sends those prompts to OpenClaw, and streams the response back into the Google Doc in real time.

### How It Works

1. **Drive Discovery** — Scans the user's Google Drive for docs containing a configured keyword (e.g. `@jarvis` or a project tag)
2. **Content Polling** — Periodically fetches the content of discovered docs via the Google Docs API
3. **Prompt Detection** — Searches for the trigger token (`@jarvis` or configured name) followed by a text block; the block ends at a blank line or explicit delimiter
4. **Typing Guard** — Tracks whether the user's cursor/selection is still active in the prompt region to avoid sending prompts mid-typing
5. **Prompt Dispatch** — Sends the extracted prompt to OpenClaw via the Gateway HTTP API
6. **Response Streaming** — Streams the OpenClaw response back into the Google Doc, writing in ~500ms increments below the prompt (after 1 newline)
7. **Prompt Tracking** — Maintains state on which prompts have been responded to so it doesn't re-send or duplicate responses

### Architecture

```
doc-jarvis/
├── src/
│   ├── index.ts                  # Entry point — starts the polling loop
│   ├── config.ts                 # Configuration loader (config.json + defaults + env)
│   ├── drive.ts                  # Google Drive API client — discover & list docs by keyword
│   ├── docs.ts                   # Google Docs API client — fetch & update doc content
│   ├── prompt_scanner.ts          # Scans doc content for @jarvis triggers and extracts prompt blocks
│   ├── typing_guard.ts            # Tracks cursor/selection state to detect active typing
│   ├── prompt_tracker.ts          # Tracks which prompts have already been responded to
│   ├── openclaw_client.ts         # OpenClaw Gateway HTTP API client — sends prompts, streams responses
│   ├── doc_writer.ts              # Writes streamed response back into Google Doc (~500ms increments)
│   └── types.ts                   # Shared TypeScript types
├── config.json                    # Runtime configuration
├── config.example.json            # Configuration template
├── .env / .env.example            # Environment variables (API keys, OAuth, Gateway URL)
├── package.json
├── tsconfig.json
└── AGENTS.md                      # This file
```

### Tech Stack

| Layer          | Technology                                                        |
| -------------- | ----------------------------------------------------------------- |
| Runtime        | Node.js 18+, TypeScript                                            |
| Google APIs    | googleapis (Drive API v3, Docs API v1)                            |
| Auth           | OAuth 2.0 (Google) — stored token refresh                          |
| OpenClaw       | Gateway HTTP API (send prompt, stream response)                  |
| Config         | JSON config file + environment variables                           |
| Build          | `tsc` → `dist/`                                                    |
| Package Mgmt   | npm                                                               |

### Configuration (`config.json`)

```json
{
  "trigger_keyword": "@jarvis",
  "drive_search_keyword": "@jarvis",
  "poll_interval_ms": 30000,
  "stream_interval_ms": 500,
  "openclaw": {
    "gateway_url": "http://localhost:3000",
    "gateway_token": "",
    "session_key": "",
    "model": ""
  },
  "google": {
    "client_id": "",
    "client_secret": "",
    "redirect_uri": "http://localhost:8080/oauth2callback",
    "token_path": "./tokens/google-token.json"
  },
  "prompt_delimiter": {
    "start": "@jarvis",
    "end_pattern": "\\n\\n"
  }
}
```

### Key File Locations

- Entry point: `src/index.ts`
- Config: `src/config.ts` + `config.json`
- Drive client: `src/drive.ts`
- Docs client: `src/docs.ts`
- Prompt scanner: `src/prompt_scanner.ts`
- Typing guard: `src/typing_guard.ts`
- Prompt tracker: `src/prompt_tracker.ts`
- OpenClaw client: `src/openclaw_client.ts`
- Doc writer: `src/doc_writer.ts`
- Types: `src/types.ts`
- Config example: `config.example.json`
- Env template: `.env.example`

### Commands

```bash
# Development
npm run dev          # tsx watch src/index.ts — hot reload dev mode
npm start            # node dist/index.js — run compiled

# Build
npm run build        # tsc → dist/
npm run clean        # rm -rf dist/

# Linting
npm run lint         # eslint src --ext .ts
npm run typecheck    # tsc --noEmit
```

### Environment

Copy `.env.example` to `.env`:
- `GOOGLE_CLIENT_ID` — Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` — Google OAuth client secret
- `OPENCLAW_GATEWAY_URL` — OpenClaw Gateway URL (default: `http://localhost:3000`)
- `OPENCLAW_GATEWAY_TOKEN` — OpenClaw Gateway auth token

### Auth Flow

1. First run: opens browser for Google OAuth consent
2. Token stored at `tokens/google-token.json`
3. Auto-refreshes on expiry
4. Requires Drive and Docs API scopes

---

## Change Log

A chronological history of what has been done. **Update this after completing work.**

### Foundation
- [x] Created repository and AGENTS.md

---

## Checklist — What To Do Next

### Phase 1 — Google Integration
- [ ] Set up Google OAuth (Drive API + Docs API scopes)
- [ ] Implement Drive client — search for docs by keyword
- [ ] Implement Docs client — fetch doc content, batch update (insert text)
- [ ] Token storage and auto-refresh

### Phase 2 — Prompt Detection
- [ ] Implement prompt scanner — find `@jarvis` blocks, extract prompt text
- [ ] Define prompt block boundaries (start token, end at blank line)
- [ ] Implement prompt tracker — track which prompts have been responded to (by doc ID + prompt hash/position)
- [ ] Implement typing guard — detect if user cursor is still in the prompt region (skip if active)

### Phase 3 — OpenClaw Integration
- [ ] Implement OpenClaw Gateway client — send prompt, receive streamed response
- [ ] Handle response streaming (SSE or polling depending on Gateway API)
- [ ] Error handling — Gateway down, rate limits, timeout

### Phase 4 — Response Writing
- [ ] Implement doc writer — insert response text into Google Doc below prompt (1 newline gap)
- [ ] Stream in ~500ms increments (append chunks as they arrive)
- [ ] Mark prompt as responded after writing completes
- [ ] Handle concurrent docs (multiple docs with prompts)

### Phase 5 — Polish & Robustness
- [ ] Configurable trigger name (not hardcoded to `@jarvis`)
- [ ] Graceful shutdown (finish writing, save state)
- [ ] Logging and error recovery
- [ ] State persistence (which prompts responded to) — survive restarts
- [ ] Config validation on startup
- [ ] README

---

## Agent Guidelines

1. **Always read this file first** before starting any work.
2. **Update the Change Log** after completing tasks — add a new session section with date.
3. **Update the Checklist** — check off completed items, add new items as discovered.
4. **Never re-scaffold** something that's already marked done in the log.
5. **Note blockers** — if you can't proceed, note what's blocking and stop.
6. **Keep it concise** — bullet points, not essays.
7. **Google API calls must be batched** where possible to avoid rate limits. Respect `Retry-After` headers.
8. **Never send a prompt while the user is still typing it** — the typing guard exists for a reason. Don't bypass it.
9. **Response streaming writes in ~500ms increments** — don't dump the whole response at once. This makes the experience feel live.
10. **Prompt tracking state must persist across restarts** — store it in a file (e.g. `state/prompts.json`). Don't keep it only in memory.
11. **OAuth tokens are sensitive** — store in `tokens/`, never commit them, ensure `.gitignore` covers them.
12. **Config is layered** — `config.json` overrides defaults, environment variables override config. Don't hardcode values.
13. **The trigger name is configurable** — don't hardcode `@jarvis`. Read from config.
14. **OpenClaw Gateway client should handle both SSE and non-streaming** — some setups may not support SSE. Fall back gracefully.