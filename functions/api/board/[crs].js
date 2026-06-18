/* GET /api/board/:crs -> live line-up at a station (rtt/location). */
import { proxy, json } from "../_rtt.js";

const isCrs = (s) => /^[A-Za-z]{3}$/.test(s);

export async function onRequestGet(context) {
  const crs = context.params.crs;
  if (!isCrs(crs)) return json({ error: "Invalid station code." }, 400);
  const code = encodeURIComponent(`gb-nr:${crs.toUpperCase()}`);
  return proxy(`/rtt/location?code=${code}`, context.env, context, 30);
}
