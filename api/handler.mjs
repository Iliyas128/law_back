/**
 * Vercel Serverless: CORS и OPTIONS до import("../dist/server.js"),
 * иначе при падении/долгом cold start preflight без Access-Control-Allow-Origin.
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

function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  return ALLOWED_ORIGINS.has(normalizeOrigin(origin));
}

function setCorsHeaders(res, origin) {
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

export async function vercelHandler(req, res) {
  const origin = req.headers.origin;

  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    setCorsHeaders(res, origin);
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
    console.error("[api/handler]", err);
    if (!res.headersSent) {
      if (typeof origin === "string" && isAllowedOrigin(origin)) {
        setCorsHeaders(res, origin);
      }
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "Internal server error",
          details: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
