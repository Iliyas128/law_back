import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Имя таблицы только [a-zA-Z0-9_], иначе SQL-инъекция через env. */
function sanitizePgTableName(raw: string, fallback: string): string {
  const s = raw.trim();
  if (/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(s)) return s;
  console.warn(`[config] Invalid PG_VECTOR_TABLE "${raw}", using "${fallback}"`);
  return fallback;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  jwtSecret: process.env.JWT_SECRET ?? "change-this-secret-in-env",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiChatModel: process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash",
  geminiEmbeddingModel: process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001",
  docsRoot:
    process.env.DOCS_ROOT ??
    (process.env.NODE_ENV === "production"
      ? path.join("dist", "data", "docs")
      : path.join("data", "docs")),
  vectorDbPath:
    process.env.VECTOR_DB_PATH ??
    (process.env.NODE_ENV === "production"
      ? path.join("dist", "data", "db", "chunks.json")
      : path.join("data", "db", "chunks.json")),
  pgUrl: process.env.PG_URL ?? process.env.DATABASE_URL ?? "",
  pgVectorTable: sanitizePgTableName(process.env.PG_VECTOR_TABLE ?? "rag_chunks", "rag_chunks"),
  pgSslNoVerify: process.env.PG_SSL_NO_VERIFY === "1",
  useLocalVectorDb:
    process.env.USE_LOCAL_VECTOR_DB != null
      ? process.env.USE_LOCAL_VECTOR_DB === "1"
      : process.env.NODE_ENV !== "production",
  /** Сколько чанков отбирать после гибридного ранжирования (далее модель выберет 3–4). */
  retrievalTopK: Number(process.env.RAG_RETRIEVAL_TOP_K ?? 12),
  /** @deprecated используйте retrievalTopK; оставлено для совместимости */
  topK: Number(process.env.RAG_TOP_K ?? 10),
  hybridVectorWeight: Number(process.env.RAG_VECTOR_WEIGHT ?? 0.7),
  hybridLexicalWeight: Number(process.env.RAG_LEXICAL_WEIGHT ?? 0.3),
  hybridCandidateMultiplier: Number(process.env.RAG_CANDIDATE_MULTIPLIER ?? 6),
  /** Дополнять запрос коротким LLM-списком терминов для поиска (отключить: RAG_LLM_QUERY_EXPAND=0). */
  ragLlmQueryExpand: process.env.RAG_LLM_QUERY_EXPAND !== "0",
  embedRetries: Number(process.env.RAG_EMBED_RETRIES ?? 5),
  embedRetryBaseMs: Number(process.env.RAG_EMBED_RETRY_BASE_MS ?? 800),
  corsOrigins: parseOrigins(
    process.env.CORS_ORIGINS ?? "http://localhost:8080,http://localhost:5173,https://law-front1.vercel.app",
  ),
  /**
   * База для fallback загрузки .txt с GitHub Raw (без trailing slash).
   * DOCS_RAW_BASE= пусто или "0" — не тянуть с GitHub (только локальные файлы / PG).
   */
  docsRawBase: (() => {
    const raw = process.env.DOCS_RAW_BASE;
    if (raw === "" || raw === "0") return "";
    const base = (raw ?? "https://raw.githubusercontent.com/Iliyas128/law_back/main").replace(/\/+$/, "");
    return base;
  })(),
};
