import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { config } from "../src/config.js";
import type { RagChunk } from "../src/rag/types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

async function main(): Promise<void> {
  const chunksPath = path.resolve(process.cwd(), "data", "db", "chunks.json");
  console.log("chunksPath:", chunksPath);
  console.log("pgVectorTable:", config.pgVectorTable);

  const raw = await fs.readFile(chunksPath, "utf-8");
  const chunks = JSON.parse(raw) as RagChunk[];
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new Error("chunks.json is empty or invalid");
  }

  if (!config.pgUrl) {
    throw new Error("PG_URL (or DATABASE_URL) is not configured");
  }

  let connectionString = config.pgUrl;
  if (config.pgSslNoVerify) {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete("sslmode");
    connectionString = parsed.toString();
  }

  const batchSize = parseIntEnv("IMPORT_BATCH_SIZE", 50);
  const startOffset = parseIntEnv("IMPORT_START_OFFSET", 0);
  const maxRetries = parseIntEnv("IMPORT_MAX_RETRIES", 6);
  const truncateFirst = process.env.IMPORT_TRUNCATE_FIRST === "1";
  const skipSchema = process.env.IMPORT_SKIP_SCHEMA === "1";

  const pool = new Pool({
    connectionString,
    ssl: config.pgSslNoVerify ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 0,
    query_timeout: 0,
    max: 2,
  });

  try {
    console.log("Connecting and preparing schema...");
    await pool.query("SET statement_timeout TO 0");
    if (!skipSchema) {
      await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${config.pgVectorTable} (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          embedding vector(3072) NOT NULL,
          law TEXT NOT NULL,
          article TEXT NOT NULL,
          lang TEXT NOT NULL,
          source_path TEXT NOT NULL
        )
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${config.pgVectorTable}_lang_idx ON ${config.pgVectorTable}(lang)`,
      );
      await pool.query(
        `CREATE INDEX IF NOT EXISTS ${config.pgVectorTable}_article_idx ON ${config.pgVectorTable}(article)`,
      );
    } else {
      console.log("Schema step skipped (IMPORT_SKIP_SCHEMA=1)");
    }

    if (truncateFirst) {
      console.log("TRUNCATE enabled: cleaning destination table first");
      await pool.query(`TRUNCATE TABLE ${config.pgVectorTable}`);
    }

    console.log(
      `Importing ${chunks.length} chunks in batches of ${batchSize} (startOffset=${startOffset})...`,
    );

    for (let i = startOffset; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const values: unknown[] = [];
      const tuples = batch.map((chunk, idx) => {
        const p = idx * 7;
        values.push(
          chunk.id,
          chunk.content,
          toVectorLiteral(chunk.embedding),
          chunk.law,
          chunk.article,
          chunk.lang,
          chunk.sourcePath,
        );
        return `($${p + 1}, $${p + 2}, $${p + 3}::vector, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7})`;
      });

      const sql = `
        INSERT INTO ${config.pgVectorTable}
          (id, content, embedding, law, article, lang, source_path)
        VALUES ${tuples.join(",")}
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          embedding = EXCLUDED.embedding,
          law = EXCLUDED.law,
          article = EXCLUDED.article,
          lang = EXCLUDED.lang,
          source_path = EXCLUDED.source_path
      `;

      let attempt = 0;
      while (true) {
        try {
          await pool.query(sql, values);
          const done = Math.min(i + batch.length, chunks.length);
          if (done === chunks.length || done % 500 === 0 || i === startOffset) {
            console.log(`progress: ${done}/${chunks.length}`);
          }
          break;
        } catch (error) {
          attempt += 1;
          const code =
            error && typeof error === "object" && "code" in error
              ? String((error as { code: unknown }).code)
              : "UNKNOWN";
          if (attempt > maxRetries) {
            throw new Error(
              `Batch failed at offset ${i} after ${maxRetries} retries (code=${code}). Resume with IMPORT_START_OFFSET=${i}`,
            );
          }
          const waitMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
          console.warn(`batch offset ${i} failed (code=${code}), retry ${attempt}/${maxRetries} in ${waitMs}ms`);
          await sleep(waitMs);
        }
      }
    }

    const countRes = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${config.pgVectorTable}`,
    );
    console.log("Done. Rows in table:", countRes.rows[0]?.count ?? 0);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
