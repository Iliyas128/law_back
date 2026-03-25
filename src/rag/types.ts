import type { Language } from "../types.js";

export interface RagChunk {
  id: string;
  content: string;
  embedding: number[];
  law: string;
  article: string;
  lang: Language;
  sourcePath: string;
}
