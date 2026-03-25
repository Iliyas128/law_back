export interface ChunkUnit {
  content: string;
  article: string;
}

interface BuildChunksOptions {
  defaultArticle: string;
  maxChars?: number;
}

const ARTICLE_HEADER_REGEX = /^(Статья\s+\d+[^\n]*|Бап\s+\d+[^\n]*)$/gim;

function splitIntoArticleSections(text: string): Array<{ article: string; body: string }> {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean) {
    return [];
  }

  const matches = Array.from(clean.matchAll(ARTICLE_HEADER_REGEX));
  if (matches.length === 0) {
    return [{ article: "Без статьи", body: clean }];
  }

  const sections: Array<{ article: string; body: string }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const start = current.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? clean.length) : clean.length;
    const header = current[0].trim();
    const body = clean.slice(start, end).trim();
    sections.push({ article: header, body });
  }

  return sections;
}

function splitLongParagraph(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) {
    return [paragraph];
  }

  const result: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    const end = Math.min(start + maxChars, paragraph.length);
    result.push(paragraph.slice(start, end));
    start = end;
  }
  return result;
}

export function chunkDocument(text: string, options: BuildChunksOptions): ChunkUnit[] {
  const maxChars = options.maxChars ?? 1200;
  const sections = splitIntoArticleSections(text);
  const chunks: ChunkUnit[] = [];

  for (const section of sections) {
    const article = section.article === "Без статьи" ? options.defaultArticle : section.article;
    const paragraphs = section.body
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) => splitLongParagraph(p, maxChars));

    let current = "";
    for (const paragraph of paragraphs) {
      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (candidate.length <= maxChars) {
        current = candidate;
        continue;
      }

      if (current) {
        chunks.push({ content: current, article });
      }
      current = paragraph;
    }

    if (current) {
      chunks.push({ content: current, article });
    }
  }

  return chunks;
}
