import { randomUUID } from "node:crypto";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — reset on every ACP event or user reply
const HEARTBEAT_INTERVAL_MS = 20_000;   // 20 seconds — SSE comment to keep proxies alive

/**
 * In-memory registry of active ACP turns.
 *
 * Each turn represents one open POST /api/prompt/stream SSE response and its
 * associated long-lived agent acp subprocess.
 *
 * Entry shape:
 *   {
 *     client:      AcpClient
 *     sessionId:   string | null
 *     pending:     Map<requestId, { jsonrpcId, type: "question" | "plan" }>
 *     sendSse:     (name: string, data: object) => void
 *     endSse:      () => void
 *     idleTimer:   NodeJS.Timeout
 *     heartbeat:   NodeJS.Timeout
 *   }
 *
 * @type {Map<string, object>}
 */
const registry = new Map();

/**
 * Register a new turn. Returns the assigned turnId.
 *
 * @param {{ client, sendSse, endSse, pingRes }} opts
 *   pingRes — writes a raw `: ping\n\n` SSE comment (no event/data wrapper)
 */
export function registerTurn({ client, sendSse, endSse, pingRes }) {
  const turnId = randomUUID();

  const entry = {
    client,
    sessionId: null,
    pending: new Map(),
    sendSse,
    endSse,
    idleTimer: null,
    heartbeat: null,
  };

  registry.set(turnId, entry);

  entry.heartbeat = setInterval(() => {
    try {
      pingRes();
    } catch {
      cleanupTurn(turnId);
    }
  }, HEARTBEAT_INTERVAL_MS);

  _resetIdleTimer(turnId);

  return turnId;
}

/** @returns {object | null} */
export function getTurn(turnId) {
  return registry.get(turnId) ?? null;
}

/** Store the ACP session id on the turn entry. */
export function setSessionId(turnId, sessionId) {
  const entry = registry.get(turnId);
  if (entry) entry.sessionId = sessionId;
}

/**
 * Register a pending blocking request awaiting user input.
 * Returns false if the turn is not found.
 */
export function addPending(turnId, requestId, jsonrpcId, type) {
  const entry = registry.get(turnId);
  if (!entry) return false;
  entry.pending.set(requestId, { jsonrpcId, type });
  _resetIdleTimer(turnId);
  return true;
}

/**
 * Remove and return a pending entry by requestId.
 * Returns null if not found (already answered / turn gone).
 */
export function takePending(turnId, requestId) {
  const entry = registry.get(turnId);
  if (!entry) return null;
  const item = entry.pending.get(requestId);
  if (!item) return null;
  entry.pending.delete(requestId);
  _resetIdleTimer(turnId);
  return item;
}

/**
 * Kill the subprocess, clear timers, remove from registry.
 * Safe to call multiple times.
 */
export function cleanupTurn(turnId) {
  const entry = registry.get(turnId);
  if (!entry) return;

  clearTimeout(entry.idleTimer);
  clearInterval(entry.heartbeat);
  entry.idleTimer = null;
  entry.heartbeat = null;

  try { entry.client.kill(); } catch { /* ignore */ }

  registry.delete(turnId);
}

// ─── Private ─────────────────────────────────────────────────────────────────

function _resetIdleTimer(turnId) {
  const entry = registry.get(turnId);
  if (!entry) return;

  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const e = registry.get(turnId);
    if (!e) return;

    // Cancel any pending blocking requests gracefully so the agent process can exit
    for (const [, { jsonrpcId }] of e.pending) {
      try {
        e.client.respond(jsonrpcId, { outcome: { outcome: "cancelled" } });
      } catch { /* ignore */ }
    }
    e.pending.clear();

    try { e.sendSse("error", { error: "Timed out waiting for user input." }); } catch { /* ignore */ }
    try { e.endSse(); } catch { /* ignore */ }
    cleanupTurn(turnId);
  }, IDLE_TIMEOUT_MS);
}
