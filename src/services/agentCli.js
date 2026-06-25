import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AGENT_PATH = process.env.AGENT_PATH || "agent";
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Run the Cursor Agent CLI with the given arguments.
 * Uses --print for headless/script-friendly output where applicable.
 */
export async function runAgent(args, options = {}) {
  const { timeout = DEFAULT_TIMEOUT_MS, cwd } = options;

  try {
    const { stdout, stderr } = await execFileAsync(AGENT_PATH, args, {
      timeout,
      cwd,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.trim() ?? "",
      stderr: error.stderr?.trim() ?? error.message,
      exitCode: error.code ?? 1,
    };
  }
}

export async function getAgentStatus() {
  const result = await runAgent(["status"]);
  return {
    ...result,
    data: parsePlainText(result.stdout),
  };
}

export async function getAgentAbout() {
  const result = await runAgent(["about"]);
  return {
    ...result,
    data: parseKeyValueLines(result.stdout),
  };
}

export async function listModels() {
  const result = await runAgent(["models"]);
  const models = [];
  const cleaned = stripAnsi(result.stdout);

  for (const line of cleaned.split("\n")) {
    const match = line.trim().match(/^(\S+)\s+-\s+(.+)$/);
    if (match) {
      models.push({ id: match[1], label: match[2].trim() });
    }
  }

  return {
    ...result,
    stdout: cleaned,
    data: models,
  };
}

export async function createChat() {
  const result = await runAgent(["create-chat"]);
  return {
    ...result,
    data: { chatId: result.stdout.trim() || null },
  };
}

export async function sendPrompt({
  prompt,
  model,
  mode,
  workspace,
  chatId,
  outputFormat = "text",
}) {
  const args = ["--print", "--force", "--output-format", outputFormat];

  if (mode === "ask" || mode === "plan") {
    args.push("--mode", mode);
  }

  if (model && model !== "auto") args.push("--model", model);
  if (workspace) args.push("--workspace", workspace);
  if (chatId) args.push("--resume", chatId);

  args.push(prompt);

  // cwd must be a directory; .code-workspace and workspace.json are files
  const cwd = workspace && isFilePath(workspace) ? dirname(workspace) : workspace;
  const result = await runAgent(args, { cwd });

  let data = stripAnsi(result.stdout);
  if (outputFormat === "json" && result.stdout) {
    try {
      data = JSON.parse(stripAnsi(result.stdout));
    } catch {
      data = stripAnsi(result.stdout);
    }
  }

  return {
    ...result,
    stdout: stripAnsi(result.stdout),
    stderr: stripAnsi(result.stderr),
    data,
  };
}

function isFilePath(p) {
  return p.endsWith(".code-workspace") || p.endsWith(".json");
}

function stripAnsi(text) {
  if (!text) return "";
  return text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();
}

function parseKeyValueLines(text) {
  const entries = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*(.+?)\s{2,}(.+?)\s*$/);
    if (match) {
      const key = match[1].trim().replace(/\s+/g, "_").toLowerCase();
      entries[key] = match[2].trim();
    }
  }
  return entries;
}

function parsePlainText(text) {
  return { raw: text.trim() };
}
