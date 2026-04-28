import { Pool } from "pg";
import { config } from "../config.js";
import type { Language } from "../types.js";
import type { RagChunk } from "./types.js";

function toPgVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

interface SearchOptions {
  lang?: Language;
  limit: number;
}

interface ChunkRow {
  id: string;
  content: string;
  law: string;
  article: string;
  lang: Language;
  source_path: string;
}

export class PgVectorStore {
  private readonly pool: Pool | null;

  constructor(
    private readonly tableName: string = config.pgVectorTable,
    pgUrl: string = config.pgUrl,
  ) {
    let connectionString = pgUrl;
    if (connectionString && config.pgSslNoVerify) {
      const parsed = new URL(connectionString);
      parsed.searchParams.delete("sslmode");
      connectionString = parsed.toString();
    }

    this.pool = pgUrl
      ? new Pool({
          connectionString,
          ssl: config.pgSslNoVerify ? { rejectUnauthorized: false } : undefined,
          statement_timeout: 0,
          query_timeout: 0,
          idleTimeoutMillis: 30000,
        })
      : null;
  }

  private getPoolOrThrow(): Pool {
    if (!this.pool) {
      throw new Error("PG_URL (or DATABASE_URL) is not configured");
    }
    return this.pool;
  }

  async ensureSchema(): Promise<void> {
    const pool = this.getPoolOrThrow();
    await pool.query("SET statement_timeout TO 0");
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector;");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding vector(3072) NOT NULL,
        law TEXT NOT NULL,
        article TEXT NOT NULL,
        lang TEXT NOT NULL,
        source_path TEXT NOT NULL
      );
    `);
    // For Gemini embeddings (3072 dims), ivfflat index is not supported in pgvector.
    // Keep table/indexes simple; for current corpus size this is fast enough.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_lang_idx
      ON ${this.tableName} (lang);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS ${this.tableName}_article_idx
      ON ${this.tableName} (article);
    `);
  }

  async count(): Promise<number> {
    const pool = this.getPoolOrThrow();
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${this.tableName}`);
    return result.rows[0]?.count ?? 0;
  }

  async replaceAll(chunks: RagChunk[]): Promise<void> {
    const pool = this.getPoolOrThrow();
    await pool.query(`TRUNCATE TABLE ${this.tableName}`);

    const batchSize = 100;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const values: unknown[] = [];
      const rowsSql = batch.map((chunk, idx) => {
        const p = idx * 7;
        values.push(
          chunk.id,
          chunk.content,
          toPgVectorLiteral(chunk.embedding),
          chunk.law,
          chunk.article,
          chunk.lang,
          chunk.sourcePath,
        );
        return `($${p + 1}, $${p + 2}, $${p + 3}::vector, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7})`;
      });

      await pool.query(
        `
          INSERT INTO ${this.tableName}
            (id, content, embedding, law, article, lang, source_path)
          VALUES ${rowsSql.join(",")}
        `,
        values,
      );
    }
  }

  async searchByEmbedding(queryEmbedding: number[], options: SearchOptions): Promise<RagChunk[]> {
    const pool = this.getPoolOrThrow();
    const vec = toPgVectorLiteral(queryEmbedding);
    const result = await pool.query<ChunkRow>(
      `
        SELECT id, content, law, article, lang, source_path
        FROM ${this.tableName}
        WHERE ($1::text IS NULL OR lang = $1)
        ORDER BY embedding <=> $2::vector
        LIMIT $3
      `,
      [options.lang ?? null, vec, options.limit],
    );

    return result.rows.map((row) => ({
      id: row.id,
      content: row.content,
      embedding: [],
      law: row.law,
      article: row.article,
      lang: row.lang,
      sourcePath: row.source_path,
    }));
  }
}
