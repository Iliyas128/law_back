/**
 * Vercel Serverless entry. CORS + OPTIONS до import("../dist/server.js").
 */
const ALLOWED_ORIGINS = new Set([
  "https://www.snowtech.asia",
  "https://snowtech.asia",
  "http://localhost:8080",
  "http://localhost:5173",
  "https://law-front1.vercel.app",
]);

function normalizeOrigin(origin) {
  return origin.trim().replace(/\/+$/, "");
}

function mergeOriginsFromEnv() {
  const raw = process.env.CORS_ORIGINS ?? "";
  for (const part of raw.split(",")) {
    const o = normalizeOrigin(part);
    if (o) ALLOWED_ORIGINS.add(o);
  }
}

function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  mergeOriginsFromEnv();
  return ALLOWED_ORIGINS.has(normalizeOrigin(origin));
}

function applyCors(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Accept, X-Requested-With",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
}

let appPromise = null;

function loadApp() {
  if (!appPromise) {
    appPromise = import("../dist/server.js").then((m) => m.default ?? m.app);
  }
  return appPromise;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;

  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    applyCors(res, origin);
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    const app = await loadApp();
    await new Promise((resolve, reject) => {
      app(req, res, (err) => {
        if (err) reject(err);
        else resolve(undefined);
      });
    });
  } catch (err) {
    console.error("[api/index]", err);
    if (!res.headersSent) {
      if (typeof origin === "string" && isAllowedOrigin(origin)) {
        applyCors(res, origin);
      }
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          error: "Internal server error",
          details: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
