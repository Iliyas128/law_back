import type { RagChunk } from "./types.js";
import { lawMatchesCode, type LawCode, type QueryEntities } from "./ner.js";

function isKoapLaw(law: string): boolean {
  return /административных\s+правонарушениях/i.test(law);
}

/** Статья 658 КоАП — санкция за отказ/неявку свидетеля (2 МРП); короткая, часто теряется за ст. 754. */
export function isKoapArticle658Chunk(chunk: RagChunk): boolean {
  if (!isKoapLaw(chunk.law)) return false;
  const a = chunk.article;
  if (/\b658\b/.test(a) || /^658[\s.-]/i.test(a.trim())) return true;
  return /Статья\s+658\b/i.test(chunk.content);
}

const WITNESS_ADMIN =
  /свидетел|показан|отказ|уклон|не\s*приду|не\s*прийду|неявк|по\s*вызову|вызвали|вызов|допрос/i;

function isExplicitlyCriminalOnlyQuestion(q: string): boolean {
  const criminal =
    /уголовн(ое|ый|ого|ом)\s+дел|досудебн\w*\s+производств|следовател|обвиняем|подозреваем/i.test(
      q,
    );
  const admin = /административн|коап|правонарушен|мрп|к\s*о\s*а\s*п/i.test(q);
  return criminal && !admin;
}

/**
 * Если вопрос про свидетеля/показания (обычно админ. производство) — поднимаем ст. 658 КоАП в топ
 * и при необходимости подмешиваем её из полного набора чанков.
 */
export function boostKoap658ForWitnessQuestion(
  question: string,
  ranked: RagChunk[],
  pool: RagChunk[],
  topK: number,
): RagChunk[] {
  const q = question.trim();
  if (!WITNESS_ADMIN.test(q) || isExplicitlyCriminalOnlyQuestion(q)) {
    return ranked;
  }

  const inRanked = ranked.find((c) => isKoapArticle658Chunk(c));
  let primary: RagChunk | undefined = inRanked;

  if (!primary) {
    primary = pool.find((c) => isKoapArticle658Chunk(c));
  }

  if (!primary) {
    return ranked;
  }

  const without = ranked.filter((c) => c.id !== primary!.id);
  const merged = [primary, ...without];
  const seen = new Set<string>();
  const out: RagChunk[] = [];
  for (const c of merged) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * Reciprocal Rank Fusion (RRF) — устойчивый способ объединить результаты нескольких запросов.
 * score(d) = Σ 1 / (k + rank_i(d))
 * Возвращает топ-N уникальных чанков, отсортированных по убыванию RRF-скора.
 */
export function reciprocalRankFusion(
  rankedLists: RagChunk[][],
  topN: number,
  k = 60,
): RagChunk[] {
  const acc = new Map<string, { chunk: RagChunk; score: number }>();
  for (const list of rankedLists) {
    list.forEach((chunk, i) => {
      const prev = acc.get(chunk.id);
      const inc = 1 / (k + i + 1);
      if (prev) {
        prev.score += inc;
      } else {
        acc.set(chunk.id, { chunk, score: inc });
      }
    });
  }
  return Array.from(acc.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.chunk);
}

/**
 * Поднимает в начало списка:
 *  1) фрагменты, у которых article совпадает с NER.articleNumber;
 *  2) фрагменты из законов, угаданных NER (laws[]), сохраняя относительный порядок.
 * Не дублирует чанки. Сохраняет общую длину = topK.
 */
export function boostByEntities(
  ranked: RagChunk[],
  entities: QueryEntities,
  topK: number,
): RagChunk[] {
  if (ranked.length === 0) return ranked;

  const matchesArticle = (c: RagChunk): boolean => {
    if (!entities.articleNumber) return false;
    const a = c.article.trim();
    return (
      a === entities.articleNumber ||
      new RegExp(`(^|\\D)${entities.articleNumber}(\\D|$)`).test(a)
    );
  };

  const matchesAnyLaw = (c: RagChunk): boolean =>
    entities.laws.some((code) => lawMatchesCode(c.law, code));

  const tier1: RagChunk[] = []; // нужная статья
  const tier2: RagChunk[] = []; // нужный закон
  const tier3: RagChunk[] = []; // прочее

  for (const c of ranked) {
    if (matchesArticle(c) && matchesAnyLaw(c)) tier1.push(c);
    else if (matchesArticle(c)) tier1.push(c);
    else if (matchesAnyLaw(c)) tier2.push(c);
    else tier3.push(c);
  }

  const seen = new Set<string>();
  const out: RagChunk[] = [];
  for (const c of [...tier1, ...tier2, ...tier3]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * Слияние нескольких пулов чанков с дедупом по id; первый пул важнее.
 */
export function mergeUnique(...pools: RagChunk[][]): RagChunk[] {
  const seen = new Set<string>();
  const out: RagChunk[] = [];
  for (const pool of pools) {
    for (const c of pool) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

export type { LawCode };
