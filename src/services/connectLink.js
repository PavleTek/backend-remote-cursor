import { getFrontendBaseUrl } from "../config.js";

export function buildConnectUrl(backendUrl) {
  const frontendBase = getFrontendBaseUrl();
  const params = new URLSearchParams();
  params.set("backend", backendUrl);
  return `${frontendBase}/connect?${params.toString()}`;
}
