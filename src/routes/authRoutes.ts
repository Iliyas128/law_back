import { Router } from "express";
import { z } from "zod";
import { validateUser } from "../auth/users.js";
import { createAccessToken } from "../auth/jwt.js";

const loginSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(3),
});

export const authRoutes = Router();

authRoutes.post("/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload", details: parsed.error.flatten() });
    return;
  }

  const user = validateUser(parsed.data.username, parsed.data.password);
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = createAccessToken(user);
  res.json({
    token,
    user,
  });
});
