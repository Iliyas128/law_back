import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Всегда в whitelist, даже если CORS_ORIGINS в Vercel задан без snowtech. */
export const REQUIRED_CORS_ORIGINS = [
  "https://www.snowtech.asia",
  "https://snowtech.asia",
] as const;

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:8080",
  "http://localhost:5173",
  "https://law-front1.vercel.app",
  ...REQUIRED_CORS_ORIGINS,
];

function buildCorsOrigins(): string[] {
  const fromEnv = process.env.CORS_ORIGINS?.trim();
  const base = fromEnv ? parseOrigins(fromEnv) : [...DEFAULT_CORS_ORIGINS];
  return [...new Set([...base, ...REQUIRED_CORS_ORIGINS])];
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
  /**
   * Бюджет «размышлений» Gemini 2.5 (thinking tokens).
   *  - 0  → отключить thinking (вдвое быстрее, без заметной потери качества для коротких юр-ответов).
   *  - -1 → авто (модель сама выбирает бюджет, по умолчанию у API).
   *  - N (>0) → ограничить N токенов на размышления.
   * По умолчанию у нас 0 — главный буст по скорости.
   */
  geminiThinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 0),
  /** Максимум фрагментов, которые попадают в LLM-промпт select+generate. */
  promptTopK: Number(process.env.RAG_PROMPT_TOP_K ?? 8),
  /** Максимум символов на каждый фрагмент в промпте select+generate (отбор). */
  promptChunkChars: Number(process.env.RAG_PROMPT_CHUNK_CHARS ?? 1100),
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
  /**
   * Дополнять запрос коротким LLM-списком терминов для поиска.
   * По умолчанию выключено: на текущей архитектуре есть быстрый regex-NER + multi-query retrieval,
   * а лишний LLM-вызов добавлял к ответу 5–10 секунд. Включить: RAG_LLM_QUERY_EXPAND=1.
   */
  ragLlmQueryExpand: process.env.RAG_LLM_QUERY_EXPAND === "1",
  embedRetries: Number(process.env.RAG_EMBED_RETRIES ?? 3),
  embedRetryBaseMs: Number(process.env.RAG_EMBED_RETRY_BASE_MS ?? 400),
  /**
   * Нейросетевой NER (Transformers.js, ONNX). В dev включён по умолчанию; на production (Vercel)
   * отключён — первый прогрев качает модель и тяжёлый для serverless.
   * Включить на проде: USE_TRANSFORMER_NER=1
   * Выключить локально: USE_TRANSFORMER_NER=0
   */
  useTransformerNer:
    process.env.USE_TRANSFORMER_NER === "1" ||
    (process.env.NODE_ENV !== "production" && process.env.USE_TRANSFORMER_NER !== "0"),
  /** Модель из Hugging Face / Xenova (ONNX), совместимая с @xenova/transformers */
  transformerNerModel:
    process.env.TRANSFORMER_NER_MODEL ?? "Xenova/bert-base-multilingual-cased-ner-hrl",
  /** Минимальная уверенность span при агрегации simple */
  transformerNerMinScore: Number(process.env.TRANSFORMER_NER_MIN_SCORE ?? 0.72),
  corsOrigins: buildCorsOrigins(),
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
