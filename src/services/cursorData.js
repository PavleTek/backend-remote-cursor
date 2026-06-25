import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { createInterface } from "node:readline";
import { readWorkspaceConfig } from "./workspacesConfig.js";

export const CURSOR_PROJECTS_DIR = join(homedir(), ".cursor/projects");

// UUID-like pattern (also accept simple alphanumeric chat IDs from agent create-chat)
const SAFE_CHAT_ID = /^[a-zA-Z0-9_-]{1,128}$/;

// ── Slug helpers ──────────────────────────────────────────────────────────────

/**
 * Convert a Cursor project slug back to an absolute filesystem path.
 * Strategy: try all possible splits of the slug's `-`-separated tokens into
 * path segments by checking which combinations exist on disk.
 * Falls back to a curated override `path` field.
 */
export async function resolveWorkspacePath(slug, overrides = {}) {
  if (overrides[slug]?.path) return overrides[slug].path;

  if (slug.endsWith("-code-workspace")) {
    const fromCodeWorkspace = await resolveCodeWorkspacePath(slug);
    if (fromCodeWorkspace) return fromCodeWorkspace;
  }

  if (slug.endsWith("-workspace-json")) {
    const fromWorkspaceJson = await resolveWorkspaceJsonPath(slug);
    if (fromWorkspaceJson) return fromWorkspaceJson;
  }

  const tokens = slug.split("-");
  const found = await greedyResolve(tokens, sep);
  return found;
}

async function resolveCodeWorkspacePath(slug) {
  const prefix = slug.slice(0, -"-code-workspace".length);
  const tokens = prefix.split("-");
  if (tokens.length < 2) return null;

  // Try longest filename bases first (e.g. pavletek-full-stak before stak)
  for (let fileLen = tokens.length - 1; fileLen >= 1; fileLen--) {
    const fileBase = tokens.slice(-fileLen).join("-");
    const parentTokens = tokens.slice(0, -fileLen);
    const parentDir =
      parentTokens.length === 0 ? sep : await greedyResolve(parentTokens, sep);
    if (!parentDir) continue;

    const candidate = join(parentDir, `${fileBase}.code-workspace`);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // try shorter/longer base
    }
  }

  return null;
}

async function resolveWorkspaceJsonPath(slug) {
  const match = slug.match(/-(\d+)-workspace-json$/);
  if (!match) return null;

  const jsonPath = join(
    homedir(),
    "Library/Application Support/Cursor/Workspaces",
    match[1],
    "workspace.json",
  );

  try {
    await stat(jsonPath);
    return jsonPath;
  } catch {
    return null;
  }
}

async function greedyResolve(tokens, current) {
  if (tokens.length === 0) return current;

  // Try joining tokens 1..N into one segment
  for (let len = tokens.length; len >= 1; len--) {
    const segment = tokens.slice(0, len).join("-");
    const candidate = join(current, segment);
    let exists = false;
    try {
      await stat(candidate);
      exists = true;
    } catch {
      // not found
    }
    if (exists) {
      const rest = await greedyResolve(tokens.slice(len), candidate);
      if (rest !== null) return rest;
    }
  }
  return null;
}

/**
 * Produce a human-readable label from a slug, optionally using a resolved path.
 */
export function slugToLabel(slug, overrides = {}, resolvedPath = null) {
  if (overrides[slug]?.label) return overrides[slug].label;

  const fromPath = labelFromResolvedPath(resolvedPath);
  if (fromPath) return fromPath;

  return slugToLabelFromSlug(slug);
}

function slugToLabelFromSlug(slug) {
  if (slug.startsWith("var-folders-")) return slug;

  if (slug.endsWith("-code-workspace")) {
    const prefix = slug.slice(0, -"-code-workspace".length);
    const tokens = prefix.split("-");
    const fileBase = tokens[tokens.length - 1];
    if (fileBase.length > 3 || /[A-Z]/.test(fileBase)) {
      return humanizeName(fileBase);
    }
    const parentToken = tokens[tokens.length - 2];
    if (parentToken) {
      return `${humanizeName(parentToken)} (${fileBase})`;
    }
    return humanizeName(fileBase);
  }

  if (slug.endsWith("-workspace-json")) {
    const match = slug.match(/-(\d+)-workspace-json$/);
    return match ? `Cursor Workspace ${match[1]}` : slug.replace(/-workspace-json$/, "");
  }

  const tokens = slug.split("-");
  const meaningful = tokens.filter((t) => t.length > 2 && /[a-z]/i.test(t));
  if (meaningful.length === 0) return slug;

  return humanizeName(meaningful.slice(-2).join("-"));
}

