import fs from "node:fs";
import path from "node:path";

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

const repoRoot = process.cwd();
const src = path.resolve(repoRoot, "data", "docs");
const dest = path.resolve(repoRoot, "dist", "data", "docs");

if (!exists(src)) {
  // Nothing to copy (local dev might not have docs yet)
  process.exit(0);
}

fs.mkdirSync(path.dirname(dest), { recursive: true });

// Clean destination to keep it in sync.
if (exists(dest)) {
  fs.rmSync(dest, { recursive: true, force: true });
}

// Node 16+ supports recursive cp.
fs.cpSync(src, dest, { recursive: true });

console.log(`Copied docs: ${src} -> ${dest}`);

