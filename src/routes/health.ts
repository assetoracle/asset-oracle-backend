import { Router } from "express";

const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "asset-oracle-backend",
    timestamp: new Date().toISOString(),
  });
});

export default healthRouter;