import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import healthRouter from "./routes/health.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { createRateLimiter } from "./middleware/rateLimit.js";
import { createPublicMarketsCache } from "./middleware/publicMarketsCache.js";
import marketsRouter from "./routes/markets.js";
import paidSubmissionsRouter from "./routes/paidSubmissions.js";
import validatorEvidenceRouter from "./routes/validatorEvidence.js";
import referralsRouter from "./routes/referrals.js";
import statsRouter from "./routes/stats.js";
import dataSourcesRouter from "./routes/dataSources.js";
import { database } from "./config/database.js";
import { initializeReferralStore } from "./services/referralStore.js";
import { initializeMarketStore } from "./services/marketStore.js";
import { initializeValidatorEvidenceStore } from "./services/validatorEvidenceStore.js";
import { initializeMarketEvidenceStore } from "./services/marketEvidenceStore.js";
import { initializeMarketResolutionVerificationStore } from "./services/marketResolutionVerification.js";
import { initializeMarketGenerationStore } from "./services/marketGenerationStore.js";
import marketEvidenceRouter from "./routes/marketEvidence.js";
import marketCandidatesRouter from "./routes/marketCandidates.js";
import { initializeWalletAuth } from "./services/walletAuth.js";
import { initializeAssetChainIndexer } from "./services/assetChainIndexer.js";
import { initializeOnchainStatsIndexer } from "./services/onchainStatsIndexer.js";
import { initializePointsStore } from "./services/pointsStore.js";
import { initializePaidSubmissionStore } from "./services/paidSubmissionStore.js";
import { initializeSubmissionQuoteStore } from "./services/submissionQuoteStore.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception; exiting process:", error);
  process.exit(1);
});

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
  "https://asset-oracle.vercel.app",
  "https://asset-oracle-git-milestone-1-connectivity-fixes-asset-oracle.vercel.app",
  "https://asset-oracle.onrender.com",
]);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
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

app.use("/api/markets/public", createRateLimiter({ windowMs: 60_000, max: 60 }));
app.use("/api/markets/public", createPublicMarketsCache({ ttlMs: 15_000 }));
app.use("/api/stats/wallet", createRateLimiter({ windowMs: 60_000, max: 6 }));
app.use("/api/markets", marketsRouter);
app.use("/api/markets/paid-submissions", paidSubmissionsRouter);
app.use("/api/validator-evidence", validatorEvidenceRouter);
app.use("/api/market-evidence", marketEvidenceRouter);
app.use("/api/market-candidates", marketCandidatesRouter);
app.use("/api/referrals", referralsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/data-sources", dataSourcesRouter);

app.get("/", (_req, res) => {
  res.json({ name: "Asset Oracle API", status: "online", message: "Real-world truth, on-chain." });
});
app.use("/api/health", healthRouter);
app.use((_req, res) => res.status(404).json({ error: "Endpoint not found" }));
app.use(errorHandler);

async function startServer(): Promise<void> {
  try {
    await initializeMarketStore();
    await initializeValidatorEvidenceStore();
    await initializeMarketEvidenceStore();
    await initializeMarketResolutionVerificationStore();
    await database.query(`
      CREATE TABLE IF NOT EXISTS market_lifecycle_transactions (
        id BIGSERIAL PRIMARY KEY,
        chain_id INTEGER NOT NULL CHECK (chain_id = 42421),
        manager_address TEXT NOT NULL,
        market_id TEXT NOT NULL,
        transaction_type TEXT NOT NULL,
        transaction_hash TEXT NOT NULL UNIQUE,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await initializeMarketGenerationStore();
    await initializeWalletAuth();
    await initializeReferralStore();
    await initializePointsStore();
    await initializePaidSubmissionStore();
    await initializeSubmissionQuoteStore();

    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Asset Oracle API listening on port ${PORT}`);
      console.log("Market proposal database initialized");
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    if (process.env.ONCHAIN_STATS_INDEXER_ENABLED === "true") {
      try {
        await initializeOnchainStatsIndexer();
      } catch (error) {
        console.error("On-chain dashboard statistics indexer could not start:", error instanceof Error ? error.message : "Unknown error");
      }
    } else {
      console.log("On-chain dashboard statistics indexer is disabled; dashboard volume and event metrics remain unavailable.");
    }

    if (process.env.ASSET_CHAIN_INDEXER_ENABLED === "true") {
      try {
        await initializeAssetChainIndexer();
      } catch (error) {
        console.error("Full Asset Chain indexer could not start:", error instanceof Error ? error.message : "Unknown error");
      }
    } else {
      console.log("Full Asset Chain indexer is disabled until its RPC and start block are configured.");
    }
  } catch (error) {
    console.error("Failed to initialize the market proposal database:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
  }
}

void startServer();
