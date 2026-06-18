/* GET /api/health -> liveness check (no RTT call, no token needed). */
import { json } from "./_rtt.js";

export async function onRequestGet() {
  return json({ ok: true });
}
