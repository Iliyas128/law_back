import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DOCS_RU = path.join(ROOT, "data", "docs", "ru");

async function walkTxtFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkTxtFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".txt")) {
      out.push(full);
    }
  }
  return out;
}

function parseArticleNumber(fileName) {
  const m = fileName.match(/^Статья\s+(\d+(?:-\d+)?)(?:\.|\s|$)/i);
  return m?.[1] ?? null;
}

function isGenericArticleFile(fileName, articleNumber) {
  return fileName.toLowerCase() === `статья ${articleNumber}.txt`.toLowerCase();
}

async function removeGenericDuplicates(files) {
  const grouped = new Map();
  for (const filePath of files) {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);
    const articleNumber = parseArticleNumber(fileName);
    if (!articleNumber) continue;

    const key = `${dir}||${articleNumber}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(filePath);
  }

  let deleted = 0;
  for (const [key, group] of grouped) {
    if (group.length < 2) continue;

    const articleNumber = key.split("||")[1];
    const generic = group.find((f) => isGenericArticleFile(path.basename(f), articleNumber));
    const titled = group.find((f) => !isGenericArticleFile(path.basename(f), articleNumber));

    if (generic && titled) {
      await fs.unlink(generic);
      deleted += 1;
    }
  }
  return deleted;
}

async function normalizeHeaders(files) {
  let fixed = 0;

  for (const filePath of files) {
    const stem = path.basename(filePath, ".txt");
    if (!/^Статья\s+\d+(?:-\d+)?/i.test(stem)) continue;

    const raw = (await fs.readFile(filePath, "utf-8")).replace(/\r/g, "");
    const lines = raw.split("\n");
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    if (lines.length === 0) continue;

    const firstLine = lines[0].trim();
    if (!/^Статья\s+\d+(?:-\d+)?\./i.test(firstLine)) {
      const normalized = `${stem}\n\n${lines.join("\n").trimStart()}`;
      await fs.writeFile(filePath, normalized.endsWith("\n") ? normalized : `${normalized}\n`, "utf-8");
      fixed += 1;
    }
  }

  return fixed;
}

async function main() {
  const before = await walkTxtFiles(DOCS_RU);
  const deleted = await removeGenericDuplicates(before);
  const afterDelete = await walkTxtFiles(DOCS_RU);
  const headerFixed = await normalizeHeaders(afterDelete);

  console.log(`deleted_generic_duplicates=${deleted}`);
  console.log(`header_fixed=${headerFixed}`);
  console.log(`total_files_now=${afterDelete.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
