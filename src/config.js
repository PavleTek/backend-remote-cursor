const PORT = Number(process.env.PORT) || 3847;

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

export function isDev() {
  return process.env.DEV === "true";
}

export function getPort() {
  return PORT;
}

export function getFrontendBaseUrl() {
  if (isDev()) {
    return stripTrailingSlash(
      process.env.DEV_FRONTEND_BASE_URL || "http://localhost:5173",
    );
  }

  const base = stripTrailingSlash(process.env.FRONTEND_BASE_URL || "");
  if (!base) {
    throw new Error("FRONTEND_BASE_URL is not set in .env (required when DEV=false)");
  }
  return base;
}

export function getLocalBackendUrl() {
  return `http://localhost:${PORT}`;
}