function humanizeName(name) {
  return name
    .replace(/-/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function labelFromResolvedPath(resolvedPath) {
  if (!resolvedPath) return null;

  if (resolvedPath.endsWith(".code-workspace")) {
    const fileBase = basename(resolvedPath, ".code-workspace");
    const parentName = basename(dirname(resolvedPath));
    const fileLabel = humanizeName(fileBase);

    if (fileBase.length <= 3 || /^[a-z]{1,3}$/i.test(fileBase)) {
      return `${humanizeName(parentName)} (${fileBase})`;
    }
    return fileLabel;
  }

  if (resolvedPath.endsWith("workspace.json")) {
    return null; // filled in async via labelFromWorkspaceJson
  }

  return humanizeName(basename(resolvedPath));
}

async function labelFromWorkspaceJson(jsonPath) {
  try {
    const raw = await readFile(jsonPath, "utf8");
    const data = JSON.parse(raw);
    const folders = (data.folders ?? [])
      .map((f) => f.path)
      .filter((p) => typeof p === "string" && p.trim());

    if (folders.length === 0) {
      return `Cursor Workspace ${basename(dirname(jsonPath))}`;
    }
    if (folders.length === 1) {
      return humanizeName(basename(folders[0]));
    }

    const names = folders.map((f) => humanizeName(basename(f)));
    if (names.length === 2) return `${names[0]} + ${names[1]}`;
    return `${names[0]} (+${names.length - 1})`;
  } catch {
    return null;
  }
}

export async function resolveWorkspaceMeta(slug, overrides = {}) {
  if (overrides[slug]?.label) {
    const path = await resolveWorkspacePath(slug, overrides);
    return { path, label: overrides[slug].label };
  }

  const path = await resolveWorkspacePath(slug, overrides);

  if (path?.endsWith("workspace.json")) {
    const jsonLabel = await labelFromWorkspaceJson(path);
    if (jsonLabel) return { path, label: jsonLabel };
  }

  const label = slugToLabel(slug, overrides, path);
  return { path, label };
}

/**
 * Classify a slug as "workspace", "code-workspace", or "project".
 */
export function classifySlug(slug) {
  if (slug.endsWith("-code-workspace") || slug.endsWith("-workspace-json")) {
    return "workspace";
  }
  return "project";
}

/**
 * Return true for slugs we want to hide (temp dirs, etc.).
 */
function isHiddenSlug(slug, overrides = {}) {
  if (overrides[slug]?.hidden === true) return true;
  if (slug.startsWith("var-folders-")) return true;
  if (slug.startsWith("Users-pavle-Library-")) return true;
  return false;
}

// ── Directory helpers ─────────────────────────────────────────────────────────

async function listTranscriptDirs(transcriptsDir) {
  try {
    const entries = await readdir(transcriptsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * List all discovered workspaces/projects under ~/.cursor/projects,
 * merged with curated overrides.
 *
 * @returns {Promise<Array<{
 *   slug: string,
 *   label: string,
 *   path: string|null,
 *   type: "workspace"|"project",
 *   chatCount: number,
 *   lastActivity: string|null,
 *   pinned: boolean,
 * }>>}
 */
export async function listWorkspaces() {
  const overrides = await readWorkspaceConfig();
  let slugs;
  try {
    const entries = await readdir(CURSOR_PROJECTS_DIR, { withFileTypes: true });
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const results = await Promise.all(
    slugs.map(async (slug) => {
      if (isHiddenSlug(slug, overrides)) return null;

      const transcriptsDir = join(CURSOR_PROJECTS_DIR, slug, "agent-transcripts");
      const chatDirs = await listTranscriptDirs(transcriptsDir);
      if (chatDirs.length === 0) return null; // no chats → skip

      let lastActivity = null;
      for (const chatId of chatDirs) {
        const jsonlFile = join(transcriptsDir, chatId, `${chatId}.jsonl`);
        try {
          const st = await stat(jsonlFile);
          const iso = st.mtime.toISOString();
          if (!lastActivity || iso > lastActivity) lastActivity = iso;
        } catch {
          // ignore missing files
        }
      }

      const { path: resolvedPath, label } = await resolveWorkspaceMeta(slug, overrides);

      return {
        slug,
        label,
        path: resolvedPath,
        type: classifySlug(slug),
        chatCount: chatDirs.length,
        lastActivity,
        pinned: overrides[slug]?.pinned === true,
      };
    }),
  );

  const workspaces = results.filter(Boolean);

  // Sort: pinned first, then by lastActivity desc
  workspaces.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (!a.lastActivity) return 1;
    if (!b.lastActivity) return -1;
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  return workspaces;
}

/**
 * List chats, optionally filtered by workspace slug and/or search query.
 *
 * @param {{ workspaceSlug?: string, q?: string, limit?: number }} opts
 * @returns {Promise<Array<{
 *   id: string,
 *   workspaceSlug: string,
 *   workspaceLabel: string,
 *   title: string,
 *   preview: string,
 *   messageCount: number,
 *   updatedAt: string|null,
 * }>>}
 */
export async function listChats({ workspaceSlug, q, limit = 200 } = {}) {
  const overrides = await readWorkspaceConfig();

  let targetSlugs;
  if (workspaceSlug) {
    targetSlugs = [workspaceSlug];
  } else {
    try {
      const entries = await readdir(CURSOR_PROJECTS_DIR, { withFileTypes: true });
      targetSlugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  const allChats = [];
  const metaCache = new Map();

  async function getCachedMeta(slug) {
    if (!metaCache.has(slug)) {
      metaCache.set(slug, resolveWorkspaceMeta(slug, overrides));
    }
    return metaCache.get(slug);
  }

  await Promise.all(
    targetSlugs.map(async (slug) => {
      if (isHiddenSlug(slug, overrides)) return;

      const transcriptsDir = join(CURSOR_PROJECTS_DIR, slug, "agent-transcripts");
      const chatDirs = await listTranscriptDirs(transcriptsDir);

      await Promise.all(
        chatDirs.map(async (chatId) => {
          if (!SAFE_CHAT_ID.test(chatId)) return;

          const jsonlFile = join(transcriptsDir, chatId, `${chatId}.jsonl`);
          let updatedAt = null;
          try {
            const st = await stat(jsonlFile);
            updatedAt = st.mtime.toISOString();
          } catch {
            return; // file doesn't exist
          }

          let title = "";
          let preview = "";
          let messageCount = 0;

          try {
            const lines = await readJsonlLines(jsonlFile, 20);
            for (const obj of lines) {
              if (obj.role === "user" || obj.role === "assistant") {
                const text = extractText(obj);
                if (!text) continue;
                messageCount++;
                if (!title && obj.role === "user") {
                  title = cleanUserText(text);
                }
                if (!preview && obj.role === "assistant") {
                  preview = stripRedacted(text).slice(0, 120);
                }
              }
            }
          } catch {
            // unreadable — include with empty title
          }

          allChats.push({
            id: chatId,
            workspaceSlug: slug,
            workspaceLabel: (await getCachedMeta(slug)).label,
            title: title || chatId,
            preview,
            messageCount,
            updatedAt,
          });
        }),
      );
    }),
  );

  // Filter by search query
  let filtered = allChats;
  if (q && q.trim()) {
    const lower = q.trim().toLowerCase();
    filtered = allChats.filter(
      (c) =>
        c.title.toLowerCase().includes(lower) ||
        c.preview.toLowerCase().includes(lower) ||
        c.id.toLowerCase().includes(lower) ||
        c.workspaceLabel.toLowerCase().includes(lower),
    );
  }

  // Sort newest first
  filtered.sort((a, b) => {
    if (!a.updatedAt) return 1;
    if (!b.updatedAt) return -1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });

  return filtered.slice(0, limit);
}

/**
 * Load the full transcript for a single chat.
 *
 * @param {{ workspaceSlug: string, chatId: string }} opts
 * @returns {Promise<{ id: string, workspaceSlug: string, messages: Array<{role:string,text:string}> }>}
 */
export async function getChatTranscript({ workspaceSlug, chatId }) {
  if (!SAFE_CHAT_ID.test(chatId)) {
    throw Object.assign(new Error("Invalid chatId"), { status: 400 });
  }
  if (!workspaceSlug || typeof workspaceSlug !== "string") {
    throw Object.assign(new Error("workspaceSlug is required"), { status: 400 });
  }

  const jsonlFile = join(
    CURSOR_PROJECTS_DIR,
    workspaceSlug,
    "agent-transcripts",
    chatId,
    `${chatId}.jsonl`,
  );

  let fileStat;
  try {
    fileStat = await lstat(jsonlFile);
  } catch {
    throw Object.assign(new Error("Chat not found"), { status: 404 });
  }

  if (!fileStat.isFile()) {
    throw Object.assign(new Error("Chat not found"), { status: 404 });
  }

  const lines = await readJsonlLines(jsonlFile);
  const messages = [];

  for (const obj of lines) {
    if (obj.role !== "user" && obj.role !== "assistant") continue;
    const text = extractText(obj);
    if (!text) continue;
    const cleaned = obj.role === "user" ? cleanUserText(text) : stripRedacted(text);
    if (cleaned) {
      messages.push({ role: obj.role, text: cleaned });
    }
  }

  return { id: chatId, workspaceSlug, messages };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Read all (or up to maxLines) JSONL lines from a file. */
async function readJsonlLines(filePath, maxLines = Infinity) {
  return new Promise((resolve, reject) => {
    const results = [];
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (results.length >= maxLines) {
        rl.close();
        stream.destroy();
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        results.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    });

    rl.on("close", () => resolve(results));
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

/** Extract plain text from a JSONL message object. */
function extractText(obj) {
  const content = obj.message?.content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      return part.text.trim();
    }
  }
  return "";
}

/** Strip <user_query> wrapper tags that the agent injects. */
function cleanUserText(text) {
  return text
    .replace(/<user_query>\s*/gi, "")
    .replace(/\s*<\/user_query>/gi, "")
    .trim();
}

/** Strip the [REDACTED] metadata footer that Cursor appends. */
function stripRedacted(text) {
  return text.replace(/\[REDACTED\][\s\S]*$/, "").trim();
}
