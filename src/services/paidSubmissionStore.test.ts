import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
const { database } = await import("../config/database.js");
const {
  validateSubmissionPayment,
  recordConfirmedSubmissionPayment,
  queueSubmissionRefund,
  recordSubmissionRefund,
  markPublicationRetryRequired,
  markSubmissionPublished,
  recordPaidSubmissionDecisionForProposal,
  markPaidSubmissionPublishedForProposal,
} = await import("./paidSubmissionStore.js");

type Row = Record<string, unknown>;
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>;
const db = database as unknown as { query: Query };
const originalQuery = db.query;
afterEach(() => { db.query = originalQuery; });

test("allows only exact 10 USDC testnet proposal payments", () => {
  assert.doesNotThrow(() => validateSubmissionPayment({
    network: "TESTNET", token: "USDC", amountAtomic: "10000000", expectedAmountAtomic: "10000000",
  }));
  for (const token of ["USDT", "cNGN"] as const) {
    assert.throws(() => validateSubmissionPayment({
      network: "TESTNET", token, amountAtomic: "10000000", expectedAmountAtomic: "10000000",
    }), /not enabled/);
  }
  assert.throws(() => validateSubmissionPayment({
    network: "MAINNET", token: "USDC", amountAtomic: "10000000", expectedAmountAtomic: "10000000",
  }), /not enabled/);
  assert.throws(() => validateSubmissionPayment({
    network: "TESTNET", token: "USDC", amountAtomic: "999", expectedAmountAtomic: "10000000",
  }), /does not match/);
});

