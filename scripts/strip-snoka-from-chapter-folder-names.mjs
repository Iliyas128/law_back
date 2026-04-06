/**
 * Убирает из имён папок глав хвост « Сноска. …», попавший между заголовком главы и статьёй.
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
    const idx = e.name.indexOf(" Сноска.");
    if (idx === -1) continue;
    const newName = e.name.slice(0, idx).trimEnd();
    await fs.rename(path.join(ROOT, e.name), path.join(ROOT, newName));
    console.log("OK:", newName);
  }
}

main().catch(console.error);
