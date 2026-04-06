/**
 * Разбивает монолитный КоАП РК на отдельные .txt по статьям (заголовок: «Статья N. …»).
 * Запуск: node scripts/split-koap-into-articles.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const SRC = path.join(
  root,
  "data/docs/ru/Кодекс Республики Казахстан об административных правонарушениях.txt",
);
const OUT_DIR = path.join(
  root,
  "data/docs/ru/Кодекс Республики Казахстан об административных правонарушениях",
);

/** Реальные заголовки статей: «Статья 74-1. Текст», не сноски «Статья 143 с изменениями». */
const ARTICLE_HEADER = /^\s*Статья\s+(\d+(?:-\d+)?)\.\s+(.+)$/;

function safeFileName(title, maxLen = 170) {
  let s = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen).trimEnd()}…`;
  }
  return s || "статья";
}

async function main() {
  try {
    await fs.access(SRC);
  } catch {
    console.error(
      "Исходный файл не найден (уже разбит?):",
      path.relative(root, SRC),
    );
    process.exit(1);
  }
  const raw = await fs.readFile(SRC, "utf-8");
  const text = raw.replace(/\r/g, "");
  const lines = text.split("\n");

  const headers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(ARTICLE_HEADER);
    if (m) {
      headers.push({
        lineIndex: i,
        num: m[1],
        titleLine: lines[i].trim(),
        shortTitle: m[2].trim(),
      });
    }
  }

  if (headers.length === 0) {
    console.error("Не найдено ни одной строки-заголовка статьи.");
    process.exit(1);
  }

  await fs.mkdir(OUT_DIR, { recursive: true });

  const preambleEnd = headers[0].lineIndex;
  if (preambleEnd > 0) {
    const preamble = lines.slice(0, preambleEnd).join("\n").trimEnd();
    if (preamble.length > 0) {
      const pPath = path.join(OUT_DIR, "00_Преамбула и содержание.txt");
      await fs.writeFile(pPath, `${preamble}\n`, "utf-8");
      console.log("Записано:", path.relative(root, pPath));
    }
  }

  const usedNames = new Map();
  for (let h = 0; h < headers.length; h += 1) {
    const start = headers[h].lineIndex;
    const end = h + 1 < headers.length ? headers[h + 1].lineIndex : lines.length;
    const block = lines.slice(start, end).join("\n").trimEnd();
    const num = headers[h].num;
    const base = safeFileName(`Статья ${num}. ${headers[h].shortTitle}`);
    let fname = `${base}.txt`;
    const prev = usedNames.get(fname) ?? 0;
    usedNames.set(fname, prev + 1);
    if (prev > 0) {
      fname = `${base} (${prev + 1}).txt`;
    }
    const outPath = path.join(OUT_DIR, fname);
    await fs.writeFile(outPath, `${block}\n`, "utf-8");
  }

  console.log(`Готово: ${headers.length} статей в ${path.relative(root, OUT_DIR)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
