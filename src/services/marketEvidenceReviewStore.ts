import { randomUUID } from "node:crypto";
import { database } from "../config/database.js";
import { resolveEvidenceConsensus } from "./marketEvidenceConsensus.js";

export type EvidenceReviewDecision = "ACCEPTED" | "REJECTED";
export type EvidenceReview = {
  validatorAddress: string;
  decision: EvidenceReviewDecision;
  note: string | null;
  reviewedAt: string;
};

export async function listEvidenceReviews(proposalId: string) {
  const result = await database.query(
    `SELECT r.evidence_id, r.validator_address, r.decision, r.note, r.reviewed_at
     FROM market_data_evidence_reviews r
     INNER JOIN market_data_evidence e ON e.id = r.evidence_id
     WHERE e.proposal_id = $1
     ORDER BY r.reviewed_at ASC`,
    [proposalId],
  );
  return result.rows.map((row) => ({
    evidenceId: row.evidence_id as string,
    validatorAddress: row.validator_address as string,
    decision: row.decision as EvidenceReviewDecision,
    note: row.note as string | null,
    reviewedAt: new Date(row.reviewed_at).toISOString(),
  }));
}

export async function submitEvidenceReview(input: {
  proposalId: string;
  evidenceId: string;
  validatorAddress: string;
  decision: EvidenceReviewDecision;
  note?: string;
}) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const evidence = await client.query(
      `SELECT id, verification_status FROM market_data_evidence
       WHERE id = $1 AND proposal_id = $2 FOR UPDATE`,
      [input.evidenceId, input.proposalId],
    );
    if (!evidence.rows[0]) throw new Error("Evidence record not found for this proposal.");
    if (evidence.rows[0].verification_status !== "UNREVIEWED") {
      throw new Error("This evidence record already has a final validator decision.");
    }

    const inserted = await client.query(
      `INSERT INTO market_data_evidence_reviews
        (id, evidence_id, validator_address, decision, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (evidence_id, validator_address) DO NOTHING
       RETURNING validator_address`,
      [randomUUID(), input.evidenceId, input.validatorAddress.toLowerCase(), input.decision, input.note?.trim() || null],
    );
    if (!inserted.rows[0]) throw new Error("You have already reviewed this evidence record.");

    const counts = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE decision = 'ACCEPTED')::int AS accepted,
         COUNT(*) FILTER (WHERE decision = 'REJECTED')::int AS rejected
       FROM market_data_evidence_reviews WHERE evidence_id = $1`,
      [input.evidenceId],
    );
    const accepted = Number(counts.rows[0]?.accepted ?? 0);
    const rejected = Number(counts.rows[0]?.rejected ?? 0);
    const verificationStatus = resolveEvidenceConsensus(accepted, rejected);
    if (verificationStatus !== "UNREVIEWED") {
      await client.query(
        `UPDATE market_data_evidence SET verification_status = $2
         WHERE id = $1 AND verification_status = 'UNREVIEWED'`,
        [input.evidenceId, verificationStatus],
      );
    }
    const reviews = await client.query(
      `SELECT validator_address, decision, note, reviewed_at
       FROM market_data_evidence_reviews WHERE evidence_id = $1 ORDER BY reviewed_at ASC`,
      [input.evidenceId],
    );
    await client.query("COMMIT");
    return {
      verificationStatus,
      acceptedReviews: accepted,
      rejectedReviews: rejected,
      reviews: reviews.rows.map((row) => ({
        validatorAddress: row.validator_address as string,
        decision: row.decision as EvidenceReviewDecision,
        note: row.note as string | null,
        reviewedAt: new Date(row.reviewed_at).toISOString(),
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function listEvidenceReviewQueue(validatorAddress: string) {
  const result = await database.query(
    `SELECT e.id, e.proposal_id, p.question, p.category, e.provider, e.source_url,
            e.retrieved_at, e.content_hash, e.raw_data, e.metric, e.normalized_value,
            e.verification_status, e.created_at,
            (SELECT own.decision FROM market_data_evidence_reviews own
             WHERE own.evidence_id = e.id AND lower(own.validator_address) = lower($1)) AS my_decision,
            COUNT(r.id) FILTER (WHERE r.decision = 'ACCEPTED')::int AS accepted_reviews,
            COUNT(r.id) FILTER (WHERE r.decision = 'REJECTED')::int AS rejected_reviews,
            COALESCE(
              jsonb_agg(jsonb_build_object(
                'validatorAddress', r.validator_address,
                'decision', r.decision,
                'note', r.note,
                'reviewedAt', r.reviewed_at
              )) FILTER (WHERE r.id IS NOT NULL),
              '[]'::jsonb
            ) AS reviews
     FROM market_data_evidence e
     INNER JOIN market_proposals p ON p.id = e.proposal_id
     LEFT JOIN market_data_evidence_reviews r ON r.evidence_id = e.id
     WHERE p.status = 'APPROVED' AND e.verification_status = 'UNREVIEWED'
     GROUP BY e.id, p.question, p.category
     ORDER BY e.retrieved_at DESC
     LIMIT 100`,
    [validatorAddress],
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    proposalId: row.proposal_id as string,
    question: row.question as string,
    category: row.category as string,
    provider: row.provider as string,
    sourceUrl: row.source_url as string,
    retrievedAt: new Date(row.retrieved_at).toISOString(),
    contentHash: row.content_hash as string,
    rawData: row.raw_data,
    metric: row.metric as string,
    normalizedValue: row.normalized_value,
    verificationStatus: row.verification_status as string,
    myDecision: row.my_decision as EvidenceReviewDecision | null,
    createdAt: new Date(row.created_at).toISOString(),
    acceptedReviews: Number(row.accepted_reviews ?? 0),
    rejectedReviews: Number(row.rejected_reviews ?? 0),
    reviews: row.reviews ?? [],
  }));
}
