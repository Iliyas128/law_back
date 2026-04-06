import path from "node:path";

/** Номер статьи из имени файла: «Статья 12…», «Статья 434-1…». */
function articleFromBasename(base: string): string | null {
  const m = base.match(/^Статья\s+(\d+(?:-\d+)?)/i);
  if (m) return m[1];
  const m2 = base.match(/^Бап\s+(\d+(?:-\d+)?)/i);
  if (m2) return m2[1];
  return null;
}

/**
 * Имя закона и номер статьи по умолчанию из пути к файлу.
 * - Вложенная папка: law = имя папки (как «Закон …» / «Кодекс …»), article из текста чанкера.
 * - Плоский файл с «__»: Law__12.txt → law + article.
 * - Иначе: law = имя файла без расширения.
 */
export function parseLawAndArticleFromPath(
  docsRoot: string,
  lang: string,
  fullPath: string,
): { law: string; article: string } {
  const langRoot = path.join(docsRoot, lang);
  const rel = path.relative(langRoot, fullPath);
  const parts = rel.split(path.sep).filter(Boolean);
  const base = path.basename(fullPath).replace(/\.[^.]+$/, "");
  const fromName = articleFromBasename(base);

  if (parts.length >= 2) {
    const law = parts[0].replace(/\.[^.]+$/, "");
    if (fromName) return { law, article: fromName };
    return { law, article: "-" };
  }

  const splitIdx = base.indexOf("__");
  if (splitIdx !== -1) {
    const lawRaw = base.slice(0, splitIdx);
    const articleRaw = base.slice(splitIdx + 2);
    return {
      law: lawRaw || "Неизвестный закон",
      article: articleRaw || "-",
    };
  }

  return { law: base || "Неизвестный закон", article: "-" };
}
