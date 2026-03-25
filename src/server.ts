import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { authRoutes } from "./routes/authRoutes.js";
import { chatRoutes } from "./routes/chatRoutes.js";
import { docRoutes } from "./routes/docRoutes.js";

const app = express();

app.use(
  cors({
    // Vercel + браузерные preflight иногда ломают кастомную whitelist-логику.
    // Чтобы точно заработало для деплоя, разрешаем запросы с любого Origin,
    // а заголовки CORS будут присутствовать в ответе.
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
// Явно отвечаем на preflight, чтобы `Authorization` корректно проходил.
app.options("*", cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "law_back" });
});

app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/docs", docRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  console.log(`law_back is running on http://localhost:${config.port}`);
});
