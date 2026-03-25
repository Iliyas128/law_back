import type { AuthUser } from "../types.js";

const USERS = [
  { id: "u-1", username: "citizen", password: "citizen123", role: "citizen" as const },
  { id: "u-2", username: "official", password: "official123", role: "official" as const },
];

export function validateUser(username: string, password: string): AuthUser | null {
  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    return null;
  }

  return { id: user.id, username: user.username, role: user.role };
}
