import { promises as fs } from "node:fs";
import path from "node:path";
import type { RagChunk } from "./types.js";

export class VectorStore {
  constructor(private readonly dbFilePath: string) {}

  async load(): Promise<RagChunk[]> {
    try {
      const raw = await fs.readFile(this.dbFilePath, "utf-8");
      return JSON.parse(raw) as RagChunk[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async save(chunks: RagChunk[]): Promise<void> {
    await fs.mkdir(path.dirname(this.dbFilePath), { recursive: true });
    await fs.writeFile(this.dbFilePath, JSON.stringify(chunks, null, 2), "utf-8");
  }
}
