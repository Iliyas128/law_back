import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { chunkDocument } from "./chunker.js";
import { parseLawAndArticleFromPath } from "./docMeta.js";
import type { RagChunk } from "./types.js";
import type { Language } from "../types.js";

let cachedChunks: RagChunk[] | null = null;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function lexicalScore(query: string, doc: string): number {
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const d = new Set(tokenize(doc));
  let matches = 0;
  for (const token of q) {
    if (d.has(token)) matches += 1;
  }
  return matches / q.length;
}

function chunkLexicalScore(query: string, chunk: RagChunk): number {
  return Math.max(
    lexicalScore(query, chunk.content),
    lexicalScore(query, `${chunk.law} ${chunk.article}`),
  );
}

async function readTxtFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".txt")).map((e) => e.name);
}

async function listTxtFilesRecursive(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      try {
        const nested = await listTxtFilesRecursive(fullPath);
        results.push(...nested);
      } catch {
        // ignore unreadable folders
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
      results.push(fullPath);
    }
  }

  return results;
}

export async function loadRawChunks(docsRoot: string): Promise<RagChunk[]> {
  if (cachedChunks) return cachedChunks;

  const all: RagChunk[] = [];

  const tryLoadFromLocal = async (): Promise<RagChunk[] | null> => {
    const localAll: RagChunk[] = [];
    for (const lang of ["ru", "kz"] as const satisfies Language[]) {
      const langDir = path.join(docsRoot, lang);
      let files: string[] = [];
      try {
        files = await listTxtFilesRecursive(langDir);
      } catch {
        continue;
      }

      for (const fullPath of files) {
        const text = await fs.readFile(fullPath, "utf-8");
        const meta = parseLawAndArticleFromPath(docsRoot, lang, fullPath);
        const chunks = chunkDocument(text, { defaultArticle: meta.article });
        for (let i = 0; i < chunks.length; i += 1) {
          localAll.push({
            id: `raw:${lang}:${fullPath}:${i}`,
            content: chunks[i].content,
            embedding: [],
            law: meta.law,
            article: chunks[i].article || meta.article,
            lang,
            sourcePath: fullPath,
          });
        }
      }
    }
    return localAll.length > 0 ? localAll : null;
  };

  // 1) Сначала пробуем локальные файлы (локальная разработка).
  const local = await tryLoadFromLocal();
  if (local) {
    cachedChunks = local;
    return cachedChunks;
  }

  // 2) Fallback: если на Vercel serverless FS нет docs, грузим из GitHub Raw.
  const manifestPath = path.join(process.cwd(), "dist", "docs-manifest.json");
  let manifest: { files: string[] } | null = null;
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    manifest = JSON.parse(raw) as { files: string[] };
  } catch {
    manifest = null;
  }

  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    cachedChunks = [];
    return cachedChunks;
  }

  if (!config.docsRawBase) {
    cachedChunks = [];
    return cachedChunks;
  }

  for (const rel of manifest.files) {
    // expecting: data/docs/ru/<file>.txt or data/docs/kz/<file>.txt
    const parts = rel.split("/");
    const lang = parts[2] as Language | undefined; // ["data","docs","ru",...]
    if (lang !== "ru" && lang !== "kz") continue;

    const url = `${config.docsRawBase}/${rel}`;
    const resp = await fetch(url);
    if (!resp.ok) continue;
    const text = await resp.text();
    const docsRootAbs = path.join(process.cwd(), "data", "docs");
    const absPath = path.join(process.cwd(), ...rel.split("/"));
    const meta = parseLawAndArticleFromPath(docsRootAbs, lang, absPath);
    const chunks = chunkDocument(text, { defaultArticle: meta.article });
    for (let i = 0; i < chunks.length; i += 1) {
      all.push({
        id: `rawRemote:${lang}:${rel}:${i}`,
        content: chunks[i].content,
        embedding: [],
        law: meta.law,
        article: chunks[i].article || meta.article,
        lang,
        sourcePath: rel,
      });
    }
  }

  cachedChunks = all;
  return all;
}

export function rankRawLexical(query: string, chunks: RagChunk[], topK: number): RagChunk[] {
  return chunks
    .map((chunk) => ({ chunk, score: chunkLexicalScore(query, chunk) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.chunk);
}
