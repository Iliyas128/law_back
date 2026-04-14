import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import {
  analyzeRetrievedChunks,
  expandSearchQueryForRetrieval,
  embedText,
  generateUnifiedAnswer,
} from "../rag/gemini.js";
import type { ChatResponsePayload } from "../types.js";
import { loadRawChunks, rankRawLexical } from "../rag/rawSearch.js";
import { enrichQueryForRetrieval } from "../rag/queryExpand.js";
import { boostKoap658ForWitnessQuestion } from "../rag/retrievalBoost.js";
import { PgVectorStore } from "../rag/pgVectorStore.js";

function extractArticleNumberFromQuestion(q: string): string | null {
  const m =
    q.match(/статья\s+(\d+(?:-\d+)?)/i) ??
    q.match(/ст\.\s*(\d+(?:-\d+)?)/i) ??
    q.match(/№\s*(\d+(?:-\d+)?)/i);
  return m?.[1] ?? null;
}

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
    let vectorCount = 0;
    try {
      await pgVectorStore.ensureSchema();
      vectorCount = await pgVectorStore.count();
    } catch {
      vectorCount = 0;
    }
    const searchableChunks = vectorCount > 0 ? null : await loadRawChunks(config.docsRoot);
    if (searchableChunks && searchableChunks.length === 0) {
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

    const langFiltered = searchableChunks
      ? normalizedLang
        ? searchableChunks.filter((chunk) => chunk.lang === normalizedLang)
        : searchableChunks
      : [];
    if (langFiltered.length === 0) {
      if (searchableChunks) {
        res.json({
          answer: `Для языка ${normalizedLang} пока нет проиндексированных документов.`,
          law: "Нет данных",
          article: "-",
          sources: [],
        });
        return;
      }
    }

    const requestedArticleNumber = extractArticleNumberFromQuestion(parsed.data.message);
    const candidateChunks = searchableChunks
      ? requestedArticleNumber
      ? (() => {
          const filtered = langFiltered.filter((c) => {
            const num = extractArticleNumberFromChunkArticle(c.article);
            return num === requestedArticleNumber;
          });
          return filtered.length > 0 ? filtered : langFiltered;
        })()
      : langFiltered
      : [];

    const retrievalK = config.retrievalTopK;
    const heuristicQuery = enrichQueryForRetrieval(parsed.data.message);
    let retrievalQuery = heuristicQuery;
    if (config.ragLlmQueryExpand && (vectorCount > 0 || langFiltered.length > 0)) {
      const llmLine = await expandSearchQueryForRetrieval(parsed.data.message);
      if (llmLine) {
        retrievalQuery = `${heuristicQuery}\n${llmLine}`;
      }
    }

    const topRanked =
      vectorCount > 0
        ? await (async () => {
            const qEmbed = await embedText(retrievalQuery);
            const limit = Math.max(retrievalK, retrievalK * config.hybridCandidateMultiplier);
            const rows = await pgVectorStore.searchByEmbedding(qEmbed, {
              lang: normalizedLang,
              limit,
            });
            const byArticle = requestedArticleNumber
              ? rows.filter(
                  (r) =>
                    extractArticleNumberFromChunkArticle(r.article) === requestedArticleNumber,
                )
              : rows;
            return (byArticle.length > 0 ? byArticle : rows).slice(0, retrievalK);
          })()
        : rankRawLexical(retrievalQuery, candidateChunks, retrievalK);

    const topRelevant = boostKoap658ForWitnessQuestion(
      parsed.data.message,
      topRanked,
      vectorCount > 0 ? topRanked : candidateChunks,
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

    const selection = await analyzeRetrievedChunks(parsed.data.message, topRelevant);

    if (selection.needsClarification) {
      const payload: ChatResponsePayload = {
        answer:
          selection.clarificationQuestion?.trim() ||
          "Уточните, пожалуйста, вопрос: о какой ситуации и каком законе речь?",
        law: "—",
        article: "-",
        sources: [],
        needs_clarification: true,
      };
      res.json(payload);
      return;
    }

    const selectedChunks = selection.selectedIndices
      .map((i) => topRelevant[i])
      .filter((c): c is NonNullable<typeof c> => Boolean(c));

    const contextsForAnswer = selectedChunks.length > 0 ? selectedChunks : topRelevant.slice(0, 4);

    const answer = await generateUnifiedAnswer(parsed.data.message, contextsForAnswer);
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
