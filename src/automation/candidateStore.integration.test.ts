import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import type { MarketCandidate } from "./types.js";

const testDatabaseUrl = process.env.AUTOMATION_TEST_DATABASE_URL;
const enabled = Boolean(testDatabaseUrl);

function assertSafeTestDatabase(connectionString: string): URL {
  const url = new URL(connectionString);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/(^|[-_])test($|[-_])/i.test(databaseName) && !/^localhost$|^127\.0\.0\.1$|^::1$/.test(url.hostname)) {
    throw new Error("AUTOMATION_TEST_DATABASE_URL must target a clearly named test database or localhost.");
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === connectionString) {
    throw new Error("Refusing to run automation integration tests against DATABASE_URL.");
  }
  return url;
}

const skipReason = enabled
  ? false
  : "Set AUTOMATION_TEST_DATABASE_URL to an isolated PostgreSQL test database to run these integration tests.";

test("PostgreSQL candidate persistence preserves initial evidence and appends distinct observations", { skip: skipReason }, async () => {
  const connectionString = testDatabaseUrl!;
  const parsed = assertSafeTestDatabase(connectionString);
  const adminPool = new pg.Pool({ connectionString, max: 1 });
  const schema = "automation_it_" + randomUUID().replace(/-/g, "");
  const quoteIdentifier = (value: string) => '"' + value.replace(/"/g, '""') + '"';
  let scopedPool: pg.Pool | undefined;
  let closeStorePool: (() => Promise<void>) | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  try {
    await adminPool.query("CREATE SCHEMA " + quoteIdentifier(schema));
    const scopedUrl = new URL(parsed.toString());
    scopedUrl.searchParams.set("options", "-c search_path=" + schema);
    process.env.DATABASE_URL = scopedUrl.toString();
    // Import only after setting DATABASE_URL so the store uses the isolated schema.
    const store = await import("./candidateStore.js");
    const databaseModule = await import("../config/database.js");
    closeStorePool = () => databaseModule.database.end();
    scopedPool = new pg.Pool({ connectionString: scopedUrl.toString(), max: 1 });
    // The store's pool and this scoped pool share the same isolated schema.
    await store.initializeAutomationCandidateStore();

    const now = new Date();
    const first: MarketCandidate = {
      key: "integration-" + randomUUID(),
      proposal: {
        question: "Will integration-test Bitcoin exceed 100 USD at the test observation time?",
        description: "Integration-test candidate; not intended for publication.",
        category: "Crypto",
        closesAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
        resolvesAt: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
        resolutionRule: {
          sourceId: "coingecko",
          metric: "price_usd",
          comparison: "AT_LEAST",
          targetValue: 100,
          currency: "USD",
          observationTime: new Date(now.getTime() + 2 * 60 * 60_000).toISOString(),
          description: "Integration test rule requiring a timestamped USD price observation.",
        },
      },
      evidence: {
        provider: "coingecko",
        metric: "price_usd",
        assetId: "bitcoin",
        observedAt: new Date(now.getTime() - 5_000).toISOString(),
        retrievedAt: now.toISOString(),
        value: 95,
        currency: "USD",
        sourceUrl: "https://www.coingecko.com/en/coins/bitcoin",
        rawResponse: { usd: 95 },
      },
      quality: { score: 70, reasons: ["integration test"] },
    };

    assert.deepEqual(await store.upsertAutomationCandidates([first]), { inserted: 1, existing: 0 });
    const changedObservation = {
      ...first,
      evidence: { ...first.evidence, observedAt: new Date(now.getTime() - 1_000).toISOString(), value: 96 },
    };
    assert.deepEqual(await store.upsertAutomationCandidates([changedObservation]), { inserted: 0, existing: 1 });
    assert.deepEqual(await store.upsertAutomationCandidates([changedObservation]), { inserted: 0, existing: 1 });

    const captured = await store.recordProviderObservations([first.evidence, changedObservation.evidence]);
    assert.deepEqual(captured, { inserted: 2, existing: 0 });
    const target = changedObservation.evidence.observedAt;
    const matching = await store.findPriceObservations({
      provider: "coingecko", metric: "price_usd", assetId: "bitcoin",
      targetAt: target, toleranceSeconds: 2,
    });
    assert.equal(matching.length, 1, "observations outside the explicit time tolerance must not be selected");
    assert.equal(matching[0].value, 96);

    const candidate = await store.listAutomationCandidates({ limit: 100 });
    const stored = candidate.find((item) => item.key === first.key);
    assert.ok(stored);
    assert.equal(stored.evidence.value, 95, "original evidence must remain immutable");

    const observations = await scopedPool.query(
      "SELECT value, retrieved_at, raw_response FROM automation_candidate_observations WHERE candidate_id = $1 ORDER BY observed_at",
      [stored.id],
    );
    assert.deepEqual(observations.rows.map((row) => Number(row.value)), [95, 96]);
    assert.ok(observations.rows.every((row) => row.retrieved_at));
    assert.deepEqual(observations.rows.map((row) => row.raw_response.usd), [95, 96]);

    const rollbackKey = "integration-rollback-" + randomUUID();
    await assert.rejects(
      store.upsertAutomationCandidates([{
        ...first,
        key: rollbackKey,
        evidence: { ...first.evidence, observedAt: "not-a-timestamp" },
      }]),
      "invalid observation timestamps must fail the transaction",
    );
    const rolledBackCandidate = await scopedPool.query(
      "SELECT id FROM automation_market_candidates WHERE candidate_key = $1",
      [rollbackKey],
    );
    assert.equal(rolledBackCandidate.rowCount, 0, "candidate row must roll back when observation persistence fails");

    const dismissed = await store.reviewAutomationCandidate({
      id: stored.id, adminWallet: "0x0000000000000000000000000000000000000001",
      action: "DISMISS", reason: "integration test dismissal",
    });
    assert.equal(dismissed?.status, "DISMISSED");
    assert.equal(await store.reviewAutomationCandidate({
      id: stored.id, adminWallet: "0x0000000000000000000000000000000000000001",
      action: "DISMISS", reason: "duplicate transition should not be audited",
    }), null);
    const restored = await store.reviewAutomationCandidate({
      id: stored.id, adminWallet: "0x0000000000000000000000000000000000000001",
      action: "RESTORE", reason: "integration test restore",
    });
    assert.equal(restored?.status, "PENDING_REVIEW");

    const audits = await scopedPool.query(
      "SELECT action, reason FROM automation_candidate_review_events WHERE candidate_id = $1 ORDER BY created_at",
      [stored.id],
    );
    assert.deepEqual(audits.rows.map((row) => row.action), ["DISMISS", "RESTORE"]);

    // The configured policy is one approval out of Admin + two market makers.
    const firstApproval = await store.approveAutomationCandidate({
      id: stored.id,
      approverWallet: "0x0000000000000000000000000000000000000001",
      approverRole: "ADMIN",
    });
    assert.equal(firstApproval?.approvalCount, 1);
    assert.equal(firstApproval?.newlyApproved, true);
    assert.equal(firstApproval?.candidate.status, "APPROVED_FOR_PUBLICATION");

    // A repeated approval from the same wallet is idempotent and cannot inflate the count.
    const duplicateApproval = await store.approveAutomationCandidate({
      id: stored.id,
      approverWallet: "0x0000000000000000000000000000000000000001",
      approverRole: "ADMIN",
    });
    assert.equal(duplicateApproval?.approvalCount, 1);
    assert.equal(duplicateApproval?.newlyApproved, false);

    // Dismissed candidates cannot be approved.
    const dismissedKey = "integration-dismissed-" + randomUUID();
    await store.upsertAutomationCandidates([{ ...first, key: dismissedKey }]);
    const dismissedCandidate = (await store.listAutomationCandidates({ limit: 100 }))
      .find((item) => item.key === dismissedKey);
    assert.ok(dismissedCandidate);
    assert.equal((await store.reviewAutomationCandidate({
      id: dismissedCandidate.id,
      adminWallet: "0x0000000000000000000000000000000000000001",
      action: "DISMISS",
      reason: "must remain ineligible for approval",
    }))?.status, "DISMISSED");
    assert.equal(await store.approveAutomationCandidate({
      id: dismissedCandidate.id,
      approverWallet: "0x0000000000000000000000000000000000000002",
      approverRole: "MARKET_MAKER",
    }), null);
  } finally {
    if (scopedPool) await scopedPool.end();
    if (closeStorePool) await closeStorePool();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    await adminPool.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    await adminPool.end();
  }
});
