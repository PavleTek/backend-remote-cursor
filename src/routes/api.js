import { Router } from "express";
import {
  createChat,
  getAgentAbout,
  getAgentStatus,
  listModels,
  sendPrompt,
} from "../services/agentCli.js";
import { getChatTranscript, listChats, listWorkspaces, resolveWorkspacePath } from "../services/cursorData.js";
import {
  getFavoriteModelsEnriched,
  writeFavoriteIds,
} from "../services/favoriteModels.js";
import { getTunnelState } from "../services/tunnelState.js";
import { readWorkspaceConfig, writeWorkspaceConfig } from "../services/workspacesConfig.js";
import { AcpClient } from "../services/acpClient.js";
import {
  addPending,
  cleanupTurn,
  getTurn,
  registerTurn,
  setSessionId,
  takePending,
} from "../services/acpSessions.js";

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

// ── ACP streaming prompt ──────────────────────────────────────────────────────

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

  function sendSse(name, data) {
    if (ended) return;
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function endSse() {
    if (ended) return;
    ended = true;
    res.end();
  }

  function pingSse() {
    if (ended) return;
    res.write(": ping\n\n");
  }

  const client = new AcpClient();
  client.spawn({ workspace: resolvedWorkspace });

  const turnId = registerTurn({ client, sendSse, endSse, pingRes: pingSse });

  // First SSE event carries the turnId so the frontend can address reply endpoints
  sendSse("turn", { turnId });

  // Wire ACP events → SSE events
  client.on("session", ({ chatId: returnedId, model: returnedModel }) => {
    setSessionId(turnId, returnedId);
    sendSse("session", { chatId: returnedId, model: returnedModel });
  });

  client.on("text", ({ delta }) => {
    sendSse("text", { delta });
  });

  client.on("plan", ({ requestId, _jsonrpcId, name, overview, plan, todos, phases }) => {
    addPending(turnId, requestId, _jsonrpcId, "plan");
    sendSse("plan", { requestId, name, overview, plan, todos, phases });
  });

  client.on("question", ({ requestId, _jsonrpcId, title, questions }) => {
    addPending(turnId, requestId, _jsonrpcId, "question");
    sendSse("question", { requestId, title, questions });
  });

  client.on("todos", ({ todos, merge }) => {
    sendSse("todos", { todos, merge });
  });

  client.on("done", ({ stopReason }) => {
    sendSse("done", { result: stopReason ?? "end_turn", ok: true });
    endSse();
    cleanupTurn(turnId);
  });

  client.on("error", ({ error }) => {
    sendSse("error", { error });
    endSse();
    cleanupTurn(turnId);
  });

  res.on("close", () => {
    if (ended) return;
    ended = true;
    cleanupTurn(turnId);
  });

  // Start the ACP session — the promise resolves/rejects after the agent finishes
  client.runSession({
    prompt: prompt.trim(),
    mode: resolvedMode,
    model,
    workspace: resolvedWorkspace,
    chatId,
  }).catch((err) => {
    sendSse("error", { error: err.message ?? "ACP session error" });
    endSse();
    cleanupTurn(turnId);
  });
});

// ── ACP reply endpoints ───────────────────────────────────────────────────────

/**
 * POST /api/acp/respond
 * Submit the user's answers to a pending cursor/ask_question blocking request.
 *
 * Body: { turnId, requestId, answers: [{ questionId, selectedOptionIds[] }] }
 */
router.post("/acp/respond", (req, res) => {
  const { turnId, requestId, answers } = req.body ?? {};

  if (!turnId || !requestId) {
    return res.status(400).json({ ok: false, error: "turnId and requestId are required" });
  }

  const turn = getTurn(turnId);
  if (!turn) {
    return res.status(404).json({ ok: false, error: "Turn not found or already completed" });
  }

  const pending = takePending(turnId, requestId);
  if (!pending) {
    return res.status(404).json({ ok: false, error: "No pending question for that requestId" });
  }

  turn.client.respond(pending.jsonrpcId, {
    outcome: {
      outcome: "answered",
      answers: answers ?? [],
    },
  });

  res.json({ ok: true });
});

/**
 * POST /api/acp/plan-decision
 * Accept or reject a pending cursor/create_plan blocking request.
 *
 * Body: { turnId, requestId, decision: "accepted"|"rejected", reason?: string }
 */
router.post("/acp/plan-decision", (req, res) => {
  const { turnId, requestId, decision, reason } = req.body ?? {};

  if (!turnId || !requestId) {
    return res.status(400).json({ ok: false, error: "turnId and requestId are required" });
  }
  if (!["accepted", "rejected"].includes(decision)) {
    return res.status(400).json({ ok: false, error: "decision must be 'accepted' or 'rejected'" });
  }

  const turn = getTurn(turnId);
  if (!turn) {
    return res.status(404).json({ ok: false, error: "Turn not found or already completed" });
  }

  const pending = takePending(turnId, requestId);
  if (!pending) {
    return res.status(404).json({ ok: false, error: "No pending plan for that requestId" });
  }

  const outcome =
    decision === "accepted"
      ? { outcome: "accepted" }
      : { outcome: "rejected", reason: reason ?? "" };

  turn.client.respond(pending.jsonrpcId, { outcome });

  res.json({ ok: true });
});

/**
 * POST /api/acp/cancel
 * Cancel an active turn and terminate its agent subprocess.
 *
 * Body: { turnId }
 */
router.post("/acp/cancel", async (req, res) => {
  const { turnId } = req.body ?? {};

  if (!turnId) {
    return res.status(400).json({ ok: false, error: "turnId is required" });
  }

  const turn = getTurn(turnId);
  if (!turn) {
    return res.status(404).json({ ok: false, error: "Turn not found or already completed" });
  }

  // Send session/cancel if we have a session id
  if (turn.sessionId) {
    try {
      await turn.client.send("session/cancel", { sessionId: turn.sessionId });
    } catch {
      // ignore — we'll kill regardless
    }
  }

  try { turn.endSse(); } catch { /* ignore */ }
  cleanupTurn(turnId);

  res.json({ ok: true });
});

// ── Non-streaming prompt (unchanged) ─────────────────────────────────────────

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
