import { timingSafeEqual } from "crypto";
import { getApiKey } from "../config.js";

function keysMatch(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function requireApiKey(req, res, next) {
  const expected = getApiKey();
  if (!expected) {
    return next();
  }

  const provided = req.get("X-API-Key") ?? "";
  if (!provided || !keysMatch(provided, expected)) {
    return res.status(401).json({ ok: false, error: "Invalid or missing API key" });
  }

  next();
}
