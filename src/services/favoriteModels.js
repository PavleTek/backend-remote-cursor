import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listModels } from "./agentCli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FAVORITES = ["composer-2.5-fast", "composer-2.5"];

const favoritesPath =
  process.env.FAVORITE_MODELS_PATH ||
  join(__dirname, "../../data/favorite-models.json");

async function ensureFavoritesFile() {
  try {
    await readFile(favoritesPath, "utf8");
  } catch {
    await mkdir(dirname(favoritesPath), { recursive: true });
    await writeFile(
      favoritesPath,
      JSON.stringify({ favorites: DEFAULT_FAVORITES }, null, 2),
      "utf8",
    );
  }
}

export async function readFavoriteIds() {
  await ensureFavoritesFile();
  const raw = await readFile(favoritesPath, "utf8");
  const parsed = JSON.parse(raw);
  const ids = Array.isArray(parsed.favorites) ? parsed.favorites : [];
  return ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
}

export async function writeFavoriteIds(favorites) {
  if (!Array.isArray(favorites)) {
    throw new Error("favorites must be an array");
  }

  const cleaned = [];
  const seen = new Set();
  for (const id of favorites) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }

  await mkdir(dirname(favoritesPath), { recursive: true });
  await writeFile(
    favoritesPath,
    JSON.stringify({ favorites: cleaned }, null, 2),
    "utf8",
  );

  return cleaned;
}

function labelForId(id, catalog) {
  const match = catalog.find((m) => m.id === id);
  if (match) return match.label;
  return id;
}

export async function getFavoriteModelsEnriched() {
  const favoriteIds = await readFavoriteIds();
  const modelsResult = await listModels();
  const catalog = modelsResult.ok && Array.isArray(modelsResult.data) ? modelsResult.data : [];

  const favorites = favoriteIds.map((id) => ({
    id,
    label: labelForId(id, catalog),
  }));

  return {
    favoriteIds,
    favorites,
    catalog,
  };
}
