import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routes/health.js";
import { errorHandler } from "./middleware/errorHandler.js";
import marketsRouter from "./routes/markets.js";
import { initializeMarketStore } from "./services/marketStore.js";
import { initializeWalletAuth } from "./services/walletAuth.js";

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
app.use("/api/markets", marketsRouter);

app.get("/", (_req, res) => {
  res.json({
    name: "Asset Oracle API",
    status: "online",
    message: "Real-world truth, on-chain.",
  });
});

app.use("/api/health", healthRouter);

app.use((_req, res) => {
  res.status(404).json({
    error: "Endpoint not found",
  });
});

app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    await initializeMarketStore();
    await initializeWalletAuth();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Asset Oracle API listening on port ${PORT}`);
      console.log("Market proposal database initialized");
    });
  } catch (error) {
    console.error(
      "Failed to initialize the market proposal database:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exit(1);
  }
}

void startServer();