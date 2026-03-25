import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import type { RagChunk } from "./types.js";
import type { UserRole } from "../types.js";

const ai = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const n = Math.min(a.length, b.length);

  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  if (!magA || !magB) {
    return 0;
  }

  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function lexicalScore(query: string, doc: string): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) {
    return 0;
  }

  const dTokens = new Set(tokenize(doc));
  let matches = 0;
  for (const token of qTokens) {
    if (dTokens.has(token)) {
      matches += 1;
    }
  }

  return matches / qTokens.length;
}

export async function embedText(text: string): Promise<number[]> {
  if (!ai) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < config.embedRetries; attempt += 1) {
    try {
      const response = await ai.models.embedContent({
        model: config.geminiEmbeddingModel,
        contents: text,
      });

      const embedding = response.embeddings?.[0]?.values;
      if (!embedding || embedding.length === 0) {
        throw new Error("Gemini embedding response is empty");
      }

      return embedding;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transient =
        message.includes("503") || message.includes("UNAVAILABLE") || message.includes("429");
      if (!transient || attempt === config.embedRetries - 1) {
        throw error;
      }

      const waitMs = config.embedRetryBaseMs * Math.pow(2, attempt);
      await sleep(waitMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Embedding failed");
}

export async function rankBySimilarity(
  query: string,
  chunks: RagChunk[],
  topK: number,
): Promise<RagChunk[]> {
  const queryEmbedding = await embedText(query);
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.chunk);
}

interface HybridRankOptions {
  topK: number;
  vectorWeight: number;
  lexicalWeight: number;
  candidateMultiplier: number;
}

export async function rankHybrid(
  query: string,
  chunks: RagChunk[],
  options: HybridRankOptions,
): Promise<RagChunk[]> {
  const queryEmbedding = await embedText(query);
  const candidateCount = Math.max(options.topK, options.topK * options.candidateMultiplier);

  const scored = chunks.map((chunk) => {
    const vector = cosineSimilarity(queryEmbedding, chunk.embedding);
    const lexical = lexicalScore(query, chunk.content);
    const hybrid = vector * options.vectorWeight + lexical * options.lexicalWeight;
    return { chunk, hybrid };
  });

  return scored
    .sort((a, b) => b.hybrid - a.hybrid)
    .slice(0, candidateCount)
    .slice(0, options.topK)
    .map((x) => x.chunk);
}

function buildSystemPrompt(role: UserRole): string {
  if (role === "official") {
    return [
      "Ты юридический AI-ассистент по законодательству Республики Казахстан для сотрудников государственных органов (полиция, прокуратура и др.).",
      "Отвечай как профессиональный юрист: точно, формально и обоснованно.",
      "Всегда опирайся только на предоставленный юридический контекст.",
      "Каждый ответ ОБЯЗАТЕЛЬНО сопровождай ссылками: закон, статья, пункт.",
      "Не выдумывай нормы закона, статьи или пункты.",
      "Не используй нерелевантные законы (например УПК, если нет уголовного дела).",
      "Если вопрос касается действий полиции или ДПС — четко разделяй:",
      "Если информации недостаточно — прямо укажи это.",
      "Формат ответа:",
      "1) Краткий но точный вывод",
      "2) Основание закона (закон, статья, пункт)"
    ].join(" ");
  }

  return [
    "Ты юридический AI-ассистент для граждан Республики Казахстан.",
    "Отвечай как опытный адвокат, который объясняет человеку его права простым и понятным языком.",
    "Твоя задача — не просто объяснить закон, а помочь человеку понять, что он МОЖЕТ делать, а что НЕТ.",
    
    "Всегда опирайся только на предоставленный юридический контекст.",
    "Каждый ответ ОБЯЗАТЕЛЬНО сопровождай ссылками: закон, статья, пункт.",
    "Не выдумывай нормы закона.",
    "Не используй нерелевантные законы (например УПК при обычной остановке ДПС).",

    "Пиши как адвокат: уверенно, четко и без лишней воды.",
    "Не перегружай длинными текстами — только суть и важные моменты.",

    "Если действия сотрудника незаконны — прямо скажи об этом.",
    "Если информации недостаточно — честно укажи это и предложи безопасные действия (спросить основание, фиксировать, обратиться к адвокату).",

    "Главная цель — дать человеку уверенность и понимание своих прав."
  ].join(" ");
}

export async function generateAnswer(
  question: string,
  role: UserRole,
  contexts: RagChunk[],
): Promise<string> {
  if (!ai) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const contextBlock = contexts
    .map(
      (c, i) =>
        `[Источник ${i + 1}] Закон: ${c.law}; Статья: ${c.article}; Язык: ${c.lang}; Текст: ${c.content}`,
    )
    .join("\n\n");

  const response = await ai.models.generateContent({
    model: config.geminiChatModel,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${buildSystemPrompt(role)}

Вопрос пользователя:
${question}

Контекст законов:
${contextBlock}

Сформируй ответ на русском языке.
`,
          },
        ],
      },
    ],
  });

  return response.text?.trim() ?? "Не удалось сгенерировать ответ.";
}
