import dotenv from "dotenv";

dotenv.config();

function parseOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  jwtSecret: process.env.JWT_SECRET ?? "change-this-secret-in-env",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  geminiChatModel: process.env.GEMINI_CHAT_MODEL ?? "gemini-2.5-flash",
  geminiEmbeddingModel: process.env.GEMINI_EMBED_MODEL ?? "gemini-embedding-001",
  docsRoot: process.env.DOCS_ROOT ?? "data/docs",
  vectorDbPath: process.env.VECTOR_DB_PATH ?? "data/db/chunks.json",
  topK: Number(process.env.RAG_TOP_K ?? 5),
  hybridVectorWeight: Number(process.env.RAG_VECTOR_WEIGHT ?? 0.7),
  hybridLexicalWeight: Number(process.env.RAG_LEXICAL_WEIGHT ?? 0.3),
  hybridCandidateMultiplier: Number(process.env.RAG_CANDIDATE_MULTIPLIER ?? 4),
  embedRetries: Number(process.env.RAG_EMBED_RETRIES ?? 5),
  embedRetryBaseMs: Number(process.env.RAG_EMBED_RETRY_BASE_MS ?? 800),
  corsOrigins: parseOrigins(
    process.env.CORS_ORIGINS ?? "http://localhost:8080,http://localhost:5173,https://law-front1.vercel.app",
  ),
};
