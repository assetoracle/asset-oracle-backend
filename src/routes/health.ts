import { Router } from "express";
import { checkDatabaseConnection } from "../config/database.js";

const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "asset-oracle-backend",
    timestamp: new Date().toISOString(),
  });
});

healthRouter.get("/database", async (_req, res) => {
  try {
    await checkDatabaseConnection();

    res.status(200).json({
      status: "healthy",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: "unhealthy",
      database: "disconnected",
      timestamp: new Date().toISOString(),
    });
  }
});

export default healthRouter;