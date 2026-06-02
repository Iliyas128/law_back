/**
 * Vercel entry: CORS + OPTIONS до загрузки Express (cold start / 404 без заголовков).
 */
import { createServer } from "@vercel/node";

const REQUIRED_ORIGINS = [
  "https://www.snowtech.asia",
  "https://snowtech.asia",
];

const FALLBACK_ORIGINS = [
  "http://localhost:8080",
  "http://localhost:5173",
  "https://law-front1.vercel.app",
];

function normalizeOrigin(origin) {
  return origin.trim().replace(/\/+$/, "");
}

function buildAllowedOrigins() {
  const fromEnv = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => normalizeOrigin(o))
    .filter(Boolean);
  return new Set([...REQUIRED_ORIGINS, ...FALLBACK_ORIGINS, ...fromEnv]);
}

function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  return buildAllowedOrigins().has(normalizeOrigin(origin));
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

let serverPromise = null;

async function getServer() {
  if (!serverPromise) {
    serverPromise = import("../dist/server.js").then((m) => {
      const app = m.default ?? m.app;
      return createServer(app);
    });
  }
  return serverPromise;
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
    const server = await getServer();
    return server(req, res);
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
