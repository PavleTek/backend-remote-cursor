import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

const AGENT_PATH = process.env.AGENT_PATH || "agent";
const INIT_TIMEOUT_MS = 30_000;

function isFilePath(p) {
  return p.endsWith(".code-workspace") || p.endsWith(".json");
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

function formatJsonRpcError(error) {
  const message = error?.message ?? "ACP request failed";
  const details = error?.data;
  if (!details) return new Error(message);
  if (typeof details === "string") return new Error(`${message}: ${details}`);
  if (Array.isArray(details) && details.length > 0) {
    const summary = details
      .map((item) => item?.message ?? item?.path?.join?.(".") ?? JSON.stringify(item))
      .filter(Boolean)
      .join("; ");
    return new Error(summary ? `${message}: ${summary}` : message);
  }
  if (typeof details === "object" && details.message) {
    return new Error(`${message}: ${details.message}`);
  }
  return new Error(message);
}

/**
 * Thin JSON-RPC 2.0 client over stdio that speaks the Cursor ACP protocol.
 *
 * Emits:
 *   "session"   { chatId, model }
 *   "text"      { delta }
 *   "plan"      { requestId, _jsonrpcId, name, overview, plan, todos, phases? }  — blocking
 *   "question"  { requestId, _jsonrpcId, title?, questions[] }                   — blocking
 *   "todos"     { todos[], merge }
 *   "done"      { stopReason }
 *   "error"     { error }
 */
export class AcpClient extends EventEmitter {
  #child = null;
  #nextId = 1;
  #pending = new Map(); // jsonrpcId -> { resolve, reject }
  #sessionId = null;

  constructor() {
    super();
  }

  /**
   * Spawn the agent acp subprocess. Must be called before runSession.
   */
  spawn({ workspace } = {}) {
    const workspaceDir =
      workspace && isFilePath(workspace) ? dirname(workspace) : workspace;

    this.#child = spawn(AGENT_PATH, ["acp"], {
      stdio: ["pipe", "pipe", "inherit"],
      cwd: workspaceDir || undefined,
      env: process.env,
    });

    const rl = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        this.#handleMessage(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    });

    this.#child.on("error", (err) => {
      this.emit("error", { error: err.message });
    });

    this.#child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        this.emit("error", { error: `Agent process exited with code ${code}` });
      }
    });

    return this;
  }

  /**
   * Send a JSON-RPC request. Returns a Promise resolved with the result.
   */
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve, reject });
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /**
   * Write a JSON-RPC success response to an inbound blocking request.
   */
  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  /**
   * Kill the subprocess.
   */
  kill() {
    if (this.#child) {
      try {
        this.#child.stdin.end();
        this.#child.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.#child = null;
    }
  }

  get sessionId() {
    return this.#sessionId;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  #write(obj) {
    if (!this.#child?.stdin?.writable) return;
    try {
      this.#child.stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      // stdin may be closed
    }
  }

  #handleMessage(msg) {
    // JSON-RPC response to one of our outbound requests
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      const waiter = this.#pending.get(msg.id);
      if (waiter) {
        this.#pending.delete(msg.id);
        msg.error
          ? waiter.reject(formatJsonRpcError(msg.error))
          : waiter.resolve(msg.result);
      }
      return;
    }

    if (!msg.method) return;

    const { method, params, id } = msg;

    switch (method) {
      case "session/update":
        this.#onSessionUpdate(params);
        break;

      case "session/request_permission":
        // Auto-allow all tool permissions (mirrors --force)
        if (id !== undefined) {
          this.respond(id, { outcome: { outcome: "selected", optionId: "allow-once" } });
        }
        break;

      case "cursor/ask_question":
        this.emit("question", {
          requestId: params?.toolCallId,
          _jsonrpcId: id,
          title: params?.title ?? null,
          questions: params?.questions ?? [],
        });
        break;

      case "cursor/create_plan":
        this.emit("plan", {
          requestId: params?.toolCallId,
          _jsonrpcId: id,
          name: params?.name ?? "",
          overview: params?.overview ?? "",
          plan: params?.plan ?? "",
          todos: params?.todos ?? [],
          phases: params?.phases ?? null,
        });
        break;

      case "cursor/update_todos":
        // Notification — no response needed
        this.emit("todos", {
          todos: params?.todos ?? [],
          merge: params?.merge ?? true,
        });
        break;

      // cursor/task and cursor/generate_image are fire-and-forget; ignore silently
      default:
        break;
    }
  }

  #onSessionUpdate(params) {
    const update = params?.update;
    if (!update) return;

    if (update.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      this.emit("text", { delta: update.content.text });
    }
  }

  /**
   * Run the full ACP handshake and prompt for one turn:
   *   initialize → authenticate → session/new|load → session/prompt
   *
   * Resolves when the agent finishes the turn (stopReason).
   * Emits streaming events while running.
   */
  async runSession({ prompt, mode, model, workspace, chatId }) {
    const workspaceDir =
      workspace && isFilePath(workspace) ? dirname(workspace) : workspace;

    // 1. initialize
    await withTimeout(
      this.send("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "remote-cursor-backend", version: "1.0.0" },
      }),
      INIT_TIMEOUT_MS,
      "ACP initialize timed out",
    );

    // 2. authenticate
    await withTimeout(
      this.send("authenticate", { methodId: "cursor_login" }),
      INIT_TIMEOUT_MS,
      "ACP authenticate timed out",
    );

    // 3. session/new or session/load
    const newSessionParams = {
      cwd: workspaceDir || process.cwd(),
      mcpServers: [],
      ...(mode && mode !== "agent" ? { mode } : {}),
      ...(model && model !== "auto" ? { model } : {}),
    };

    let sessionResult;
    if (chatId) {
      try {
        sessionResult = await this.send("session/load", {
          sessionId: chatId,
          cwd: workspaceDir || process.cwd(),
          mcpServers: [],
        });
      } catch {
        // chatId may be a CLI create-chat or transcript id, not an ACP session
        sessionResult = await this.send("session/new", newSessionParams);
      }
    } else {
      sessionResult = await this.send("session/new", newSessionParams);
    }

    this.#sessionId = sessionResult?.sessionId ?? chatId ?? null;
    this.emit("session", {
      chatId: this.#sessionId,
      model: sessionResult?.model ?? model ?? null,
    });

    // 4. session/prompt — resolves when the agent finishes the turn.
    //    While pending, session/update notifications and cursor/* requests arrive.
    const promptResult = await this.send("session/prompt", {
      sessionId: this.#sessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    this.emit("done", { stopReason: promptResult?.stopReason ?? "end_turn" });

    return promptResult;
  }
}
