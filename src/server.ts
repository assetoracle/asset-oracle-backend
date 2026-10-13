import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routes/health.js";
import { errorHandler } from "./middleware/errorHandler.js";
import marketsRouter from "./routes/markets.js";
import referralsRouter from "./routes/referrals.js";
import statsRouter from "./routes/stats.js";
import { initializeReferralStore } from "./services/referralStore.js";
import { initializeMarketStore } from "./services/marketStore.js";
import { initializeWalletAuth } from "./services/walletAuth.js";
import { initializeOnchainStatsIndexer } from "./services/onchainStatsIndexer.js";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const configuredFrontendOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const allowedFrontendOrigins = new Set([
  ...configuredFrontendOrigins,
  "https://assetoracleapp.xyz",
  "https://www.assetoracleapp.xyz",
  "https://asset-oracle.onrender.com",
]);

app.disable("x-powered-by");
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    // Requests without an Origin header (e.g. server-to-server/health checks)
    // are not browser cross-origin requests and remain permitted.
    if (!origin || allowedFrontendOrigins.has(origin.replace(/\/$/, ""))) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "100kb" }));
app.use("/api/markets", marketsRouter);
app.use("/api/referrals", referralsRouter);
app.use("/api/stats", statsRouter);

app.get("/", (_req, res) => {
  res.json({ name: "Asset Oracle API", status: "online", message: "Real-world truth, on-chain." });
});
app.use("/api/health", healthRouter);
app.use((_req, res) => res.status(404).json({ error: "Endpoint not found" }));
app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    await initializeMarketStore();
    await initializeWalletAuth();
    await initializeReferralStore();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Asset Oracle API listening on port ${PORT}`);
      console.log("Market proposal database initialized");
    });

    if (process.env.ONCHAIN_STATS_INDEXER_ENABLED === "true") {
      try {
        await initializeOnchainStatsIndexer();
      } catch (error) {
        console.error("On-chain stats indexer could not start:", error instanceof Error ? error.message : "Unknown error");
      }
    } else {
      console.log("On-chain stats indexer is disabled; enable only after verifying the Enugu manager address and start block.");
    }
  } catch (error) {
    console.error("Failed to initialize the market proposal database:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
  }
}

void startServer();
