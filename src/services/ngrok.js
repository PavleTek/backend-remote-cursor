import { spawn } from "node:child_process";

const NGROK_BIN = process.env.NGROK_BIN || "ngrok";
const NGROK_API = process.env.NGROK_API || "http://127.0.0.1:4040";

let ngrokProcess = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTunnels() {
  const response = await fetch(`${NGROK_API}/api/tunnels`);
  if (!response.ok) throw new Error(`ngrok API returned ${response.status}`);
  return response.json();
}

function pickPublicUrl(tunnels, port) {
  const list = tunnels.tunnels ?? [];
  const portStr = String(port);

  const match =
    list.find((t) => t.proto === "https" && t.config?.addr?.includes(portStr)) ||
    list.find((t) => t.proto === "https") ||
    list.find((t) => t.public_url?.startsWith("https://")) ||
    list[0];

  return match?.public_url?.replace(/\/$/, "") ?? null;
}

export async function getExistingNgrokUrl(port) {
  try {
    const data = await fetchTunnels();
    return pickPublicUrl(data, port);
  } catch {
    return null;
  }
}

export function startNgrokProcess(port) {
  if (ngrokProcess) return ngrokProcess;

  ngrokProcess = spawn(NGROK_BIN, ["http", String(port)], {
    stdio: "ignore",
    detached: false,
  });

  ngrokProcess.on("error", (err) => {
    console.error("Failed to start ngrok:", err.message);
  });

  ngrokProcess.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`ngrok exited with code ${code}`);
    }
    ngrokProcess = null;
  });

  return ngrokProcess;
}

export async function waitForNgrokUrl(port, { maxAttempts = 40, intervalMs = 500 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const url = await getExistingNgrokUrl(port);
    if (url) return url;
    await sleep(intervalMs);
  }

  throw new Error("Timed out waiting for ngrok public URL");
}

export function stopNgrok() {
  if (ngrokProcess) {
    ngrokProcess.kill("SIGTERM");
    ngrokProcess = null;
  }
}
