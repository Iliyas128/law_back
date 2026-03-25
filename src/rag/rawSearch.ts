import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkDocument } from "./chunker.js";
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

function parseLawAndArticle(fileName: string): { law: string; article: string } {
  const base = fileName.replace(/\.[^.]+$/, "");
  const [lawRaw, articleRaw] = base.split("__");
  return {
    law: lawRaw || "Неизвестный закон",
    article: articleRaw || "Без статьи",
  };
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
      const meta = parseLawAndArticle(path.basename(fullPath));
      const chunks = chunkDocument(text, { defaultArticle: meta.article });
      for (let i = 0; i < chunks.length; i += 1) {
        all.push({
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

  cachedChunks = all;
  return all;
}

export function rankRawLexical(query: string, chunks: RagChunk[], topK: number): RagChunk[] {
  return chunks
    .map((chunk) => ({ chunk, score: lexicalScore(query, chunk.content) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.chunk);
}
