export function buildConnectUrl(ngrokUrl) {
  const frontendBase = (process.env.FRONTEND_BASE_URL || "").replace(/\/+$/, "");
  if (!frontendBase) {
    throw new Error("FRONTEND_BASE_URL is not set in .env");
  }

  const params = new URLSearchParams();
  params.set("backend", ngrokUrl);

  return `${frontendBase}/connect?${params.toString()}`;
}
