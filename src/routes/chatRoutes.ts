import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { VectorStore } from "../rag/vectorStore.js";
import { config } from "../config.js";
import { generateAnswer, rankHybrid } from "../rag/gemini.js";
import type { ChatResponsePayload } from "../types.js";
import { loadRawChunks, rankRawLexical } from "../rag/rawSearch.js";

const bodySchema = z.object({
  message: z.string().min(2),
  mode: z.enum(["citizen", "official"]).optional(),
  lang: z.enum(["ru", "kz"]).optional(),
});

export const chatRoutes = Router();

chatRoutes.post("/", requireAuth, async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const requestedMode = parsed.data.mode;
  const role = req.user?.role ?? "citizen";
  if (requestedMode === "official" && role !== "official") {
    res.status(403).json({ error: "Citizen user cannot use official mode" });
    return;
  }

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

    const langFiltered = parsed.data.lang
      ? searchableChunks.filter((chunk) => chunk.lang === parsed.data.lang)
      : searchableChunks;
    if (langFiltered.length === 0) {
      res.json({
        answer: `Для языка ${parsed.data.lang} пока нет проиндексированных документов.`,
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
