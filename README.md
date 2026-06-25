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
- [ngrok](https://ngrok.com) installed and authenticated (for phone access)
- Node.js ≥ 20
- A deployed instance of `frontend-remote-cursor` (e.g. on Railway), or a local frontend dev server for testing

---

## Setup

### 1. Install dependencies

```bash
git clone <this-repo>
cd backend-remote-cursor
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

- **`DEV=false`** (default): production — ngrok tunnel + `FRONTEND_BASE_URL` (your deployed frontend).
- **`DEV=true`**: local testing — no ngrok; connect URL uses `http://localhost:{PORT}` as backend and `DEV_FRONTEND_BASE_URL` (default `http://localhost:5173`) as frontend.

For local dev with connect URL + QR (recommended):

```bash
# In .env
DEV=true
DEV_FRONTEND_BASE_URL=http://localhost:5173
```

Start the Vite frontend in another terminal (`npm run dev` in `frontend-remote-cursor`), then start the backend. Open the connect link or scan the QR on the same machine.

To skip connect URL and QR entirely:

```bash
SKIP_NGROK=true npm start
```

### 3. Set up the Cursor Agent CLI

The backend shells out to the `agent` command. Verify it works **in your terminal** before relying on the HTTP API:

```bash
# Log in (opens browser if needed)
agent login

# Confirm you are logged in
agent status

# List available models
agent models

# Smoke test — should print a response within a few seconds
agent --print --force --mode ask --model composer-2.5-fast "Reply with exactly: pong"
```

If any of these hang or fail, fix the CLI locally first (see [macOS permissions gotcha](#macos-permissions-gotcha) below).

### 4. Start the backend

```bash
npm start
```

On start (unless `SKIP_NGROK=true`):

1. Express listens on `PORT` (default **3847**)
2. **If `DEV=true`:** builds `http://localhost:{PORT}` as backend URL (no ngrok)
3. **If `DEV=false`:** ngrok starts automatically (`ngrok http 3847`)
4. A connect URL is built and a QR code opens in **Preview.app**

| Mode | Connect URL shape |
|------|-------------------|
| `DEV=false` | `{FRONTEND_BASE_URL}/connect?backend={ngrokUrl}` |
| `DEV=true` | `{DEV_FRONTEND_BASE_URL}/connect?backend=http://localhost:{PORT}` |

The PNG is always written to the same file, `data/connect-qr.png` (gitignored), and overwritten on each start — no temp-file buildup.

If port 3847 is already in use:

```bash
npm run restart
# or manually:
lsof -ti:3847 | xargs kill -9 && npm start
```

### 5. Connect

**Production (`DEV=false`):** scan the QR on your phone. Re-scan when the ngrok URL changes (free tier rotates on restart).

**Local dev (`DEV=true`):** open the connect link in your browser on the same Mac (or scan QR locally). Both frontend and backend must be running on localhost.

---

## DEV mode (local testing)

Set `DEV=true` in `.env` to test the full connect flow without ngrok:

```env
DEV=true
DEV_FRONTEND_BASE_URL=http://localhost:5173
PORT=3847
```

Example connect URL:

```
http://localhost:5173/connect?backend=http://localhost:3847
```

- **No ngrok** is started or required.
- **`FRONTEND_BASE_URL` is ignored** — use `DEV_FRONTEND_BASE_URL` instead (defaults to Vite dev server on port 5173).
- The QR code and `data/connect-qr.png` use the same localhost URLs.
- `GET /api/tunnel` returns `dev: true`, `backendUrl`, and `connectUrl` (with `ngrokUrl: null`).

Set `DEV=false` for normal phone use with ngrok and your deployed frontend.

---

## What is `FRONTEND_BASE_URL`?

Used when **`DEV=false`** only.

This backend runs **only on your Mac** (`localhost:3847`). Your phone cannot reach it directly — ngrok creates a temporary public HTTPS URL that forwards to your Mac.

The phone UI lives in a **separate deployed frontend** (`frontend-remote-cursor`, e.g. on Railway). `FRONTEND_BASE_URL` is that deployed frontend’s origin — **no trailing slash**.

| Example | Meaning |
|---------|---------|
| `https://your-app.up.railway.app` | Production frontend on Railway |
| `http://192.168.1.10:5173` | Local Vite dev server on your LAN (testing only) |

**Why the backend needs it:** on startup, the backend builds a **connect link** that pairs your phone with this Mac:

```
{FRONTEND_BASE_URL}/connect?backend={ngrokUrl}
```

For example:

```
https://your-app.up.railway.app/connect?backend=https://abc123.ngrok-free.app
```

That URL is encoded in the QR code. When your phone opens it:

1. The **frontend** loads (Railway / your host).
2. The `?backend=` query param tells the frontend which ngrok URL to save as the API base.
3. The frontend redirects you to Chat — no manual URL copying.

If `FRONTEND_BASE_URL` is missing, startup fails when building the connect link. The backend itself never serves the UI; it only needs to know where the UI lives so the QR points to the right place.

---

## macOS permissions gotcha

On macOS, the Agent CLI may **hang or appear stuck** when invoked by this backend (or even from a fresh terminal) until macOS has prompted you for the right permissions.

**Symptom:** `agent status` works, but prompts time out, return nothing, or the subprocess never exits when run headlessly (`--print --force`).

**Fix:** run a prompt **once, interactively in Terminal.app** (not only through the backend):

```bash
agent --print --force --mode ask --model composer-2.5-fast "Reply with exactly: hello"
```

macOS will usually show one or more permission dialogs (e.g. Terminal accessing files, automation, or related privacy prompts). **Accept them.**

After that, the same commands invoked by this backend over HTTP/SSE tend to work reliably. If things break again after a macOS update or CLI reinstall, repeat the local terminal test.

This is a macOS + CLI quirk, not a bug in the ngrok or Express layer — always confirm the CLI works locally before debugging the remote stack.

---

## Quick start (TL;DR)

```bash
cp .env.example .env
# Set FRONTEND_BASE_URL in .env

npm install
agent login && agent status
agent --print --force --mode ask --model composer-2.5-fast "Reply with exactly: pong"

npm start
# Scan QR on phone
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3847` | Local HTTP port |
| `AGENT_PATH` | `agent` | Path to Cursor Agent CLI |
| `DEV` | `false` | `true` = localhost connect URLs, no ngrok. `false` = ngrok + production frontend |
| `FRONTEND_BASE_URL` | — | Deployed frontend origin when `DEV=false`. See [What is FRONTEND_BASE_URL?](#what-is-frontend_base_url) |
| `DEV_FRONTEND_BASE_URL` | `http://localhost:5173` | Local frontend origin when `DEV=true` |
| `SKIP_NGROK` | — | Set `true` to skip connect URL + QR on startup |
| `SKIP_QR` | — | Set `true` to start ngrok but skip opening Preview |
| `NGROK_BIN` | `ngrok` | Path to ngrok binary |
| `FAVORITE_MODELS_PATH` | `data/favorite-models.json` | Path to favorite models config |
| `WORKSPACES_CONFIG_PATH` | `data/workspaces.json` | Path to workspace curated overrides config |
| `QR_CODE_PATH` | `data/connect-qr.png` | Path to connect QR PNG (overwritten each startup) |

---

## Project structure

```
backend-remote-cursor/
├── data/
│   ├── favorite-models.json    # Persisted favorite model IDs (Mac-side)
│   ├── workspaces.json         # Curated workspace overrides (auto-created)
│   └── connect-qr.png          # Latest connect QR (auto-created, gitignored)
├── src/
│   ├── index.js                # Express app, CORS, connect setup on startup
│   ├── config.js               # DEV flag, frontend/backend URL resolution
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
| `GET` | `/api/tunnel` | Connect state: `dev`, `backendUrl`, `ngrokUrl`, `connectUrl` |

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

Mirror what the backend runs. If these fail, see [macOS permissions gotcha](#macos-permissions-gotcha) before chasing ngrok or API issues.

```bash
# Quick test
agent --print --force --mode ask --model composer-2.5-fast "Reply with exactly: pong"

# Live streaming output (what POST /api/prompt/stream uses)
agent --print --force --output-format stream-json --stream-partial-output --mode ask "your prompt"

# Resume a chat
agent --print --force --resume YOUR_CHAT_ID "follow-up prompt"
```

Check login and models:

```bash
agent login    # if status shows not logged in
agent status
agent models
```

Test the backend directly (backend must be running):

```bash
curl -s http://localhost:3847/api/health
curl -s http://localhost:3847/api/status
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
