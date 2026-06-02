import type { Request, Response, NextFunction } from "express";
import { config } from "./config.js";

export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  return config.corsOrigins.some((allowed) => normalized === allowed);
}

export function setCorsHeaders(res: Response, origin: string | undefined): void {
  if (!origin || !isAllowedOrigin(origin)) return;
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

/** CORS на каждый ответ + надёжный preflight для Vercel serverless. */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;

  if (typeof origin === "string" && isAllowedOrigin(origin)) {
    setCorsHeaders(res, origin);
  }

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
}
