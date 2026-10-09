import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const FRONTEND_URL =
  process.env.FRONTEND_URL || "http://localhost:5173";

app.disable("x-powered-by");

app.use(helmet());

app.use(
  cors({
    origin: FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "Asset Oracle API",
    status: "online",
    message: "Real-world truth, on-chain.",
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "asset-oracle-backend",
    timestamp: new Date().toISOString(),
  });
});

app.use((_req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Asset Oracle API listening on port ${PORT}`);
});