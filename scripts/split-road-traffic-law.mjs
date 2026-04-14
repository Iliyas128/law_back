/**
 * Делит единый файл «Закон Республики Казахстан «О дорожном движении».txt»
 * на папки по главам и файлы по статьям (как остальные кодексы в data/docs/ru).
 *
 * Запуск из каталога law_back: node scripts/split-road-traffic-law.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(
  ROOT,
  "data",
  "docs",
  "ru",
  "Закон Республики Казахстан «О дорожном движении».txt",
);
const OUT_DIR = path.join(ROOT, "data", "docs", "ru", "Закон Республики Казахстан «О дорожном движении»");

const CHAPTER_RE = /^\s*Глава\s+(\d+)\.\s*(.*)$/;
const ARTICLE_RE = /^\s*Статья\s+(\d+(?:-\d+)?)\.\s*(.*)$/;

/** Убирает недопустимые символы; длину не режем — полные заголовки в имени папки/файла. */
function sanitizeFileName(s) {
  return s.replace(/[<>:"/\\|?*]/g, " ").replace(/\s+/g, " ").trim();
}

async function main() {
  const raw = await fs.readFile(SRC, "utf-8");
  const lines = raw.replace(/\r/g, "").split("\n");

  /** @type {{ type: 'chapter' | 'article', line: number, num: string, titleRest: string }[]} */
  const events = [];
  for (let i = 0; i < lines.length; i += 1) {
    const ch = lines[i].match(CHAPTER_RE);
    if (ch) {
      events.push({ type: "chapter", line: i, num: ch[1], titleRest: ch[2].trim() });
      continue;
    }
    const ar = lines[i].match(ARTICLE_RE);
    if (ar) {
      events.push({ type: "article", line: i, num: ar[1], titleRest: ar[2].trim() });
    }
  }

  if (events.length === 0) {
    console.error("Не найдено ни глав, ни статей.");
    process.exit(1);
  }

  const firstLine = events[0].line;
  const preamble = lines.slice(0, firstLine).join("\n").trimEnd();

  /** @type {Map<string, { chapterNum: string, chapterDirName: string, articles: { fileName: string, body: string }[] }>} */
  const byChapterKey = new Map();
  let chapterOrder = [];

  function ensureChapter(chapterEventIndex) {
    const ev = events[chapterEventIndex];
    if (ev.type !== "chapter") return null;
    const nextEv = events[chapterEventIndex + 1];
    const titleEnd = nextEv ? nextEv.line : lines.length;
    const titleLines = lines.slice(ev.line, titleEnd);
    const titleText = titleLines
      .filter((ln) => !/^\s*Сноска\./.test(ln))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const key = ev.num;
    if (!byChapterKey.has(key)) {
      const chapterDirName = sanitizeFileName(titleText);
      byChapterKey.set(key, {
        chapterNum: ev.num,
        chapterDirName,
        articles: [],
      });
      chapterOrder.push(key);
    }
    return byChapterKey.get(key);
  }

  // Сопоставить каждую статью с предыдущей главой
  let lastChapterIdx = -1;
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (ev.type === "chapter") {
      lastChapterIdx = i;
      ensureChapter(i);
      continue;
    }
    if (ev.type === "article") {
      let chIdx = lastChapterIdx;
      if (chIdx < 0) {
        console.error("Статья до первой главы:", ev.line + 1);
        process.exit(1);
      }
      const ch = ensureChapter(chIdx);
      const nextEv = events[i + 1];
      const bodyEnd = nextEv ? nextEv.line : lines.length;
      const body = lines.slice(ev.line, bodyEnd).join("\n").trimEnd();
      const fileName = sanitizeFileName(`Статья ${ev.num}. ${ev.titleRest}.txt`);
      ch.articles.push({ fileName, body });
    }
  }

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (preamble) {
    await fs.writeFile(
      path.join(OUT_DIR, "00 Примечания и вводные положения.txt"),
      `${preamble}\n`,
      "utf-8",
    );
  }

  let articleCount = 0;
  for (const key of chapterOrder) {
    const ch = byChapterKey.get(key);
    const dir = path.join(OUT_DIR, ch.chapterDirName);
    await fs.mkdir(dir, { recursive: true });
    for (const art of ch.articles) {
      await fs.writeFile(path.join(dir, art.fileName), `${art.body}\n`, "utf-8");
      articleCount += 1;
    }
  }

  console.log(`Глав: ${chapterOrder.length}, статей: ${articleCount}, папка: ${OUT_DIR}`);
  await fs.unlink(SRC);
  console.log("Исходный монолитный файл удалён. При необходимости восстановите из резервной копии или git.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
