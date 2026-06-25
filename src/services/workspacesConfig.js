import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const configPath =
  process.env.WORKSPACES_CONFIG_PATH ||
  join(__dirname, "../../data/workspaces.json");

const DEFAULT_CONFIG = { overrides: {} };

async function ensureConfigFile() {
  try {
    await readFile(configPath, "utf8");
  } catch {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
  }
}

/**
 * Read the curated workspace overrides.
 * Returns an object keyed by slug: { label, path, pinned, hidden }
 */
export async function readWorkspaceConfig() {
  await ensureConfigFile();
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw);
  return typeof parsed.overrides === "object" && parsed.overrides !== null
    ? parsed.overrides
    : {};
}

/**
 * Write curated workspace overrides.
 * @param {Record<string, { label?: string, path?: string, pinned?: boolean, hidden?: boolean }>} overrides
 */
export async function writeWorkspaceConfig(overrides) {
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    throw new Error("overrides must be a plain object");
  }

  const cleaned = {};
  for (const [slug, entry] of Object.entries(overrides)) {
    if (typeof slug !== "string" || !slug.trim()) continue;
    const safe = {};
    if (typeof entry.label === "string") safe.label = entry.label.trim();
    if (typeof entry.path === "string") safe.path = entry.path.trim();
    if (typeof entry.pinned === "boolean") safe.pinned = entry.pinned;
    if (typeof entry.hidden === "boolean") safe.hidden = entry.hidden;
    cleaned[slug.trim()] = safe;
  }

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ overrides: cleaned }, null, 2), "utf8");
  return cleaned;
}
