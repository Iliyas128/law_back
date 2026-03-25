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
const manifestPath = path.resolve(repoRoot, "dist", "docs-manifest.json");

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

// Create manifest with relative paths to all .txt files.
// It will be used at runtime if Vercel serverless FS doesn't include the docs directory.
async function listTxtRecursive(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listTxtRecursive(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".txt")) {
      results.push(full);
    }
  }
  return results;
}

const files = await listTxtRecursive(src);
const relPaths = files.map((abs) => path.relative(repoRoot, abs).replace(/\\/g, "/"));

fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify({ files: relPaths }, null, 2), "utf-8");
console.log(`Wrote docs manifest: ${manifestPath} (${relPaths.length} files)`);

