/**
 * Point this at your deployed Cloudflare Worker.
 * After `wrangler deploy`, replace the value below with the Worker URL it prints,
 * e.g. "https://my-train-api.<your-subdomain>.workers.dev".
 * For local development against `wrangler dev`, use "http://localhost:8787".
 */
window.MYTRAIN_CONFIG = {
  API_BASE: "https://my-train-api.example.workers.dev",
};
