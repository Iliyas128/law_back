/**
 * Быстрая проверка PG + расширения vector + (опционально) строк в таблице чанков.
 * Запуск: npx tsx scripts/pg-check.ts
 */
import { Pool } from "pg";
import { config } from "../src/config.js";

async function main(): Promise<void> {
  const pgUrl = config.pgUrl;
  if (!pgUrl) {
    console.error("Укажите PG_URL или DATABASE_URL в .env");
    process.exit(1);
  }

  let connectionString = pgUrl;
  if (config.pgSslNoVerify) {
    const parsed = new URL(connectionString);
    parsed.searchParams.delete("sslmode");
    connectionString = parsed.toString();
  }

  const pool = new Pool({
    connectionString,
    ssl: config.pgSslNoVerify ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15_000,
    max: 1,
  });

  try {
    const ping = await pool.query("SELECT current_database() AS db, version() AS version");
    console.log("Подключение: OK");
    console.log("  database:", ping.rows[0]?.db);
    console.log(
      "  postgres:",
      String(ping.rows[0]?.version ?? "").split("\n")[0]?.slice(0, 80) + "...",
    );

    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    console.log("Расширение vector: OK (или уже было)");

    const tbl = config.pgVectorTable;
    const exists = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [tbl],
    );
    console.log(`Таблица "${tbl}" существует:`, exists.rows[0]?.exists ?? false);

    if (exists.rows[0]?.exists) {
      const cnt = await pool.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM ${tbl}`,
      );
      console.log(`Строк в "${tbl}":`, cnt.rows[0]?.c ?? 0);
    }

    console.log("\nДальше: импорт из chunks.json → npm run import:chunks");
  } catch (e) {
    console.error("Ошибка подключения или запроса:");
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
