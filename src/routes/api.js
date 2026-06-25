import { Router } from "express";
import {
  createChat,
  getAgentAbout,
  getAgentStatus,
  listModels,
  sendPrompt,
  streamPrompt,
} from "../services/agentCli.js";
import { getChatTranscript, listChats, listWorkspaces, resolveWorkspacePath } from "../services/cursorData.js";
import {
  getFavoriteModelsEnriched,
  writeFavoriteIds,
} from "../services/favoriteModels.js";
import { getTunnelState } from "../services/tunnelState.js";
import { readWorkspaceConfig, writeWorkspaceConfig } from "../services/workspacesConfig.js";

const router = Router();

router.get("/tunnel", (_req, res) => {
  const tunnel = getTunnelState();
  res.json({
    ok: tunnel.ready,
    ...tunnel,
  });
});

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "remote-cursor-backend",
    timestamp: new Date().toISOString(),
  });
});

router.get("/status", async (_req, res) => {
  const result = await getAgentStatus();
  res.status(result.ok ? 200 : 502).json(result);
});

router.get("/about", async (_req, res) => {
  const result = await getAgentAbout();
  res.status(result.ok ? 200 : 502).json(result);
});

router.get("/models", async (_req, res) => {
  const result = await listModels();
  res.status(result.ok ? 200 : 502).json(result);
});

router.get("/favorites/models", async (_req, res) => {
  try {
    const { favorites, favoriteIds, catalog } = await getFavoriteModelsEnriched();
    res.json({
      ok: true,
      data: { favorites, favoriteIds, catalog },
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.put("/favorites/models", async (req, res) => {
  try {
    const { favorites } = req.body ?? {};
    const saved = await writeFavoriteIds(favorites);
    const { favorites: enriched } = await getFavoriteModelsEnriched();
    res.json({
      ok: true,
      data: { favoriteIds: saved, favorites: enriched },
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

router.post("/chats", async (_req, res) => {
  const result = await createChat();
  res.status(result.ok ? 201 : 502).json(result);
});

// ── Workspaces ────────────────────────────────────────────────────────────────

router.get("/workspaces", async (_req, res) => {
  try {
    const workspaces = await listWorkspaces();
    res.json({ ok: true, data: { workspaces } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.put("/workspaces", async (req, res) => {
  try {
    const { overrides } = req.body ?? {};
    const saved = await writeWorkspaceConfig(overrides ?? {});
    res.json({ ok: true, data: { overrides: saved } });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

// ── Chat history ──────────────────────────────────────────────────────────────

router.get("/chats", async (req, res) => {
  try {
    const { workspace, q, limit } = req.query;
    const chats = await listChats({
      workspaceSlug: workspace || undefined,
      q: q || undefined,
      limit: limit ? Math.min(Number(limit) || 200, 500) : 200,
    });
    res.json({ ok: true, data: { chats } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/chats/:id", async (req, res) => {
  try {
    const { workspace } = req.query;
    if (!workspace) {
      return res.status(400).json({ ok: false, error: "workspace query param is required" });
    }
    const transcript = await getChatTranscript({
      workspaceSlug: workspace,
      chatId: req.params.id,
    });
    res.json({ ok: true, data: transcript });
  } catch (error) {
    const status = error.status ?? 500;
    res.status(status).json({ ok: false, error: error.message });
  }
});

// ── Workspaces config (GET for settings) ─────────────────────────────────────

router.get("/workspaces/config", async (_req, res) => {
  try {
    const overrides = await readWorkspaceConfig();
    res.json({ ok: true, data: { overrides } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/prompt/stream", async (req, res) => {
  const { prompt, model, mode, workspace, workspaceSlug, chatId } = req.body ?? {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ ok: false, error: "prompt is required" });
  }

  const validModes = ["agent", "ask", "plan"];
  const resolvedMode = validModes.includes(mode) ? mode : "agent";

  let resolvedWorkspace = workspace || null;
  if (workspaceSlug) {
    const overrides = await readWorkspaceConfig();
    const path = await resolveWorkspacePath(workspaceSlug, overrides);
    if (!path) {
      return res.status(400).json({
        ok: false,
        error: `Could not resolve workspace path for "${workspaceSlug}". Add a path override in data/workspaces.json.`,
      });
    }
    resolvedWorkspace = path;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let ended = false;
  // Tracks text already forwarded for the current assistant reply.
  // stream-json with --stream-partial-output emits incremental chunks (timestamp_ms)
  // and then a final cumulative assistant event without timestamp_ms.
  let assistantTextSent = "";

  function sendSse(name, data) {
    if (ended) return;
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function endSse() {
    if (ended) return;
    ended = true;
    res.end();
  }

  const child = streamPrompt({
    prompt: prompt.trim(),
    model,
    mode: resolvedMode,
    workspace: resolvedWorkspace,
    chatId,
    onEvent(event) {
      if (event.type === "system" && event.subtype === "init") {
        sendSse("session", { chatId: event.session_id, model: event.model });
      } else if (event.type === "assistant") {
        const content = event.message?.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text" && part.text) {
              let delta;
              if (event.timestamp_ms != null) {
                // Incremental chunk from --stream-partial-output
                delta = part.text;
              } else if (part.text.startsWith(assistantTextSent)) {
                // Final cumulative event — only forward unsent suffix
                delta = part.text.slice(assistantTextSent.length);
              } else {
                delta = part.text;
              }
              if (delta) {
                sendSse("text", { delta });
                assistantTextSent += delta;
              }
            } else if (part.type === "tool_use") {
              if (part.name === "CreatePlan") {
                sendSse("plan", {
                  name: part.input?.name ?? "",
                  overview: part.input?.overview ?? "",
                  plan: part.input?.plan ?? "",
                  todos: part.input?.todos ?? [],
                });
              } else if (part.name === "TodoWrite") {
                sendSse("todos", { todos: part.input?.todos ?? [] });
              }
            }
          }
        }
      } else if (event.type === "result") {
        sendSse("done", { result: event.result, ok: !event.is_error });
        endSse();
      } else if (event.type === "error") {
        sendSse("error", { error: event.error });
        endSse();
      } else if (event.type === "process_exit" && event.code !== 0) {
        sendSse("error", { error: `Agent process exited with code ${event.code}` });
        endSse();
      }
    },
  });

  req.on("close", () => {
    ended = true;
    child.kill();
  });
});

router.post("/prompt", async (req, res) => {
  const { prompt, model, mode, workspace, workspaceSlug, chatId, outputFormat } = req.body ?? {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({
      ok: false,
      error: "prompt is required",
    });
  }

  const validModes = ["agent", "ask", "plan"];
  const resolvedMode = validModes.includes(mode) ? mode : "agent";

  // Prefer workspaceSlug (Cursor slug) over raw workspace path.
  // Resolve slug → real filesystem path so the agent CLI can use it.
  let resolvedWorkspace = workspace || null;
  if (workspaceSlug) {
    const overrides = await readWorkspaceConfig();
    const path = await resolveWorkspacePath(workspaceSlug, overrides);
    if (!path) {
      return res.status(400).json({
        ok: false,
        error: `Could not resolve workspace path for "${workspaceSlug}". Add a path override in data/workspaces.json.`,
      });
    }
    resolvedWorkspace = path;
  }

  const result = await sendPrompt({
    prompt: prompt.trim(),
    model,
    mode: resolvedMode,
    workspace: resolvedWorkspace,
    chatId,
    outputFormat: outputFormat === "json" ? "json" : "text",
  });

  res.status(result.ok ? 200 : 502).json(result);
});

export default router;
