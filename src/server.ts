import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { corsMiddleware } from "./cors.js";
import { authRoutes } from "./routes/authRoutes.js";
import { chatRoutes } from "./routes/chatRoutes.js";
import { docRoutes } from "./routes/docRoutes.js";

const app = express();

app.use(corsMiddleware);

app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept", "X-Requested-With"],
  }),
);

app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "law_back", corsOrigins: config.corsOrigins });
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

export default app;
export { app };

if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`law_back is running on http://localhost:${config.port}`);
    console.log(`CORS origins: ${config.corsOrigins.join(", ")}`);
  });
}
