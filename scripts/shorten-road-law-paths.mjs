/**
 * Сокращает пути внутри «Закон … О дорожном движении» для Windows / Git:
 * папки глав → «Глава 01» … «Глава 14», файлы → «Статья 61.txt», «Статья 71-1.txt».
 *
 * Запуск из law_back: node scripts/shorten-road-law-paths.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const LAW_DIR = path.join(
  process.cwd(),
  "data",
  "docs",
  "ru",
  "Закон Республики Казахстан «О дорожном движении»",
);

const ARTICLE_PREFIX_RE = /^Статья\s+(\d+(?:-\d+)?)/i;
const CHAPTER_PREFIX_RE = /^Глава\s+(\d+)/i;

async function shortenFileNamesInDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".txt")) continue;
    const m = e.name.match(ARTICLE_PREFIX_RE);
    if (!m) continue;
    const shortName = `Статья ${m[1]}.txt`;
    if (e.name === shortName) continue;
    await fs.rename(path.join(dir, e.name), path.join(dir, shortName));
  }
}

async function main() {
  const entries = await fs.readdir(LAW_DIR, { withFileTypes: true });
  const chapterDirs = entries.filter((e) => e.isDirectory() && CHAPTER_PREFIX_RE.test(e.name));

  for (const e of chapterDirs) {
    await shortenFileNamesInDir(path.join(LAW_DIR, e.name));
  }

  const tempPrefix = "__tmp_ch_";
  for (const e of chapterDirs) {
    const m = e.name.match(CHAPTER_PREFIX_RE);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    const tempName = `${tempPrefix}${String(n).padStart(2, "0")}`;
    await fs.rename(path.join(LAW_DIR, e.name), path.join(LAW_DIR, tempName));
  }

  const after = await fs.readdir(LAW_DIR, { withFileTypes: true });
  for (const e of after) {
    if (!e.isDirectory() || !e.name.startsWith(tempPrefix)) continue;
    const num = e.name.slice(tempPrefix.length);
    const finalName = `Глава ${num}`;
    await fs.rename(path.join(LAW_DIR, e.name), path.join(LAW_DIR, finalName));
    console.log(finalName);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
