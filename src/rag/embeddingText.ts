/**
 * Текст для эмбеддинга: к содержимому чанка добавляются закон и статья,
 * чтобы векторы лучше совпадали с запросами «КоАП», «административка» и т.п.
 * В ответах и API по-прежнему используется только исходный `content`.
 */
export function buildTextForEmbedding(law: string, article: string, content: string): string {
  const body = content.trim();
  const art = article && article !== "-" ? article : "";
  const lawTrim = law.trim();

  if (/административных\s+правонарушениях/i.test(lawTrim)) {
    const head = [
      "Кодекс Республики Казахстан об административных правонарушениях",
      "КоАП РК",
      "административное правонарушение административная ответственность",
      art ? `статья ${art}` : "",
    ]
      .filter(Boolean)
      .join(". ");
    return `${head}. ${body}`;
  }

  const head = art ? `${lawTrim}. Статья ${art}.` : `${lawTrim}.`;
  return `${head} ${body}`;
}
