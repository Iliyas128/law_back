/**
 * Делит монолитные законы на файлы по статьям с вложенными папками глав/разделов.
 * node scripts/split-legal-docs.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const ru = path.join(root, "data/docs/ru");

const ARTICLE_LAW =
  /^\s*Статья\s+(\d+(?:-\d+)?)\.\s+(.+)$/;
const CHAPTER_LINE = /^\s*Глава\s+(\d+(?:-\d+)?)\.\s+(.+)$/;
const SECTION_CONST = /^\s*Раздел\s+([IVXLCDM]+|\d+)\s*$/i;
const ARTICLE_CONST = /^\s*Статья\s+(\d+(?:-\d+)?)\s*$/;
const PDD_CHAPTER = /^\s*Глава\s+(\d+)\.\s+(.+)$/;

function safeFileName(s, maxLen = 150) {
  let x = String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (x.length > maxLen) x = `${x.slice(0, maxLen).trimEnd()}…`;
  return x || "unnamed";
}

async function writeArticleFile(outDir, chapterDir, titleBase, bodyLines, usedNames) {
  await fs.mkdir(chapterDir, { recursive: true });
  let fname = `${safeFileName(titleBase)}.txt`;
  const n = (usedNames.get(fname) ?? 0) + 1;
  usedNames.set(fname, n);
  if (n > 1) fname = `${safeFileName(titleBase)} (${n}).txt`;
  const outPath = path.join(chapterDir, fname);
  await fs.writeFile(outPath, `${bodyLines.join("\n").trimEnd()}\n`, "utf-8");
  return outPath;
}

/** Законы со «Статья N. Заголовок» и папками «Глава N. …». */
async function splitLawWithChapters(srcPath, outDirName, preambleName = "00_Преамбула.txt") {
  const raw = await fs.readFile(srcPath, "utf-8");
  const lines = raw.replace(/\r/g, "").split("\n");
  const outDir = path.join(ru, outDirName);

  const headers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(ARTICLE_LAW);
    if (m) {
      headers.push({
        lineIndex: i,
        num: m[1],
        shortTitle: m[2].trim(),
      });
    }
  }
  if (headers.length === 0) {
    console.warn("Нет статей:", outDirName);
    return 0;
  }

  function chapterBefore(lineIdx) {
    let ch = "00_Без главы";
    for (let i = 0; i < lineIdx; i += 1) {
      if (lines[i].match(CHAPTER_LINE)) ch = lines[i].trim();
    }
    return ch;
  }

  await fs.mkdir(outDir, { recursive: true });
  const preambleEnd = headers[0].lineIndex;
  if (preambleEnd > 0) {
    const pre = lines.slice(0, preambleEnd).join("\n").trimEnd();
    if (pre.length > 0) {
      await fs.writeFile(path.join(outDir, preambleName), `${pre}\n`, "utf-8");
    }
  }

  const usedNames = new Map();
  let count = 0;

  for (let h = 0; h < headers.length; h += 1) {
    const start = headers[h].lineIndex;
    const end = h + 1 < headers.length ? headers[h + 1].lineIndex : lines.length;
    const block = lines.slice(start, end);
    const titleBase = `Статья ${headers[h].num}. ${headers[h].shortTitle}`;
    const currentChapter = chapterBefore(start);
    const chapterDir = path.join(outDir, safeFileName(currentChapter));
    await writeArticleFile(outDir, chapterDir, titleBase, block, usedNames);
    count += 1;
  }

  console.log(`OK ${outDirName}: ${count} статей`);
  return count;
}

/** Конституция: Раздел → папка, Статья N (без точки в заголовке) → файл. */
async function splitConstitution(srcPath, outDirName) {
  const raw = await fs.readFile(srcPath, "utf-8");
  try {
    await fs.unlink(srcPath);
  } catch {
    // исходник уже убран
  }
  const lines = raw.replace(/\r/g, "").split("\n");
  const outDir = path.join(ru, outDirName);

  const headers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(ARTICLE_CONST);
    if (m) {
      headers.push({ lineIndex: i, num: m[1] });
    }
  }
  if (headers.length === 0) {
    console.warn("Конституция: нет статей");
    return 0;
  }

  await fs.mkdir(outDir, { recursive: true });

  const preEnd = headers[0].lineIndex;
  if (preEnd > 0) {
    const pre = lines.slice(0, preEnd).join("\n").trimEnd();
    if (pre.length > 0) {
      await fs.writeFile(path.join(outDir, "00_Преамбула.txt"), `${pre}\n`, "utf-8");
    }
  }

  function sectionFolderAt(articleLineIdx) {
    let current = "Раздел без названия";
    for (let i = 0; i < articleLineIdx; i += 1) {
      const sm = lines[i].match(SECTION_CONST);
      if (sm) {
        let name = lines[i].trim();
        const next = lines[i + 1]?.trim() ?? "";
        if (
          next &&
          !next.match(SECTION_CONST) &&
          !next.match(ARTICLE_CONST) &&
          !next.match(/^\s*Статья\s+/i)
        ) {
          name = `${name} ${next}`;
        }
        current = name;
      }
    }
    return current;
  }

  const usedNames = new Map();
  let count = 0;
  for (let h = 0; h < headers.length; h += 1) {
    const start = headers[h].lineIndex;
    const end = h + 1 < headers.length ? headers[h + 1].lineIndex : lines.length;
    const block = lines.slice(start, end);
    const sec = sectionFolderAt(start);
    const chapterDir = path.join(outDir, safeFileName(sec));
    await writeArticleFile(
      outDir,
      chapterDir,
      `Статья ${headers[h].num}`,
      block,
      usedNames,
    );
    count += 1;
  }

  console.log(`OK ${outDirName}: ${count} статей`);
  return count;
}

