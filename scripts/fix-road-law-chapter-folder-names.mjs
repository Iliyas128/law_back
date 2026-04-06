/**
 * Убирает дублирование «Глава N. Глава N.» в именах папок после split-road-traffic-law.mjs
 * Запуск: node scripts/fix-road-law-chapter-folder-names.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.join(
  process.cwd(),
  "data",
  "docs",
  "ru",
  "Закон Республики Казахстан «О дорожном движении»",
);

async function main() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = e.name.match(/^Глава (\d+)\.\s+Глава \1\.\s+(.+)$/);
    if (!m) continue;
    const newName = `Глава ${m[1]}. ${m[2]}`;
    await fs.rename(path.join(ROOT, e.name), path.join(ROOT, newName));
    console.log("OK:", newName);
  }
}

main().catch(console.error);
