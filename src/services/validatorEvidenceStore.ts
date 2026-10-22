import { database } from "../config/database.js";

export type ValidatorSourceLink = {
  marketId: string;
  managerAddress: string;
  validatorAddress: string;
  outcome: number;
  sourceUrl: string;
  transactionHash: string;
  recordedAt: string;
};

export async function initializeValidatorEvidenceStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS validator_source_links (
      id BIGSERIAL PRIMARY KEY,
      chain_id INTEGER NOT NULL CHECK (chain_id = 42421),
      manager_address TEXT NOT NULL,
      market_id TEXT NOT NULL,
      validator_address TEXT NOT NULL,
      outcome SMALLINT NOT NULL CHECK (outcome IN (1, 2, 3)),
      source_url TEXT NOT NULL,
      transaction_hash TEXT NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (chain_id, lower(manager_address), market_id, lower(validator_address))
    )
  `);
}

export async function recordValidatorSourceLink(input: {
  marketId: string;
  managerAddress: string;
  validatorAddress: string;
  outcome: number;
  sourceUrl: string;
  transactionHash: string;
}): Promise<ValidatorSourceLink> {
  const result = await database.query<{
    market_id: string; manager_address: string; validator_address: string;
    outcome: number; source_url: string; transaction_hash: string; recorded_at: Date;
  }>(`
    INSERT INTO validator_source_links
      (chain_id, manager_address, market_id, validator_address, outcome, source_url, transaction_hash)
    VALUES (42421, lower($1), $2, lower($3), $4, $5, lower($6))
    ON CONFLICT (chain_id, lower(manager_address), market_id, lower(validator_address))
    DO NOTHING
    RETURNING market_id, manager_address, validator_address, outcome, source_url, transaction_hash, recorded_at
  `, [input.managerAddress, input.marketId, input.validatorAddress, input.outcome, input.sourceUrl, input.transactionHash]);
  if (!result.rows[0]) {
    const existing = await database.query<{
      market_id: string; manager_address: string; validator_address: string;
      outcome: number; source_url: string; transaction_hash: string; recorded_at: Date;
    }>(`
      SELECT market_id, manager_address, validator_address, outcome, source_url, transaction_hash, recorded_at
      FROM validator_source_links
      WHERE chain_id = 42421 AND lower(manager_address) = lower($1)
        AND market_id = $2 AND lower(validator_address) = lower($3)
    `, [input.managerAddress, input.marketId, input.validatorAddress]);
    const row = existing.rows[0];
    if (!row || row.transaction_hash.toLowerCase() !== input.transactionHash.toLowerCase()
      || row.source_url !== input.sourceUrl || Number(row.outcome) !== input.outcome) {
      throw new Error("A source link has already been recorded for this validator vote.");
    }
    return mapRow(row);
  }
  return mapRow(result.rows[0]);
}

function mapRow(row: {
  market_id: string; manager_address: string; validator_address: string;
  outcome: number; source_url: string; transaction_hash: string; recorded_at: Date;
}): ValidatorSourceLink {
  return {
    marketId: row.market_id,
    managerAddress: row.manager_address,
    validatorAddress: row.validator_address,
    outcome: Number(row.outcome),
    sourceUrl: row.source_url,
    transactionHash: row.transaction_hash,
    recordedAt: new Date(row.recorded_at).toISOString(),
  };
}

export async function listValidatorSourceLinks(marketId: string, managerAddress: string): Promise<ValidatorSourceLink[]> {
  const result = await database.query<{
    market_id: string; manager_address: string; validator_address: string;
    outcome: number; source_url: string; transaction_hash: string; recorded_at: Date;
  }>(`
    SELECT market_id, manager_address, validator_address, outcome, source_url, transaction_hash, recorded_at
    FROM validator_source_links
    WHERE chain_id = 42421 AND lower(manager_address) = lower($1) AND market_id = $2
    ORDER BY recorded_at ASC
  `, [managerAddress, marketId]);
  return result.rows.map(mapRow);
}
