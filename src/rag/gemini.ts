import { GoogleGenAI } from "@google/genai";
import { config } from "../config.js";
import type { RagChunk } from "./types.js";

const ai = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : null;

/**
 * Базовый конфиг для всех чат-вызовов Gemini 2.5.
 * Главное здесь — `thinkingBudget`. По умолчанию (0) отключаем «размышления»,
 * это ускоряет ответ в 2–3 раза без заметной потери качества для коротких юр-ответов.
 * Через ENV (`GEMINI_THINKING_BUDGET`) можно вернуть 'auto' (-1) или задать конкретный лимит.
 */
function chatGenConfig(extra?: { temperature?: number; maxOutputTokens?: number }): {
  thinkingConfig?: { thinkingBudget: number };
  temperature?: number;
  maxOutputTokens?: number;
} {
  const cfg: ReturnType<typeof chatGenConfig> = {};
  if (Number.isFinite(config.geminiThinkingBudget)) {
    cfg.thinkingConfig = { thinkingBudget: config.geminiThinkingBudget };
  }
  if (extra?.temperature !== undefined) cfg.temperature = extra.temperature;
  if (extra?.maxOutputTokens !== undefined) cfg.maxOutputTokens = extra.maxOutputTokens;
  return cfg;
}

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
      config: chatGenConfig({ temperature: 0.2, maxOutputTokens: 256 }),
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
  "Пиши простым языком для обычного человека: короткие фразы, без канцелярита. Сначала прямой ответ (что будет, какой штраф), затем кратко — права и исключения.",
  "Опирайся ТОЛЬКО на предоставленные фрагменты норм. НЕ выдумывай статьи, номера, размеры штрафов и формулировки.",
  "Если вопрос требует УК (тяжкий/средний вред здоровью, убийство, кража, грабёж, разбой, наркотики, оружие, половые преступления), а среди фрагментов есть подходящая статья УК — приоритет ей.",
  "Если вопрос про лёгкое нарушение, штраф в МРП, мелкое хулиганство, опьянение в общественном месте — приоритет КоАП.",
  "Если в фрагментах нет статьи, прямо отвечающей на вопрос — ЧЕСТНО скажи об этом одним предложением и кратко сориентируй пользователя по виду ответственности (уголовная/административная), не выдумывая конкретных норм. Не натягивай неподходящие статьи (например, ст. о необходимой обороне или задержании в ответ на вопрос о размере наказания за вред здоровью).",
  "Ориентир по тяжести вреда здоровью: лёгкий вред / побои — часто ст. 108–109 УК или КоАП; средняя тяжесть — ст. 107 УК; тяжкий — ст. 106 УК; убийство — ст. 99 УК. Конкретная тяжесть (особенно переломы челюсти и др.) задаётся законодательным перечнем и судебно-медической экспертизой — упоминай это, если текст фрагментов недостаточно детализирован.",
  "Если во фрагментах ЕСТЬ статья УК 106, 107, 108 или 109 и пользователь спрашивает про последствия драки/травмы — обязательно перескажи из текста фрагмента правовые последствия (наказание по закону), хотя бы в общих чертах, и укажи, что точная статья зависит от выводов экспертизы.",
  "Не смешивай УПК с КоАП в одной куче. УПК упоминай только если вопрос явно про уголовный процесс или нет фрагментов КоАП.",
  "Если фрагменты содержат отсылки к другим статьям — кратко упомяни связь.",
  "В конце ответа перечисли использованные источники в формате: «Источники: [Закон, ст. N], [Закон, ст. M]».",
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
    config: chatGenConfig({ temperature: 0.1, maxOutputTokens: 512 }),
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

export interface SelectAndAnswerResult {
  needsClarification: boolean;
  clarificationQuestion?: string;
  /** 1-based индексы выбранных фрагментов (как в исходном массиве). */
  selectedIndices: number[];
  /** Готовый ответ пользователю (если needsClarification=false). */
  answer: string;
}

/**
 * Объединённый вызов: модель ОДНОВРЕМЕННО выбирает 1–4 лучших фрагмента и пишет финальный ответ.
 * Заменяет последовательную пару analyzeRetrievedChunks + generateUnifiedAnswer и экономит ~10–15 секунд.
 *
 * Возвращает строгий JSON с ответом и выбранными индексами; при ошибке парсинга мы откатываемся
 * к старому двухэтапному поведению на верхнем уровне.
 */
