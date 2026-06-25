import { getLocalBackendUrl, isDev } from "../config.js";
import { buildConnectUrl } from "./connectLink.js";
import {
  getExistingNgrokUrl,
  startNgrokProcess,
  stopNgrok,
  waitForNgrokUrl,
} from "./ngrok.js";
import { getQrCodePath, showConnectQrInPreview } from "./qrDisplay.js";
import { getTunnelState, setTunnelState } from "./tunnelState.js";

async function showConnectQr(connectUrl, label) {
  if (process.env.SKIP_QR === "true") return;

  try {
    await showConnectQrInPreview(connectUrl);
    console.log(`${label} saved to ${getQrCodePath()} and opened in Preview`);
  } catch (error) {
    console.warn("Could not open QR in Preview:", error.message);
    console.log("Open this URL manually:", connectUrl);
  }
}

function logConnectBanner({ mode, backendUrl, connectUrl }) {
  console.log("");
  console.log("── Remote Cursor ──────────────────────────");
  console.log(`  Mode:             ${mode}`);
  console.log(`  Backend:          ${backendUrl}`);
  console.log(`  Connect link:     ${connectUrl}`);
  console.log("───────────────────────────────────────────");
  console.log("");
}

export async function startLocalDevConnect() {
  const backendUrl = getLocalBackendUrl();
  const connectUrl = buildConnectUrl(backendUrl);

  setTunnelState({
    dev: true,
    backendUrl,
    ngrokUrl: null,
    connectUrl,
    ready: true,
  });

  logConnectBanner({
    mode: "DEV (localhost)",
    backendUrl,
    connectUrl,
  });

  await showConnectQr(connectUrl, "QR code");
  return getTunnelState();
}

export async function startTunnel(port) {
  console.log("Starting ngrok tunnel…");

  let ngrokUrl = await getExistingNgrokUrl(port);

  if (!ngrokUrl) {
    startNgrokProcess(port);
    ngrokUrl = await waitForNgrokUrl(port);
  } else {
    console.log("Reusing existing ngrok tunnel");
  }

  const connectUrl = buildConnectUrl(ngrokUrl);

  setTunnelState({
    dev: false,
    backendUrl: ngrokUrl,
    ngrokUrl,
    connectUrl,
    ready: true,
  });

  logConnectBanner({
    mode: "Production (ngrok)",
    backendUrl: ngrokUrl,
    connectUrl,
  });

  await showConnectQr(connectUrl, "QR code");
  return getTunnelState();
}

export async function startConnect(port) {
  if (isDev()) {
    return startLocalDevConnect();
  }
  return startTunnel(port);
}

export function shutdownTunnel() {
  if (!isDev()) {
    stopNgrok();
  }
  setTunnelState({
    dev: false,
    backendUrl: null,
    ngrokUrl: null,
    connectUrl: null,
    ready: false,
  });
}
