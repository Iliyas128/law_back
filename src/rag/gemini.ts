import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import type { RagChunk } from "./types.js";

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

function chunkLexicalScore(query: string, chunk: RagChunk): number {
  return Math.max(
    lexicalScore(query, chunk.content),
    lexicalScore(query, `${chunk.law} ${chunk.article}`),
  );
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

/**
 * Короткая строка ключевых юридических терминов для эмбеддинга при поиске
 * (коллоквиальные вопросы → «КоАП», виды ответственности и т.д.).
 */
export async function expandSearchQueryForRetrieval(question: string): Promise<string> {
  if (!ai) {
    return "";
  }
  const q = question.trim();
  if (q.length < 4) {
    return "";
  }

  try {
    const response = await ai.models.generateContent({
      model: config.geminiChatModel,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Ты помощник семантического поиска по законодательству Республики Казахстан.

По вопросу пользователя выпиши ОДНУ строку: 15–40 ключевых слов и коротких фраз на русском для поиска по базе норм (статьи, виды ответственности, предметы регулирования: например «административная ответственность», «КоАП РК», «штраф МРП», «налоговая инспекция», «ДПС», «коммерческая тайна»).

Если речь о свидетеле, показаниях, отказе или неявке по вызову в административном производстве — обязательно включи: «КоАП статья 658», «уклонение свидетеля», «отказ от показаний», «2 МРП», а также при необходимости «статья 754 свидетель».

Не отвечай на вопрос пользователя. Не давай советов и пояснений. Только термины через запятую или точку с запятой.

Вопрос:
${q}`,
            },
          ],
        },
      ],
    });

    const out = response.text?.trim() ?? "";
    if (!out || out.length > 1200) {
      return "";
    }
    return out;
  } catch {
    return "";
  }
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
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await embedText(query);
  } catch {
    return chunks
      .sort((a, b) => chunkLexicalScore(query, b) - chunkLexicalScore(query, a))
      .slice(0, options.topK);
  }

  const candidateCount = Math.max(options.topK, options.topK * options.candidateMultiplier);

  const scored = chunks.map((chunk) => {
    const vector = cosineSimilarity(queryEmbedding!, chunk.embedding);
    const lexical = chunkLexicalScore(query, chunk);
    const hybrid = vector * options.vectorWeight + lexical * options.lexicalWeight;
    return { chunk, hybrid };
  });

  return scored
    .sort((a, b) => b.hybrid - a.hybrid)
    .slice(0, candidateCount)
    .slice(0, options.topK)
    .map((x) => x.chunk);
}

const UNIFIED_SYSTEM_PROMPT = [
  "Ты юридический AI-ассистент по законодательству Республики Казахстан.",
  "Пиши простым языком для обычного человека без юридического образования: короткие фразы, без лишней канцелярита. Сначала прямой ответ на вопрос (что будет, какой штраф), затем кратко — права и исключения, если они есть во фрагментах.",
  "Опирайся только на предоставленные фрагменты норм. Не выдумывай статьи, пункты и формулировки.",
  "Если вопрос общий («что будет», «какой штраф») про ситуацию в административном производстве, а во фрагментах есть статья КоАП с конкретной санкцией (например штраф в МРП) — назови её в первую очередь; статьи общего характера (про права свидетеля) не подменяют статью о санкции.",
  "Не смешивай уголовный и административный процесс в одной куче: про УПК говори только если пользователь явно спрашивает про уголовное дело или во фрагментах нет ответа по КоАП, но есть УПК.",
  "Если во фрагментах есть отсылки к другим статьям — учитывай связь кратко.",
  "Если данных недостаточно — прямо укажи это.",
  "В конце ответа перечисли использованные источники: закон и статья.",
].join(" ");

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface ChunkSelectionResult {
  needsClarification: boolean;
  clarificationQuestion?: string;
  /** Индексы 0..n-1 в переданном массиве из 10 чанков */
  selectedIndices: number[];
}

/**
 * Анализирует топ-10 чанков: при необходимости запрашивает уточнение, иначе выбирает 3–4 лучших.
 */
export async function analyzeRetrievedChunks(
  question: string,
  topChunks: RagChunk[],
): Promise<ChunkSelectionResult> {
  const n = topChunks.length;
  if (n === 0) {
    return { needsClarification: false, selectedIndices: [] };
  }

  const fallback = (): number[] => {
    const k = Math.min(4, n);
    return Array.from({ length: k }, (_, i) => i);
  };

  if (!ai) {
    return { needsClarification: false, selectedIndices: fallback() };
  }

  const labeled = topChunks
    .map(
      (c, i) =>
        `[${i + 1}] Закон: ${c.law}; Статья/фрагмент: ${c.article}; Язык: ${c.lang}\nТекст:\n${c.content}`,
    )
    .join("\n\n---\n\n");

  const response = await ai.models.generateContent({
    model: config.geminiChatModel,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Ты помощник по отбору юридических фрагментов для ответа на вопрос пользователя.

Вопрос пользователя:
${question}

Ниже ровно ${n} фрагментов законов [1]…[${n}]. Проанализируй их.

Верни ТОЛЬКО один JSON-объект без пояснений и без markdown-обёртки:
{
  "needs_clarification": boolean,
  "clarification_question": string | null,
  "selected_indices": number[]
}

Правила:
- needs_clarification: true ТОЛЬКО если вопрос настолько пустой или бессодержательный, что невозможно понять ни тему, ни область права (например одно слово «штраф?» без контекста). Разговорная формулировка («что мне будет если…», соцсети, работа) — это НЕ повод для уточнения, если смысл вопроса понятен.
- Если вопрос понятен по смыслу — needs_clarification: false и подбери фрагменты.
- Если needs_clarification: true — selected_indices должен быть [].
- Если needs_clarification: false — выбери от 1 до 4 номеров фрагментов (числа от 1 до ${n}). НЕ дополняй список слабо релевантными нормами ради количества: лучше 1–2 точных фрагмента, чем 4 с лишним.
- Порядок важен: первый номер в selected_indices — самый главный фрагмент для ответа (например статья с штрафом/санкцией), далее — вспомогательные (права, процедура).
- Если вопрос про «что будет», штраф, ответственность свидетеля в административном деле, и среди фрагментов есть статья КоАП о санкции (например ст. 658 — штраф за отказ/неявку свидетеля), включи её первой; ст. 754 «Свидетель» не заменяет статью о санкции для вопроса про наказание.
- Если вопрос про ответственность за деяния вне преступлений — приоритет КоАП среди подходящих фрагментов.
- Не включай фрагменты из Уголовно-процессуального кодекса, если вопрос явно про административное производство/КоАП и ответ есть во фрагментах КоАП.
- Не включай фрагменты, которые явно не относятся к вопросу.`,
          },
        ],
      },
    ],
  });

  const raw = response.text?.trim() ?? "";
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return { needsClarification: false, selectedIndices: fallback() };
  }

  const needs = Boolean(parsed.needs_clarification);
  const cq =
    typeof parsed.clarification_question === "string" ? parsed.clarification_question.trim() : "";
  const idxRaw = parsed.selected_indices;
  const oneBased = Array.isArray(idxRaw)
    ? idxRaw.map((x) => (typeof x === "number" ? x : parseInt(String(x), 10))).filter((x) => !Number.isNaN(x))
    : [];

  if (needs) {
    return {
      needsClarification: true,
      clarificationQuestion: cq || "Уточните, пожалуйста, ситуацию подробнее: о каком законе и обстоятельствах речь?",
      selectedIndices: [],
    };
  }

  const zeroBased = oneBased
    .map((j) => j - 1)
    .filter((i) => i >= 0 && i < n);

  let unique = [...new Set(zeroBased)];
  if (unique.length === 0) {
    unique = fallback();
  }
  if (unique.length > 4) {
    unique = unique.slice(0, 4);
  }

  return { needsClarification: false, selectedIndices: unique };
}

