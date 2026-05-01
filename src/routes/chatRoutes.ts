import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import {
  expandSearchQueryForRetrieval,
  embedText,
  generateUnifiedAnswer,
  rankHybrid,
  selectAndGenerateAnswer,
} from "../rag/gemini.js";
import type { ChatResponsePayload } from "../types.js";
import { loadRawChunks, rankRawLexical } from "../rag/rawSearch.js";
import { enrichQueryForRetrieval } from "../rag/queryExpand.js";
import {
  boostByEntities,
  boostKoap658ForWitnessQuestion,
  mergeUnique,
  reciprocalRankFusion,
} from "../rag/retrievalBoost.js";
import { PgVectorStore } from "../rag/pgVectorStore.js";
import { VectorStore } from "../rag/vectorStore.js";
import {
  buildRetrievalQuery,
  extractQueryEntities,
  lawMatchesCode,
  mergeAdditionalTerms,
  TOPIC_KEY_ARTICLES,
  type LawCode,
} from "../rag/ner.js";
import { extractNeuralNerTerms } from "../rag/neuralNer.js";
import type { RagChunk } from "../rag/types.js";

function extractArticleNumberFromChunkArticle(article: string | undefined | null): string | null {
  if (!article) return null;
  const s = String(article);
  const m =
    s.match(/^\s*(\d+(?:-\d+)?)\s*$/) ??
    s.match(/Статья\s+(\d+(?:-\d+)?)/i) ??
    s.match(/Бап\s+(\d+(?:-\d+)?)/i);
  return m?.[1] ?? null;
}

const bodySchema = z.object({
  message: z.string().min(2),
  mode: z
    .preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["citizen", "official"]))
    .optional(),
  lang: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : undefined), z.string().optional()).optional(),
});

export const chatRoutes = Router();
const pgVectorStore = new PgVectorStore();
const localVectorStore = new VectorStore(config.vectorDbPath);

/** Подсказка для SQL ILIKE: переводим LawCode → паттерн вроде '%административных правонарушениях%'. */
function lawCodeToIlikePattern(code: LawCode): string {
  switch (code) {
    case "koap":
      return "%административных правонарушениях%";
    case "uk":
      return "%Уголовный кодекс%";
    case "upk":
      return "%Уголовно-процессуальный кодекс%";
    case "constitution":
      return "%Конституция%";
    case "police":
      return "%полиции%";
    case "pdd":
      return "%дорожн%";
    case "tax":
      return "%налогов%";
    case "labor":
      return "%Трудовой кодекс%";
    case "civil":
      return "%Гражданский кодекс%";
    case "civilProc":
      return "%Гражданский процессуальный кодекс%";
    default:
      return "%";
  }
}