/** ПДД: по приложениям и главам (без «статей»), одна глава = один файл. */
async function splitPdd(srcPath, outDirName) {
  const raw = await fs.readFile(srcPath, "utf-8");
  const lines = raw.replace(/\r/g, "").split("\n");
  const outDir = path.join(ru, outDirName);

  const appIdx = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/Приложение\s+[123]\s+к\s+Правилам/i.test(lines[i])) {
      appIdx.push(i);
    }
  }

  const parts = [];
  const names = [
    "01 Основной текст",
    "02 Приложение 1 — Дорожные знаки",
    "03 Приложение 2 — Разметка дорожная",
    "04 Приложение 3 — Сигналы и конструкция ТС",
  ];
  if (appIdx.length < 3) {
    console.warn("ПДД: не найдены все приложения");
  }
  const boundaries = [0, ...appIdx, lines.length];
  for (let p = 0; p < boundaries.length - 1; p += 1) {
    parts.push({
      name: names[p] ?? `Часть ${p + 1}`,
      start: boundaries[p],
      end: boundaries[p + 1],
    });
  }

  await fs.mkdir(outDir, { recursive: true });
  let total = 0;
  const usedGlobal = new Map();

  for (const part of parts) {
    const slice = lines.slice(part.start, part.end);
    const chapterHeaders = [];
    for (let i = 0; i < slice.length; i += 1) {
      const m = slice[i].match(PDD_CHAPTER);
      if (m) {
        chapterHeaders.push({
          lineInPart: i,
          num: m[1],
          title: m[2].trim(),
        });
      }
    }

    if (chapterHeaders.length === 0) {
      const preFile = path.join(
        outDir,
        safeFileName(part.name),
        `${safeFileName(part.name)}.txt`,
      );
      await fs.mkdir(path.dirname(preFile), { recursive: true });
      await fs.writeFile(preFile, `${slice.join("\n").trimEnd()}\n`, "utf-8");
      total += 1;
      continue;
    }

    const partDir = path.join(outDir, safeFileName(part.name));
    await fs.mkdir(partDir, { recursive: true });

    const pre = slice.slice(0, chapterHeaders[0].lineInPart);
    if (pre.join("\n").trim().length > 0) {
      const prePath = path.join(partDir, `00_Вводная часть.txt`);
      await fs.writeFile(prePath, `${pre.join("\n").trimEnd()}\n`, "utf-8");
    }

    for (let c = 0; c < chapterHeaders.length; c += 1) {
      const start = chapterHeaders[c].lineInPart;
      const end =
        c + 1 < chapterHeaders.length
          ? chapterHeaders[c + 1].lineInPart
          : slice.length;
      const block = slice.slice(start, end);
      const titleBase = `Глава ${chapterHeaders[c].num}. ${chapterHeaders[c].title}`;
      const chDir = path.join(partDir, safeFileName(titleBase));
      await writeArticleFile(partDir, chDir, titleBase, block, usedGlobal);
      total += 1;
    }
  }

  console.log(`OK ${outDirName}: ${total} файлов (глав и вводных)`);
  return total;
}

/** all | law | upk | constitution | pdd | tail (конституция + ПДД после первого прогона) */
async function main() {
  const mode = process.argv[2] || "all";

  const runLaw = () =>
    splitLawWithChapters(
      path.join(ru, "Закон Республики Казахстан «О правоохранительной службе».txt"),
      "Закон Республики Казахстан «О правоохранительной службе»",
    );
  const runUpk = () =>
    splitLawWithChapters(
      path.join(ru, "Уголовно-процессуальный кодекс Республики Казахстан.txt"),
      "Уголовно-процессуальный кодекс Республики Казахстан",
    );
  const runConst = () =>
    splitConstitution(
      path.join(ru, "Конституция Республики Казахстан"),
      "Конституция Республики Казахстан",
    );
  const runPdd = () =>
    splitPdd(
      path.join(ru, "Правила дорожного движения Республики Казахстан.txt"),
      "Правила дорожного движения Республики Казахстан",
    );

  if (mode === "tail") {
    await runConst();
    await runPdd();
    try {
      await fs.unlink(path.join(ru, "Правила дорожного движения Республики Казахстан.txt"));
      console.log("Удалён монолит: Правила дорожного движения Республики Казахстан.txt");
    } catch {
      // уже удалён
    }
  } else if (mode === "law") {
    await runLaw();
  } else if (mode === "upk") {
    await runUpk();
  } else if (mode === "constitution") {
    await runConst();
  } else if (mode === "pdd") {
    await runPdd();
  } else {
    await runLaw();
    await runUpk();
    await runConst();
    await runPdd();
  }

  const toRemove = [
    "Закон Республики Казахстан «О правоохранительной службе».txt",
    "Уголовно-процессуальный кодекс Республики Казахстан.txt",
    "Правила дорожного движения Республики Казахстан.txt",
  ];
  if (mode === "all") {
    for (const rel of toRemove) {
      const p = path.join(ru, rel);
      try {
        await fs.unlink(p);
        console.log("Удалён монолит:", rel);
      } catch {
        // уже удалён
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
