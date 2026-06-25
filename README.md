# Remote Cursor — Backend

A local Node.js server that runs on your Mac and exposes the **Cursor Agent CLI** (`agent`) over HTTP. A mobile-first frontend (deployed separately, e.g. on Railway) connects to this backend through an **ngrok tunnel** so you can control Cursor from your phone.

## Goal

Build a remote control surface for Cursor on your Mac:

- Send prompts to the agent from your phone
- Pick model, mode (Ask / Plan / Agent), and eventually workspace/project
- Resume past chats and browse history
- Zero manual URL copying after setup — scan a QR code and go

**Architecture:**

```
Phone (frontend on Railway)
    → HTTPS
ngrok tunnel (public URL, changes on free tier)
    → localhost:3847 (this backend)
    → agent CLI (Cursor Agent)
    → your Mac filesystem / repos
```

The frontend lives in a separate repo: `frontend-remote-cursor`. The backend URL is configured on the phone (or auto-filled via the QR connect flow).

---

## Requirements

- macOS with [Cursor Agent CLI](https://cursor.com) installed (`agent` on PATH)
- Logged in: `agent login`
- [ngrok](https://ngrok.com) installed (for phone access)
- Node.js ≥ 20

---

## Quick start

```bash
cp .env.example .env
# Edit .env — set FRONTEND_BASE_URL to your deployed frontend URL

npm install
npm start
```

On start (unless `SKIP_NGROK=true`):

1. Express listens on `PORT` (default **3847**)
2. ngrok starts automatically (`ngrok http 3847`)
3. A connect URL is built: `{FRONTEND_BASE_URL}/connect?backend={ngrokUrl}`
4. A QR code opens in **Preview.app** — scan it with your phone

If port 3847 is already in use:

```bash
lsof -ti:3847 | xargs kill -9
npm start
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3847` | Local HTTP port |
| `AGENT_PATH` | `agent` | Path to Cursor Agent CLI |
| `FRONTEND_BASE_URL` | — | Deployed frontend URL (no trailing slash). Used for QR connect links |
| `SKIP_NGROK` | — | Set `true` to skip ngrok + QR on startup |
| `SKIP_QR` | — | Set `true` to start ngrok but skip opening Preview |
| `NGROK_BIN` | `ngrok` | Path to ngrok binary |
| `FAVORITE_MODELS_PATH` | `data/favorite-models.json` | Path to favorite models config |
| `WORKSPACES_CONFIG_PATH` | `data/workspaces.json` | Path to workspace curated overrides config |

---

## Project structure

```
backend-remote-cursor/
├── data/
│   ├── favorite-models.json    # Persisted favorite model IDs (Mac-side)
│   └── workspaces.json         # Curated workspace overrides (auto-created)
├── src/
│   ├── index.js                # Express app, CORS, ngrok startup
│   ├── routes/
│   │   └── api.js              # HTTP routes
│   └── services/
│       ├── agentCli.js         # Wraps `agent` subprocess calls
│       ├── connectLink.js        # Builds frontend connect URL
│       ├── cursorData.js         # Reads ~/.cursor/projects on disk (chats, workspaces)
│       ├── favoriteModels.js     # Read/write favorite models JSON
│       ├── ngrok.js              # Start ngrok, poll local API for public URL
│       ├── qrDisplay.js          # Generate QR PNG, open in Preview
│       ├── tunnel.js             # Orchestrates tunnel + QR on startup
│       ├── tunnelState.js        # In-memory ngrok/connect URL state
│       └── workspacesConfig.js   # Read/write workspace curated overrides JSON
├── .env.example
└── package.json
```

---

## API reference

All routes are under `/api`. CORS allows any origin and the header `ngrok-skip-browser-warning: true` (required for ngrok free tier from browsers).

### Health & tunnel

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Service health check |
| `GET` | `/api/tunnel` | Current ngrok URL and phone connect link |

### Agent CLI

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | `agent status` (login state) |
| `GET` | `/api/about` | `agent about` (CLI version, OS, email) |
| `GET` | `/api/models` | Full model catalog (`agent models`) |

### Favorite models

Favorites are stored on the Mac in `data/favorite-models.json`. The frontend Settings page edits this list; the Chat page only shows favorites.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/favorites/models` | Favorites with labels + full catalog |
| `PUT` | `/api/favorites/models` | Body: `{ "favorites": ["composer-2.5-fast", ...] }` |

Default favorites:

```json
{
  "favorites": ["composer-2.5-fast", "composer-2.5"]
}
```

First entry = primary/default model on Chat.

### Workspaces

Workspaces are auto-discovered from `~/.cursor/projects/` (any folder with an `agent-transcripts/` subdirectory). Curated labels, pinning, and hiding are stored in `data/workspaces.json`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/workspaces` | List all workspaces/projects with chatCount, lastActivity, pinned |
| `PUT` | `/api/workspaces` | Body: `{ "overrides": { "<slug>": { "label", "path", "pinned", "hidden" } } }` |
| `GET` | `/api/workspaces/config` | Raw curated overrides object |

### Chat history

Chat transcripts are read directly from disk at `~/.cursor/projects/{slug}/agent-transcripts/{chatId}/{chatId}.jsonl`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/chats?workspace=&q=&limit=` | List chats (all workspaces or one); searchable by `q` |
| `GET` | `/api/chats/:id?workspace=` | Full transcript for one chat (`messages: [{role, text}]`) |

### Chats & prompts

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chats` | Create empty chat (`agent create-chat`), returns `chatId` |
| `POST` | `/api/prompt` | Send a prompt (see body below) |

**`POST /api/prompt` body:**

```json
{
  "prompt": "Your message",
  "chatId": "uuid-from-create-chat-or-resume",
  "mode": "agent",
  "model": "composer-2.5-fast",
  "workspace": "/optional/path",
  "outputFormat": "text"
}
```

- `mode`: `"agent"` (default, full access), `"ask"` (Q&A, read-only), `"plan"` (planning, read-only)
- `model`: any model id; omitted or `"auto"` uses agent default
- `workspace`: passed to `agent --workspace` (not yet exposed in UI)
- Prompts run with `--print --force` (headless, up to 5 min timeout)

---

## Frontend integration (sibling repo)

The frontend (`frontend-remote-cursor`) provides:

- **Settings** — backend URL (localStorage), connection tests, searchable favorite model picker
- **Chat** — mode picker, favorite-only model dropdown, send/receive messages
- **Connect route** — `/connect?backend=...` auto-saves ngrok URL from QR scan

Connect flow:

1. Backend starts → QR contains `{FRONTEND_BASE_URL}/connect?backend={ngrokUrl}`
2. Phone opens frontend → saves backend URL → redirects to Chat

---

## What is implemented

- [x] Express HTTP API wrapping Cursor Agent CLI
- [x] Auto ngrok on startup + QR in Preview
- [x] Connect URL generation for instant phone pairing
- [x] Health / status / about / models endpoints
- [x] Create chat + send prompt with mode and model
- [x] Favorite models persisted in `data/favorite-models.json`
- [x] Multi-turn chat via `--resume chatId`
- [x] CORS + ngrok browser warning header support
- [x] Graceful shutdown (SIGINT/SIGTERM)
- [x] List workspaces/projects from `~/.cursor/projects/` with curated overrides (`data/workspaces.json`)
- [x] List + search chat history across all workspaces
- [x] Load full chat transcript for a single chat
- [x] Resume an existing chat from the transcript view

---

## What is not implemented yet

These are planned; the backend may need new routes and data files.

### Chat history & workspace selection (implemented)

These are now implemented via filesystem reads — see the Workspaces and Chat history API sections above.

### Other improvements

- [ ] Streaming responses (SSE) via `agent --output-format stream-json`
- [ ] Strip ANSI from all CLI responses consistently
- [ ] `npm run restart` script to kill port 3847 before start
- [ ] Optional auth on the ngrok-exposed API

---

## Debugging agent locally

Mirror what the backend runs:

```bash
# Quick test
agent --print --force --mode ask --model composer-2.5-fast "Reply with exactly: pong"

# Live streaming output
agent --print --force --output-format stream-json --stream-partial-output --mode ask "your prompt"

# Resume a chat
agent --print --force --resume YOUR_CHAT_ID "follow-up prompt"
```

Check login and models:

```bash
agent status
agent models
```

---

## Related repos

| Repo | Role |
|------|------|
| `backend-remote-cursor` (this) | Mac-local API + ngrok + agent CLI |
| `frontend-remote-cursor` | Mobile UI, deployed (Railway), connects via ngrok |

---

## License

Private project.
