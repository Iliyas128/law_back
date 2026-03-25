import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { authRoutes } from "./routes/authRoutes.js";
import { chatRoutes } from "./routes/chatRoutes.js";
import { docRoutes } from "./routes/docRoutes.js";

const app = express();

// Жесткий preflight-обработчик: некоторые прокси/рендеры на Vercel возвращают 404/без CORS
// на OPTIONS, поэтому браузер ломается. Здесь мы всегда отвечаем корректными CORS-заголовками.
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.origin;
    res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.status(204).end();
    return;
  }
  next();
});

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
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "law_back" });
});

app.use("/api/auth", authRoutes);
app.use("/api/chat", chatRoutes);
app.use("/api/docs", docRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({
    error: "Internal server error",
    details: err instanceof Error ? err.message : String(err),
  });
});

app.listen(config.port, () => {
  console.log(`law_back is running on http://localhost:${config.port}`);
});
