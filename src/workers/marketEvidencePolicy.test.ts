import assert from "node:assert/strict";
import { test } from "node:test";
import { selectEvidenceEligibleProposals } from "./marketEvidencePolicy.js";

test("evidence selection includes approved manual and automated proposals until resolution", () => {
  const now = Date.parse("2026-11-12T12:00:00.000Z");
  const proposals = [
    { id: "manual", origin: "MANUAL", status: "APPROVED", resolvesAt: "2026-11-14T00:00:00.000Z" },
    { id: "automated", origin: "AUTOMATED", status: "APPROVED", resolvesAt: "2026-11-13T00:00:00.000Z" },
    { id: "pending", origin: "AUTOMATED", status: "PENDING_APPROVAL", resolvesAt: "2026-11-15T00:00:00.000Z" },
    { id: "resolved", origin: "MANUAL", status: "APPROVED", resolvesAt: "2026-11-11T00:00:00.000Z" },
  ];
  assert.deepEqual(
    selectEvidenceEligibleProposals(proposals, now).map((proposal) => proposal.id),
    ["automated", "manual"],
  );
});
