import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkDocument } from "./chunker.js";
import { parseLawAndArticleFromPath } from "./docMeta.js";
import { buildTextForEmbedding } from "./embeddingText.js";
import { embedText } from "./gemini.js";
import { PgVectorStore } from "./pgVectorStore.js";
import type { RagChunk } from "./types.js";
import type { Language } from "../types.js";

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

const INGEST_LOG_EVERY_CHUNKS = Number(process.env.INGEST_LOG_EVERY ?? 40);

export async function ingestAllDocuments(
  docsRoot: string,
  pgVectorStore: PgVectorStore,
): Promise<{ totalChunks: number; files: number; skippedChunks: number }> {
  const allChunks: RagChunk[] = [];
  let fileCounter = 0;
  let skippedChunks = 0;
  let embeddedCount = 0;
  const started = Date.now();

  console.log(
    "[ingest] Каждый чанк текста = один запрос к Gemini Embedding. Большой корпус — десятки минут и дольше; дождитесь строки «Готово».",
  );

  const filesByLang: Record<Language, string[]> = { ru: [], kz: [] };
  for (const lang of ["ru", "kz"] as const satisfies Language[]) {
    const langDir = path.join(docsRoot, lang);
    try {
      filesByLang[lang] = await listTxtFilesRecursive(langDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        filesByLang[lang] = [];
        continue;
      }
      throw err;
    }
    console.log(`[ingest] ${lang}: ${filesByLang[lang].length} файлов .txt`);
  }

  for (const lang of ["ru", "kz"] as const satisfies Language[]) {
    const files = filesByLang[lang];
    if (files.length === 0) {
      continue;
    }

    for (const fullPath of files) {
      fileCounter += 1;
      if (fileCounter === 1 || fileCounter % 200 === 0) {
        console.log(`[ingest] файл ${fileCounter}… ${path.basename(fullPath)}`);
      }
      const text = await fs.readFile(fullPath, "utf-8");
      const { law, article } = parseLawAndArticleFromPath(docsRoot, lang, fullPath);
      const chunks = chunkDocument(text, { defaultArticle: article });

      for (let i = 0; i < chunks.length; i += 1) {
        const content = chunks[i].content;
        try {
          const embedding = await embedText(
            buildTextForEmbedding(law, chunks[i].article || article, content),
          );
          embeddedCount += 1;
          if (embeddedCount === 1 || embeddedCount % INGEST_LOG_EVERY_CHUNKS === 0) {
            const sec = ((Date.now() - started) / 1000).toFixed(0);
            console.log(
              `[ingest] эмбеддинги: ${embeddedCount} чанков за ${sec}s (идёт запись в память, файл ${path.basename(fullPath)})`,
            );
          }
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

  console.log(`[ingest] Сохраняю ${allChunks.length} чанков в PostgreSQL (pgvector)…`);
  await pgVectorStore.ensureSchema();
  await pgVectorStore.replaceAll(allChunks);
  const totalSec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[ingest] Готово за ${totalSec}s.`);
  return { totalChunks: allChunks.length, files: fileCounter, skippedChunks };
}
