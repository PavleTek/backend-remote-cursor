import "dotenv/config";
import cors from "cors";
import express from "express";
import apiRouter from "./routes/api.js";
import { shutdownTunnel, startTunnel } from "./services/tunnel.js";

const app = express();
const PORT = Number(process.env.PORT) || 3847;
const SKIP_NGROK = process.env.SKIP_NGROK === "true";

app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"],
  }),
);
app.use(express.json({ limit: "1mb" }));

app.use("/api", apiRouter);

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

const server = app.listen(PORT, async () => {
  console.log(`Remote Cursor backend listening on http://localhost:${PORT}`);
  console.log(`Agent CLI: ${process.env.AGENT_PATH || "agent"}`);

  if (SKIP_NGROK) {
    console.log("SKIP_NGROK=true — tunnel and QR setup skipped");
    return;
  }

  try {
    await startTunnel(PORT);
  } catch (error) {
    console.error("Tunnel setup failed:", error.message);
    console.error("Set FRONTEND_BASE_URL in .env and ensure ngrok is installed.");
  }
});

function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down…`);
  shutdownTunnel();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
