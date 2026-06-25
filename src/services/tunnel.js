import { buildConnectUrl } from "./connectLink.js";
import {
  getExistingNgrokUrl,
  startNgrokProcess,
  stopNgrok,
  waitForNgrokUrl,
} from "./ngrok.js";
import { getQrCodePath, showConnectQrInPreview } from "./qrDisplay.js";
import { getTunnelState, setTunnelState } from "./tunnelState.js";

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
    ngrokUrl,
    connectUrl,
    ready: true,
  });

  console.log("");
  console.log("── Remote Cursor ──────────────────────────");
  console.log(`  Backend (ngrok):  ${ngrokUrl}`);
  console.log(`  Phone link:       ${connectUrl}`);
  console.log("───────────────────────────────────────────");
  console.log("");

  if (process.env.SKIP_QR !== "true") {
    try {
      await showConnectQrInPreview(connectUrl);
      console.log(`QR code saved to ${getQrCodePath()} and opened in Preview`);
    } catch (error) {
      console.warn("Could not open QR in Preview:", error.message);
      console.log("Scan this URL manually:", connectUrl);
    }
  }

  return getTunnelState();
}

export function shutdownTunnel() {
  stopNgrok();
  setTunnelState({ ngrokUrl: null, connectUrl: null, ready: false });
}