chatRoutes.post("/", async (req, res) => {
  let body: unknown = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // zod даст ошибку
    }
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  try {
    let sourceMode: "localVectors" | "pgVectors" | "raw" = "raw";
    let localOrRawChunks: Awaited<ReturnType<typeof loadRawChunks>> = [];
    let hasPgVectors = false;

    if (config.useLocalVectorDb) {
      const local = await localVectorStore.load();
      if (local.length > 0) {
        sourceMode = "localVectors";
        localOrRawChunks = local;
      } else {
        localOrRawChunks = await loadRawChunks(config.docsRoot);
      }
    } else {
      try {
        await pgVectorStore.ensureSchema();
        hasPgVectors = (await pgVectorStore.count()) > 0;
      } catch {
        hasPgVectors = false;
      }
      if (hasPgVectors) {
        sourceMode = "pgVectors";
      } else {
        localOrRawChunks = await loadRawChunks(config.docsRoot);
      }
    }

    if (sourceMode === "raw" && localOrRawChunks.length === 0) {
      res.json({
        answer:
          "Не удалось найти документы для поиска. Добавьте .txt законы в data/docs/ru и data/docs/kz.",
        law: "Нет данных",
        article: "-",
        sources: [],
      });
      return;
    }

    const normalizedLang =
      parsed.data.lang === "ru" || parsed.data.lang === "kz" ? parsed.data.lang : undefined;

    const langFiltered =
      sourceMode === "pgVectors"
        ? []
        : normalizedLang
          ? localOrRawChunks.filter((chunk) => chunk.lang === normalizedLang)
          : localOrRawChunks;
    if (langFiltered.length === 0 && sourceMode !== "pgVectors") {
      res.json({
        answer: `Для языка ${normalizedLang ?? "ru/kz"} пока нет проиндексированных документов.`,
        law: "Нет данных",
        article: "-",
        sources: [],
      });
      return;
    }

    // === NER (regex + нейросеть Transformers.js) + построение запросов ===
    const entitiesBase = extractQueryEntities(parsed.data.message);
    const neuralTerms = await extractNeuralNerTerms(parsed.data.message).catch(() => [] as string[]);
    const entities = mergeAdditionalTerms(entitiesBase, neuralTerms);

    const heuristicQuery = enrichQueryForRetrieval(parsed.data.message);
    const nerEnrichedQuery = buildRetrievalQuery(parsed.data.message, entities);
    const requestedArticleNumber = entities.articleNumber;

    // Для local/raw — фильтр по статье (если указана)
    const candidateChunks =
      sourceMode === "pgVectors"
        ? []
        : requestedArticleNumber
          ? (() => {
              const filtered = langFiltered.filter((c) => {
                const num = extractArticleNumberFromChunkArticle(c.article);
                return num === requestedArticleNumber;
              });
              return filtered.length > 0 ? filtered : langFiltered;
            })()
          : langFiltered;

    const retrievalK = config.retrievalTopK;

    // === Параллельно: расширение LLM (опционально) и поиск контекста ===
    const llmExpandPromise: Promise<string> = config.ragLlmQueryExpand
      ? expandSearchQueryForRetrieval(parsed.data.message).catch(() => "")
      : Promise.resolve("");

    let topRanked: RagChunk[] = [];

    if (sourceMode === "pgVectors") {
      // Параллельные эмбеддинги: оригинал + NER-обогащённый.
      // (LLM-расширение, если включено, тоже встанет в очередь, но НЕ блокирует первый запрос.)
      const [embedRaw, embedEnriched, llmExpansion] = await Promise.all([
        embedText(parsed.data.message),
        embedText(nerEnrichedQuery),
        llmExpandPromise,
      ]);

      const limit = Math.max(retrievalK, retrievalK * config.hybridCandidateMultiplier);

      const searchPromises: Promise<RagChunk[]>[] = [
        pgVectorStore.searchByEmbedding(embedRaw, { lang: normalizedLang, limit }),
        pgVectorStore.searchByEmbedding(embedEnriched, { lang: normalizedLang, limit }),
      ];

      // Ещё один эмбед — только если LLM реально вернул осмысленное расширение.
      if (llmExpansion.trim().length > 0) {
        const llmEmbedPromise = embedText(`${heuristicQuery}\n${llmExpansion}`).catch(() => null);
        searchPromises.push(
          (async () => {
            const e = await llmEmbedPromise;
            if (!e) return [];
            return pgVectorStore.searchByEmbedding(e, { lang: normalizedLang, limit });
          })(),
        );
      }

      // Если в вопросе явно есть номер статьи — подтягиваем её точечно
      if (requestedArticleNumber) {
        for (const code of entities.laws.length > 0 ? entities.laws : (["koap"] as LawCode[])) {
          searchPromises.push(
            pgVectorStore.fetchByArticle(requestedArticleNumber, {
              lang: normalizedLang,
              lawLike: lawCodeToIlikePattern(code),
              limit: 4,
            }),
          );
        }
        // На всякий случай — без фильтра по закону тоже
        searchPromises.push(
          pgVectorStore.fetchByArticle(requestedArticleNumber, { lang: normalizedLang, limit: 4 }),
        );
      }

      // По темам подтягиваем заранее известные «ключевые статьи» (например battery → УК 106-110, КоАП 73-1, 434).
      // Это критично, когда вопрос задан бытовыми словами и векторный поиск не вытаскивает нужные нормы.
      const seenKey = new Set<string>();
      for (const topic of entities.topics) {
        const articles = TOPIC_KEY_ARTICLES[topic];
        if (!articles) continue;
        for (const { law, article } of articles) {
          const key = `${law}:${article}`;
          if (seenKey.has(key)) continue;
          seenKey.add(key);
          searchPromises.push(
            pgVectorStore.fetchByArticle(article, {
              lang: normalizedLang,
              lawLike: lawCodeToIlikePattern(law),
              limit: 4,
            }),
          );
        }
      }

      const lists = await Promise.all(searchPromises);
      const fused = reciprocalRankFusion(lists, retrievalK * 2);

      // Если NER уверенно знает закон — подмешаем фрагменты из соответствующего «семейства»
      const lawPool: RagChunk[] = [];
      if (entities.laws.length > 0) {
        const lawFetches = await Promise.all(
          entities.laws.map((code) =>
            pgVectorStore.fetchByLawLike(lawCodeToIlikePattern(code), {
              lang: normalizedLang,
              limit: 6,
            }),
          ),
        );
        for (const list of lawFetches) lawPool.push(...list);
      }

      topRanked = boostByEntities(mergeUnique(fused, lawPool), entities, retrievalK);
    } else if (sourceMode === "localVectors") {
      const llmExpansion = await llmExpandPromise;
      const retrievalQuery = llmExpansion
        ? `${nerEnrichedQuery}\n${llmExpansion}`
        : nerEnrichedQuery;
      const ranked = await rankHybrid(retrievalQuery, candidateChunks, {
        topK: retrievalK,
        vectorWeight: config.hybridVectorWeight,
        lexicalWeight: config.hybridLexicalWeight,
        candidateMultiplier: config.hybridCandidateMultiplier,
      });
      topRanked = boostByEntities(ranked, entities, retrievalK);
    } else {
      const llmExpansion = await llmExpandPromise;
      const retrievalQuery = llmExpansion
        ? `${nerEnrichedQuery}\n${llmExpansion}`
        : nerEnrichedQuery;
      const ranked = rankRawLexical(retrievalQuery, candidateChunks, retrievalK);
      topRanked = boostByEntities(ranked, entities, retrievalK);
    }

    const topRelevant = boostKoap658ForWitnessQuestion(
      parsed.data.message,
      topRanked,
      sourceMode === "pgVectors" ? topRanked : candidateChunks,
      retrievalK,
    );
    if (topRelevant.length === 0) {
      res.json({
        answer: "Пока не удалось найти релевантные нормы для этого запроса. Уточните формулировку.",
        law: "Нет данных",
        article: "-",
        sources: [],
      });
      return;
    }

    // === Объединённый LLM-вызов: выбор фрагментов + генерация ответа за один заход ===
    let answer: string;
    let selectedIndices0: number[];
    let needsClarification = false;

    try {
      const result = await selectAndGenerateAnswer(parsed.data.message, topRelevant);
      needsClarification = result.needsClarification;
      selectedIndices0 = result.selectedIndices.map((i) => i - 1);
      answer = result.answer;
    } catch (mergedError) {
      // Если объединённый вызов сломался — fallback к старой генерации (без отбора).
      console.error("[chat] selectAndGenerateAnswer failed, falling back:", mergedError);
      selectedIndices0 = topRelevant.slice(0, 3).map((_, i) => i);
      answer = await generateUnifiedAnswer(parsed.data.message, topRelevant.slice(0, 4));
    }

    if (needsClarification) {
      const payload: ChatResponsePayload = {
        answer,
        law: "—",
        article: "-",
        sources: [],
        needs_clarification: true,
      };
      res.json(payload);
      return;
    }

    const selectedChunks = selectedIndices0
      .map((i) => topRelevant[i])
      .filter((c): c is NonNullable<typeof c> => Boolean(c));
    const contextsForAnswer = selectedChunks.length > 0 ? selectedChunks : topRelevant.slice(0, 4);
    const firstSource = contextsForAnswer[0];

    const payload: ChatResponsePayload = {
      answer,
      law: firstSource?.law ?? "Не найдено",
      article: firstSource?.article ?? "-",
      sources: contextsForAnswer.map((r) => ({
        law: r.law,
        article: r.article,
        lang: r.lang,
        text: r.content,
      })),
      needs_clarification: false,
    };

    res.json(payload);
  } catch (error) {
    res.status(500).json({
      error: "Chat request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// utility export для тестов
export { lawMatchesCode };
