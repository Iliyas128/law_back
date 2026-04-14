import { config } from "../src/config.js";
import { ingestAllDocuments } from "../src/rag/ingest.js";
import { PgVectorStore } from "../src/rag/pgVectorStore.js";

async function main(): Promise<void> {
  if (!config.geminiApiKey) {
    console.error("Укажите GEMINI_API_KEY в .env для эмбеддингов.");
    process.exit(1);
  }
  console.log("docsRoot:", config.docsRoot);
  console.log("pgVectorTable:", config.pgVectorTable);
  const pgVectorStore = new PgVectorStore();
  const result = await ingestAllDocuments(config.docsRoot, pgVectorStore);
  console.log("Готово:", result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
