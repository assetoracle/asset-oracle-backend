import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  _next,
) => {
  console.error("API request failed:", error);

  if (res.headersSent) {
    return;
  }

  const message = error instanceof Error ? error.message : "";
  const name = error instanceof Error ? error.name : "";
  const receiptUnavailable =
    /TransactionReceiptNotFoundError|TransactionNotFoundError/.test(name) ||
    /transaction receipt.*could not be found|transaction.*could not be found|could not be found.*transaction/i.test(message);

  // A missing transaction from the configured RPC is an upstream verification
  // failure, not an application crash. Never mark the refund verified here.
  if (receiptUnavailable) {
    res.status(502).json({
      error: "The configured Asset Chain Testnet RPC could not find this transaction or its receipt. The refund has NOT been recorded as verified. Check the transaction on the testnet explorer and retry when the RPC can retrieve it.",
      code: "REFUND_TRANSACTION_NOT_FOUND",
    });
    return;
  }

  const statusCode =
    typeof error?.status === "number" &&
    error.status >= 400 &&
    error.status < 600
      ? error.status
      : 500;

  res.status(statusCode).json({
    error:
      statusCode === 500
        ? "Internal server error"
        : "Request could not be completed",
  });
};