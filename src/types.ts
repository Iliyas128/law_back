export type UserRole = "citizen" | "official";
export type Language = "ru" | "kz";

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
}

export interface SourceRef {
  law: string;
  article: string;
  lang: Language;
}

export interface ChatResponsePayload {
  answer: string;
  law: string;
  article: string;
  sources: SourceRef[];
}