export async function selectAndGenerateAnswer(
  question: string,
  topChunks: RagChunk[],
): Promise<SelectAndAnswerResult> {
  const n = topChunks.length;
  if (n === 0) {
    return {
      needsClarification: false,
      selectedIndices: [],
      answer: "Не удалось найти подходящие нормы. Попробуйте сформулировать вопрос подробнее.",
    };
  }

  if (!ai) {
    const fallbackIdx = Array.from({ length: Math.min(3, n) }, (_, i) => i + 1);
    const first = topChunks[0];
    return {
      needsClarification: false,
      selectedIndices: fallbackIdx,
      answer: [
        `Основание: ${first.law}, статья: ${first.article}`,
        "",
        first.content.slice(0, 1800),
        "",
        "Важно: это предварительный ответ без LLM. Для оценки обратитесь к юристу.",
      ].join("\n"),
    };
  }

  // Сократим контекст до promptTopK и обрежем длинные тексты — это ускоряет генерацию.
  const limited = topChunks.slice(0, Math.max(1, config.promptTopK));
  const trim = (s: string): string =>
    s.length > config.promptChunkChars ? `${s.slice(0, config.promptChunkChars)}…` : s;
  const labeled = limited
    .map(
      (c, i) =>
        `[${i + 1}] Закон: ${c.law}; Статья/фрагмент: ${c.article}; Язык: ${c.lang}\nТекст:\n${trim(c.content)}`,
    )
    .join("\n\n---\n\n");
  const limitedN = limited.length;

  const response = await ai.models.generateContent({
    model: config.geminiChatModel,
    config: chatGenConfig({ temperature: 0.2, maxOutputTokens: 1024 }),
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${UNIFIED_SYSTEM_PROMPT}

Вопрос пользователя:
${question}

Ниже ровно ${limitedN} фрагментов законов [1]…[${limitedN}].

Сделай ДВЕ вещи за один проход:
1) Выбери от 1 до 4 наиболее релевантных фрагментов (числа от 1 до ${limitedN}).
2) Сразу сформируй итоговый ответ пользователю на русском языке, опираясь ТОЛЬКО на выбранные фрагменты.

Верни СТРОГО один JSON-объект без пояснений и без markdown-обёртки:
{
  "needs_clarification": boolean,
  "clarification_question": string | null,
  "selected_indices": number[],
  "answer": string
}

Правила:
- needs_clarification: true ТОЛЬКО если вопрос совершенно бессодержательный («штраф?» одно слово). Разговорная формулировка — НЕ повод уточнять.
- Если needs_clarification=true → selected_indices=[], answer = короткий вопрос-уточнение для пользователя.
- selected_indices: порядок важен. Первый — ГЛАВНЫЙ фрагмент (статья с санкцией / прямым ответом). Не дополняй список слабо релевантными статьями ради количества.
- Для вопросов про «что мне будет / какой штраф / какое наказание»:
   • если речь про физический вред человеку, драку с травмой, убийство — приоритет статьям УК (например 99/106/107/108/109/293), если они есть среди фрагментов;
   • если речь про лёгкое нарушение, мелкое хулиганство, опьянение в общественном месте — приоритет статьям КоАП (например 434, 440, 73-1).
- Если в вопросе явно упомянут конкретный закон/статья — приоритет фрагментам именно из этого закона/статьи.
- НЕ натягивай неподходящие статьи. Если среди фрагментов НЕТ статьи о санкции для описанной ситуации — в answer ЧЕСТНО скажи: «среди доступных норм нет статьи, прямо устанавливающей наказание за это», и кратко сориентируй пользователя по виду ответственности (уголовная/административная), без выдумки конкретных норм.
- НЕ смешивай УПК с КоАП. УПК упоминай только если вопрос явно про уголовный процесс или нет фрагментов КоАП.
- answer: 1–3 коротких абзаца простым языком. Сначала прямой ответ (что будет, какой штраф/срок), затем 1–2 строки про права/исключения, если они есть во фрагментах.
- В конце answer строка: «Источники: [Закон, ст. N], [Закон, ст. M]».

Фрагменты:
${labeled}`,
          },
        ],
      },
    ],
  });

  const raw = response.text?.trim() ?? "";
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return {
      needsClarification: false,
      selectedIndices: Array.from({ length: Math.min(3, limitedN) }, (_, i) => i + 1),
      answer: raw || "Не удалось сгенерировать ответ.",
    };
  }

  const needs = Boolean(parsed.needs_clarification);
  const cq =
    typeof parsed.clarification_question === "string"
      ? parsed.clarification_question.trim()
      : "";
  const idxRaw = parsed.selected_indices;
  const oneBased = Array.isArray(idxRaw)
    ? idxRaw
        .map((x) => (typeof x === "number" ? x : parseInt(String(x), 10)))
        .filter((x) => !Number.isNaN(x) && x >= 1 && x <= limitedN)
    : [];
  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";

  if (needs) {
    return {
      needsClarification: true,
      clarificationQuestion:
        cq || "Уточните, пожалуйста, ситуацию: о каком законе и обстоятельствах речь?",
      selectedIndices: [],
      answer: cq || "Уточните, пожалуйста, ситуацию: о каком законе и обстоятельствах речь?",
    };
  }

  return {
    needsClarification: false,
    selectedIndices:
      Array.from(new Set(oneBased)).slice(0, 4).length > 0
        ? Array.from(new Set(oneBased)).slice(0, 4)
        : Array.from({ length: Math.min(3, limitedN) }, (_, i) => i + 1),
    answer: answer || "Не удалось сгенерировать ответ.",
  };
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
    config: chatGenConfig({ temperature: 0.2, maxOutputTokens: 1024 }),
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
