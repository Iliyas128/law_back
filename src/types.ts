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
  /** Полный текст фрагмента, попавшего в ответ (для отображения пользователю). */
  text?: string;
}

export interface ChatResponsePayload {
  answer: string;
  law: string;
  article: string;
  sources: SourceRef[];
  /** true, если вместо ответа по нормам задан уточняющий вопрос */
  needs_clarification?: boolean;
}