test("payment confirmation is idempotent for the same transaction and rejects a different payment", async () => {
  let updateCount = 0;
  db.query = async (sql, values) => {
    if (sql.includes("UPDATE paid_market_submissions")) {
      updateCount++;
      if (updateCount === 1) return { rows: [{ id: "submission-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT status, payment_tx_hash")) {
      return { rows: [{ status: "PAID_PENDING_REVIEW", payment_tx_hash: values?.[0] === "submission-1" ? "0x" + "a".repeat(64) : null }], rowCount: 1 };
    }
    throw new Error("Unexpected query: " + sql);
  };
  const tx = "0x" + "a".repeat(64);
  await recordConfirmedSubmissionPayment({ id: "submission-1", paymentTxHash: tx });
  await recordConfirmedSubmissionPayment({ id: "submission-1", paymentTxHash: tx });
  await assert.rejects(recordConfirmedSubmissionPayment({
    id: "submission-1", paymentTxHash: "0x" + "b".repeat(64),
  }), /not awaiting payment|already recorded differently/);
});

test("refund queue only accepts paid submissions pending review", async () => {
  db.query = async (sql) => {
    if (sql.includes("UPDATE paid_market_submissions")) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT status FROM paid_market_submissions")) return { rows: [{ status: "AWAITING_PAYMENT" }], rowCount: 1 };
    throw new Error("Unexpected query: " + sql);
  };
  await assert.rejects(queueSubmissionRefund("submission-1"), /Only a paid submission/);
});

test("refund recording requires a valid transaction hash and is idempotent", async () => {
  let calls = 0;
  db.query = async (sql, values) => {
    if (sql.includes("UPDATE paid_market_submissions")) {
      calls++;
      return calls === 1 ? { rows: [{ id: "submission-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT status, refund_tx_hash")) return {
      rows: [{ status: "REFUNDED", refund_tx_hash: values?.[0] === "submission-1" ? "0x" + "c".repeat(64) : null }], rowCount: 1,
    };
    throw new Error("Unexpected query: " + sql);
  };
  const tx = "0x" + "c".repeat(64);
  await assert.rejects(recordSubmissionRefund({ id: "submission-1", refundTxHash: "invalid" }), /valid confirmed refund/);
  await recordSubmissionRefund({ id: "submission-1", refundTxHash: tx });
  await recordSubmissionRefund({ id: "submission-1", refundTxHash: tx });
});

test("publication retry is recoverable and published market ID cannot silently change", async () => {
  let updateCalls = 0;
  let pointsInsertCalls = 0;
  db.query = async (sql, values) => {
    if (sql.includes("UPDATE paid_market_submissions")) {
      updateCalls++;
      return updateCalls === 1 ? { rows: [{ id: "submission-1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT status, published_market_id")) return {
      rows: [{ status: "PUBLISHED", published_market_id: values?.[0] === "submission-1" ? "12" : null }], rowCount: 1,
    };
    if (sql.includes("SELECT wallet_address, proposal_id")) return {
      rows: [{ wallet_address: "0x" + "1".repeat(40), proposal_id: "proposal-1" }], rowCount: 1,
    };
    if (sql.includes("INSERT INTO leaderboard_point_events")) {
      pointsInsertCalls++;
      return pointsInsertCalls === 1
        ? { rows: [{ points: 50 }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("SELECT wallet_address, points FROM leaderboard_point_events")) {
      return { rows: [{ wallet_address: "0x" + "1".repeat(40), points: 50 }], rowCount: 1 };
    }
    if (sql.includes("SELECT COALESCE(SUM(points)")) return { rows: [{ total_points: "50" }], rowCount: 1 };
    throw new Error("Unexpected query: " + sql);
  };
  await markPublicationRetryRequired("submission-1");
  await markSubmissionPublished({ id: "submission-1", marketId: "12" });
  // Retrying the same confirmed publication must re-check the same idempotent event key.
  await markSubmissionPublished({ id: "submission-1", marketId: "12" });
  assert.equal(pointsInsertCalls, 2);
  await assert.rejects(markSubmissionPublished({ id: "submission-1", marketId: "13" }), /cannot be marked published/);
});


test("paid review decisions require confirmed payment and queue rejected proposals for refund", async () => {
  let currentStatus = "PAID_PENDING_REVIEW";
  db.query = async (sql, values) => {
    if (sql.includes("SELECT id, status FROM paid_market_submissions")) {
      return { rows: [{ id: "submission-2", status: currentStatus }], rowCount: 1 };
    }
    if (sql.includes("UPDATE paid_market_submissions")) {
      currentStatus = String(values?.[1]);
      return { rows: [{ id: "submission-2" }], rowCount: 1 };
    }
    throw new Error("Unexpected query: " + sql);
  };
  assert.equal(await recordPaidSubmissionDecisionForProposal("proposal-2", "REJECTED"), true);
  assert.equal(currentStatus, "REJECTED_REFUND_PENDING");
  await assert.rejects(recordPaidSubmissionDecisionForProposal("proposal-2", "APPROVED"), /confirmed payment and be pending review/);
});

test("publication reward bridge ignores ordinary proposals and delegates paid proposals to the idempotent award path", async () => {
  let lookupRows: Row[] = [];
  db.query = async (sql) => {
    if (sql.includes("SELECT id FROM paid_market_submissions WHERE proposal_id")) {
      return { rows: lookupRows, rowCount: lookupRows.length };
    }
    if (sql.includes("UPDATE paid_market_submissions")) return { rows: [{ id: "submission-3" }], rowCount: 1 };
    if (sql.includes("SELECT wallet_address, proposal_id")) {
      return { rows: [{ wallet_address: "0x" + "2".repeat(40), proposal_id: "proposal-3" }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO leaderboard_point_events")) return { rows: [{ points: 50 }], rowCount: 1 };
    if (sql.includes("SELECT COALESCE(SUM(points)")) return { rows: [{ total_points: "50" }], rowCount: 1 };
    throw new Error("Unexpected query: " + sql);
  };
  assert.equal(await markPaidSubmissionPublishedForProposal({ proposalId: "ordinary-proposal", marketId: "22" }), false);
  lookupRows = [{ id: "submission-3" }];
  assert.equal(await markPaidSubmissionPublishedForProposal({ proposalId: "proposal-3", marketId: "22" }), true);
});


test("admin decision updates proposal and paid submission in one transaction", async () => {
  const originalConnect = (database as unknown as { connect: () => Promise<unknown> }).connect;
  const statements: string[] = [];
  let proposalStatus = "PENDING_APPROVAL";
  let paidStatus = "PAID_PENDING_REVIEW";
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql.trim().split(/\\s+/).slice(0, 3).join(" "));
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT id, status FROM market_proposals")) {
        return { rows: [{ id: "proposal-1", status: proposalStatus }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, status FROM paid_market_submissions")) {
        return { rows: [{ id: "submission-1", status: paidStatus }], rowCount: 1 };
      }
      if (sql.includes("UPDATE market_proposals")) {
        proposalStatus = String(values?.[1]);
        return { rows: [{ id: "proposal-1" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE paid_market_submissions")) {
        paidStatus = String(values?.[1]);
        return { rows: [{ id: "submission-1" }], rowCount: 1 };
      }
      throw new Error("Unexpected client query: " + sql);
    },
    release: () => {},
  };
  (database as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
  try {
    const { decideMarketProposalAtomically } = await import("./paidSubmissionStore.js");
    assert.equal(await decideMarketProposalAtomically({ proposalId: "proposal-1", decision: "REJECTED" }), "UPDATED");
    assert.equal(proposalStatus, "REJECTED");
    assert.equal(paidStatus, "REJECTED_REFUND_PENDING");
    assert.equal(statements[0], "BEGIN");
    assert.equal(statements.at(-1), "COMMIT");
  } finally {
    (database as unknown as { connect: () => Promise<unknown> }).connect = originalConnect;
  }
});

test("admin decision rolls back proposal status when paid state cannot be updated", async () => {
  const originalConnect = (database as unknown as { connect: () => Promise<unknown> }).connect;
  const statements: string[] = [];
  let proposalUpdateAttempted = false;
  const client = {
    query: async (sql: string) => {
      statements.push(sql.trim());
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT id, status FROM market_proposals")) {
        return { rows: [{ id: "proposal-2", status: "PENDING_APPROVAL" }], rowCount: 1 };
      }
      if (sql.includes("SELECT id, status FROM paid_market_submissions")) {
        return { rows: [{ id: "submission-2", status: "PAID_PENDING_REVIEW" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE market_proposals")) {
        proposalUpdateAttempted = true;
        return { rows: [{ id: "proposal-2" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE paid_market_submissions")) return { rows: [], rowCount: 0 };
      throw new Error("Unexpected client query: " + sql);
    },
    release: () => {},
  };
  (database as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
  try {
    const { decideMarketProposalAtomically } = await import("./paidSubmissionStore.js");
    await assert.rejects(
      decideMarketProposalAtomically({ proposalId: "proposal-2", decision: "APPROVED" }),
      /state changed while applying/,
    );
    assert.equal(proposalUpdateAttempted, true);
    assert.equal(statements.at(-1), "ROLLBACK");
    assert.equal(statements.includes("COMMIT"), false);
  } finally {
    (database as unknown as { connect: () => Promise<unknown> }).connect = originalConnect;
  }
});
