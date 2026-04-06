import type { RagChunk } from "./types.js";

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

/** Явно только уголовный процесс — ст. 658 КоАП не подмешиваем. */
function isExplicitlyCriminalOnlyQuestion(q: string): boolean {
  const criminal =
    /уголовн(ое|ый|ого|ом)\s+дел|досудебн\w*\s+производств|следовател|обвиняем|подозреваем/i.test(q);
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
