/**
 * Нейросетевой NER через Transformers.js (@xenova/transformers).
 * Модель: многоязычная token-classification (PER / ORG / LOC / …) —
 * улучшает поиск по «названию закона», организации, топонимам, редко встречающимся
 * именам в тексте пользователя туда, где regex бессилен.
 *
 * Юридическую квалификацию («перелом челюсти → средняя/тяжёлая тяжесть») общий NER
 * почти не решает: для этого в проекте остаются regex-темы + словарь в ner.ts и
 * обязательные статьи в TOPIC_KEY_ARTICLES.
 */

import { config } from "../config.js";

interface AggregatedNerSpan {
  entity_group?: string;
  label?: string;
  entity?: string;
  word?: string;
  score?: number;
}

type NerPipelineFn = (
  text: string,
  opts?: { aggregation_strategy?: "none" | "simple" | "first" | "average" | "max" },
) => Promise<AggregatedNerSpan[] | unknown>;

let nerPipelinePromise: Promise<NerPipelineFn | null> | null = null;

async function getNerPipeline(): Promise<NerPipelineFn | null> {
  if (!config.useTransformerNer) {
    return null;
  }

  if (!nerPipelinePromise) {
    nerPipelinePromise = (async () => {
      try {
        const { pipeline } = await import("@xenova/transformers");

        console.info(
          `[neural-n] Загружается модель NER "${config.transformerNerModel}"… (первый запуск может занять 1–2 мин и скачать ~120 МБ кэша)`,
        );

        const pipe = (await pipeline(
          "token-classification",
          config.transformerNerModel,
        )) as NerPipelineFn;

        console.info(`[neural-n] Модель NER готова: ${config.transformerNerModel}`);
        return pipe;
      } catch (e) {
        console.error("[neural-n] Не удалось загрузить модель NER:", e);
        return null;
      }
    })();
  }

  return nerPipelinePromise;
}

/**
 * Возвращает фразы сущностей для подмешивания в retrieval (эмбеддинг + лексика).
 */
export async function extractNeuralNerTerms(question: string): Promise<string[]> {
  if (!config.useTransformerNer) {
    return [];
  }

  const q = question.trim();
  if (q.length < 3) {
    return [];
  }

  const pipe = await getNerPipeline();
  if (!pipe) {
    return [];
  }

  try {
    const raw = await pipe(q, { aggregation_strategy: "simple" });
    if (!Array.isArray(raw)) {
      return [];
    }

    const min = config.transformerNerMinScore;
    const out: string[] = [];

    for (const span of raw as AggregatedNerSpan[]) {
      const w = String(span.word ?? "").trim();
      const score = typeof span.score === "number" ? span.score : 1;
      if (!w || w.length < 2 || score < min) {
        continue;
      }
      const group = String(span.entity_group ?? span.entity ?? span.label ?? "MISC");
      const tagged = `${w} (${group})`;
      out.push(w, tagged);
    }

    // Дедуп, без огромных строк
    return Array.from(new Set(out)).filter((s) => s.length <= 140);
  } catch (e) {
    console.warn("[neural-n] Inference error:", e);
    return [];
  }
}
