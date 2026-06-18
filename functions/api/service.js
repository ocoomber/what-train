/* GET /api/service?uid=<uniqueIdentity> -> service detail (rtt/service). */
import { proxy, json } from "./_rtt.js";

const isUid = (s) => /^[A-Za-z0-9:_-]{5,48}$/.test(s) && s.includes(":");

export async function onRequestGet(context) {
  const uid = new URL(context.request.url).searchParams.get("uid") || "";
  if (!isUid(uid)) return json({ error: "Invalid service identity." }, 400);
  return proxy(`/rtt/service?uniqueIdentity=${encodeURIComponent(uid)}`, context.env, context, 30);
}
