import { Router } from "express";
import { promises as fs } from "node:fs";
import path from "node:path";
import { requireAuth } from "../middleware/auth.js";
import { ingestAllDocuments } from "../rag/ingest.js";
import { config } from "../config.js";

export const docRoutes = Router();

docRoutes.get("/status", requireAuth, async (req, res) => {
  if (req.user?.role !== "official") {
    res.status(403).json({ error: "Only officials can view docs status" });
    return;
  }

  const resolvedDocsRoot = path.resolve(config.docsRoot);
  const resolvedVectorDb = path.resolve(config.vectorDbPath);

  const countTxtRecursive = async (dir: string): Promise<number> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
          count += 1;
        } else if (entry.isDirectory()) {
          count += await countTxtRecursive(fullPath);
        }
      }
      return count;
    } catch {
      return 0;
    }
  };

  const [ruCount, kzCount] = await Promise.all([
    countTxtRecursive(path.join(resolvedDocsRoot, "ru")),
    countTxtRecursive(path.join(resolvedDocsRoot, "kz")),
  ]);

  let vectorChunks = 0;
  try {
    const raw = await fs.readFile(resolvedVectorDb, "utf-8");
    vectorChunks = (JSON.parse(raw) as unknown[]).length;
  } catch {
    vectorChunks = 0;
  }

  res.json({
    ok: true,
    cwd: process.cwd(),
    docsRoot: config.docsRoot,
    docsRootResolved: resolvedDocsRoot,
    ruTxtFiles: ruCount,
    kzTxtFiles: kzCount,
    vectorDbPath: config.vectorDbPath,
    vectorDbResolved: resolvedVectorDb,
    vectorChunks,
  });
});

// Public debug endpoint: для быстрого понимания,
// почему backend на Vercel "не видит" документы.
docRoutes.get("/status-public", async (_req, res) => {
  const resolvedDocsRoot = path.resolve(config.docsRoot);
  const resolvedVectorDb = path.resolve(config.vectorDbPath);

  const listDirEntries = async (dir: string): Promise<string[]> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.slice(0, 50).map((e) => (e.isDirectory() ? `[D]${e.name}` : e.name));
    } catch {
      return [];
    }
  };

  const findFirstTxtRecursive = async (dir: string): Promise<string | null> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
          return fullPath;
        }
        if (entry.isDirectory()) {
          const nested = await findFirstTxtRecursive(fullPath);
          if (nested) return nested;
        }
      }
    } catch {
      // ignore
    }
    return null;
  };

  const countTxtRecursive = async (dir: string): Promise<number> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      let count = 0;
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
          count += 1;
        } else if (entry.isDirectory()) {
          count += await countTxtRecursive(fullPath);
        }
      }
      return count;
    } catch {
      return 0;
    }
  };

  const ruDir = path.join(resolvedDocsRoot, "ru");
  const kzDir = path.join(resolvedDocsRoot, "kz");

  const [ruCount, kzCount, ruEntries, kzEntries, firstRuTxt, firstKzTxt] = await Promise.all([
    countTxtRecursive(ruDir),
    countTxtRecursive(kzDir),
    listDirEntries(ruDir),
    listDirEntries(kzDir),
    findFirstTxtRecursive(ruDir),
    findFirstTxtRecursive(kzDir),
  ]);

  async function dirDebug(dir: string): Promise<{ exists: boolean; error: string | null }> {
    try {
      await fs.stat(dir);
      return { exists: true, error: null };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      return { exists: false, error: msg };
    }
  }

  const [ruDirDebug, kzDirDebug] = await Promise.all([dirDebug(ruDir), dirDebug(kzDir)]);
  const docsRootDebug = await dirDebug(resolvedDocsRoot);

  async function listDir(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.slice(0, 50).map((e) => `${e.isDirectory() ? "[D]" : ""}${e.name}`);
    } catch {
      return [];
    }
  }
  const docsRootEntries = await listDir(resolvedDocsRoot);

  let vectorChunks = 0;
  try {
    const raw = await fs.readFile(resolvedVectorDb, "utf-8");
    vectorChunks = (JSON.parse(raw) as unknown[]).length;
  } catch {
    vectorChunks = 0;
  }

  res.json({
    ok: true,
    cwd: process.cwd(),
    docsRoot: config.docsRoot,
    docsRootResolved: resolvedDocsRoot,
    docsRootResolvedExists: docsRootDebug.exists,
    docsRootResolvedError: docsRootDebug.error,
    docsRootEntries,
    ruTxtFiles: ruCount,
    kzTxtFiles: kzCount,
    ruDirEntries: ruEntries,
    kzDirEntries: kzEntries,
    firstRuTxt: firstRuTxt,
    firstKzTxt: firstKzTxt,
    ruDirExists: ruDirDebug.exists,
    kzDirExists: kzDirDebug.exists,
    ruDirError: ruDirDebug.error,
    kzDirError: kzDirDebug.error,
    vectorDbPath: config.vectorDbPath,
    vectorDbResolved: resolvedVectorDb,
    vectorChunks,
  });
});

docRoutes.post("/ingest", requireAuth, async (req, res) => {
  if (req.user?.role !== "official") {
    res.status(403).json({ error: "Only officials can run ingestion" });
    return;
  }

  try {
    const result = await ingestAllDocuments(config.docsRoot, config.vectorDbPath);
    res.json({
      ok: true,
      ...result,
      vectorDbPath: config.vectorDbPath,
    });
  } catch (error) {
    res.status(500).json({
      error: "Ingestion failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