export async function generateUnifiedAnswer(question: string, contexts: RagChunk[]): Promise<string> {
  if (!ai) {
    const first = contexts[0];
    const excerpt = first?.content?.trim()?.slice(0, 1800) ?? "";
    const law = first?.law ?? "Не найдено";
    const article = first?.article ?? "-";

    return [
      "Короткий ответ по найденным нормам:",
      "",
      `Основание: ${law}, статья: ${article}`,
      "",
      excerpt ? `Выдержка из текста:` : "В контексте не удалось извлечь текст.",
      excerpt ? excerpt : "",
      "",
      "Важно: это предварительный ответ. Для окончательной оценки обратитесь к юристу.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const contextBlock = contexts
    .map(
      (c, i) =>
        `[Источник ${i + 1}] Закон: ${c.law}; Статья/фрагмент: ${c.article}; Язык: ${c.lang}\nТекст:\n${c.content}`,
    )
    .join("\n\n");

  const response = await ai.models.generateContent({
    model: config.geminiChatModel,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${UNIFIED_SYSTEM_PROMPT}

Вопрос пользователя:
${question}

Контекст законов (отобранные фрагменты):
${contextBlock}

Сформируй полный ответ на русском языке. Не пересказывай дословно весь текст норм: только суть для ответа на вопрос. Используй нумерацию источников [Источник 1], [Источник 2] там, где уместно.`,
          },
        ],
      },
    ],
  });

  return response.text?.trim() ?? "Не удалось сгенерировать ответ.";
}
