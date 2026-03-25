import { Router } from "express";
import { z } from "zod";
import { VectorStore } from "../rag/vectorStore.js";
import { config } from "../config.js";
import { generateAnswer, rankHybrid } from "../rag/gemini.js";
import type { ChatResponsePayload } from "../types.js";
import { loadRawChunks, rankRawLexical } from "../rag/rawSearch.js";

const bodySchema = z.object({
  message: z.string().min(2),
  mode: z
    .preprocess((v) => (typeof v === "string" ? v.toLowerCase() : v), z.enum(["citizen", "official"]))
    .optional(),
  // Не валидируем lang как строгий enum на сервере, чтобы деплой/окружение фронта
  // не вызывало 400. Далее нормализуем вручную.
  lang: z.preprocess((v) => (typeof v === "string" ? v.toLowerCase() : undefined), z.string().optional()).optional(),
});

export const chatRoutes = Router();

chatRoutes.post("/", async (req, res) => {
  let body: unknown = req.body;
  // Иногда в серверлесс окружениях тело может прийти как строка.
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // оставляем как строку, zod даст понятную ошибку
    }
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const requestedMode = parsed.data.mode;
  const role = requestedMode ?? "citizen";

  try {
    const store = new VectorStore(config.vectorDbPath);
    const allChunks = await store.load();
    const searchableChunks = allChunks.length > 0 ? allChunks : await loadRawChunks(config.docsRoot);
    if (searchableChunks.length === 0) {
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

    const langFiltered = normalizedLang
      ? searchableChunks.filter((chunk) => chunk.lang === normalizedLang)
      : searchableChunks;
    if (langFiltered.length === 0) {
      res.json({
        answer: `Для языка ${normalizedLang} пока нет проиндексированных документов.`,
        law: "Нет данных",
        article: "-",
        sources: [],
      });
      return;
    }

    const relevant =
      allChunks.length > 0
        ? await rankHybrid(parsed.data.message, langFiltered, {
            topK: config.topK,
            vectorWeight: config.hybridVectorWeight,
            lexicalWeight: config.hybridLexicalWeight,
            candidateMultiplier: config.hybridCandidateMultiplier,
          })
        : rankRawLexical(parsed.data.message, langFiltered, config.topK);
    const answer = await generateAnswer(parsed.data.message, requestedMode ?? role, relevant);
    const firstSource = relevant[0];

    const payload: ChatResponsePayload = {
      answer,
      law: firstSource?.law ?? "Не найдено",
      article: firstSource?.article ?? "-",
      sources: relevant.map((r) => ({ law: r.law, article: r.article, lang: r.lang })),
    };

    res.json(payload);
  } catch (error) {
    res.status(500).json({
      error: "Chat request failed",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
