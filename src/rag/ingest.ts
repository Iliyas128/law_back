import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkDocument } from "./chunker.js";
import { embedText } from "./gemini.js";
import { VectorStore } from "./vectorStore.js";
import type { RagChunk } from "./types.js";
import type { Language } from "../types.js";

function parseLawAndArticle(fileName: string): { law: string; article: string } {
  // Filename format: LawName__Article.txt
  const base = fileName.replace(/\.[^.]+$/, "");
  const [lawRaw, articleRaw] = base.split("__");
  return {
    law: lawRaw || "Неизвестный закон",
    article: articleRaw || "Без статьи",
  };
}

async function readTextFiles(dirPath: string): Promise<string[]> {
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
        // ignore
      }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
      results.push(fullPath);
    }
  }

  return results;
}

export async function ingestAllDocuments(
  docsRoot: string,
  vectorDbPath: string,
): Promise<{ totalChunks: number; files: number; skippedChunks: number }> {
  const vectorStore = new VectorStore(vectorDbPath);
  const allChunks: RagChunk[] = [];
  let fileCounter = 0;
  let skippedChunks = 0;

  for (const lang of ["ru", "kz"] as const satisfies Language[]) {
    const langDir = path.join(docsRoot, lang);
    let files: string[] = [];
    try {
      files = await listTxtFilesRecursive(langDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }

    for (const fullPath of files) {
      fileCounter += 1;
      const text = await fs.readFile(fullPath, "utf-8");
      const { law, article } = parseLawAndArticle(path.basename(fullPath));
      const chunks = chunkDocument(text, { defaultArticle: article });

      for (let i = 0; i < chunks.length; i += 1) {
        const content = chunks[i].content;
        try {
          const embedding = await embedText(content);
          allChunks.push({
            id: `${lang}:${fullPath}:${i}`,
            content,
            embedding,
            law,
            article: chunks[i].article || article,
            lang,
            sourcePath: fullPath,
          });
        } catch (error) {
          skippedChunks += 1;
          console.warn(`Skipping chunk ${lang}:${fullPath}:${i}`, error);
        }
      }
    }
  }

  await vectorStore.save(allChunks);
  return { totalChunks: allChunks.length, files: fileCounter, skippedChunks };
}
