import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { AuthUser } from "../types.js";

export interface AccessTokenPayload {
  sub: string;
  username: string;
  role: AuthUser["role"];
}

export function createAccessToken(user: AuthUser): string {
  const payload: AccessTokenPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
  };

  return jwt.sign(payload, config.jwtSecret, { expiresIn: "7d" });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AccessTokenPayload;
}
