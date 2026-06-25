import { getApiKey, getFrontendBaseUrl } from "../config.js";

export function buildConnectUrl(backendUrl) {
  const frontendBase = getFrontendBaseUrl();
  const params = new URLSearchParams();
  params.set("backend", backendUrl);
  const apiKey = getApiKey();
  if (apiKey) {
    params.set("key", apiKey);
  }
  return `${frontendBase}/connect?${params.toString()}`;
}
