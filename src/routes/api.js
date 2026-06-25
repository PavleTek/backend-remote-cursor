import { Router } from "express";
import {
  createChat,
  getAgentAbout,
  getAgentStatus,
  listModels,
  sendPrompt,
} from "../services/agentCli.js";
import { getChatTranscript, listChats, listWorkspaces } from "../services/cursorData.js";
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

router.post("/prompt", async (req, res) => {
  const { prompt, model, mode, workspace, chatId, outputFormat } = req.body ?? {};

  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({
      ok: false,
      error: "prompt is required",
    });
  }

  const validModes = ["agent", "ask", "plan"];
  const resolvedMode = validModes.includes(mode) ? mode : "agent";

  const result = await sendPrompt({
    prompt: prompt.trim(),
    model,
    mode: resolvedMode,
    workspace,
    chatId,
    outputFormat: outputFormat === "json" ? "json" : "text",
  });

  res.status(result.ok ? 200 : 502).json(result);
});

export default router;
