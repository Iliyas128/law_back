import { config } from "../src/config.js";
import { ingestAllDocuments } from "../src/rag/ingest.js";

async function main(): Promise<void> {
  if (!config.geminiApiKey) {
    console.error("Укажите GEMINI_API_KEY в .env для эмбеддингов.");
    process.exit(1);
  }
  console.log("docsRoot:", config.docsRoot);
  console.log("vectorDbPath:", config.vectorDbPath);
  const result = await ingestAllDocuments(config.docsRoot, config.vectorDbPath);
  console.log("Готово:", result);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
