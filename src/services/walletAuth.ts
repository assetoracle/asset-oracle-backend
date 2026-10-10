import { randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import { database } from "../config/database.js";

const NONCE_TTL_MINUTES = 5;

export async function initializeWalletAuth(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS wallet_auth_nonces (
      address TEXT PRIMARY KEY,
      nonce TEXT NOT NULL,
      "expiresAt" TIMESTAMPTZ NOT NULL
    )
  `);
}

export async function createWalletNonce(
  address: string,
): Promise<string> {
  const normalized = address.toLowerCase();
  const nonce = randomBytes(32).toString("hex");

  await database.query(
    `INSERT INTO wallet_auth_nonces (address, nonce, "expiresAt")
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 minute'))
     ON CONFLICT (address)
     DO UPDATE SET
       nonce = EXCLUDED.nonce,
       "expiresAt" = EXCLUDED."expiresAt"`,
    [normalized, nonce, NONCE_TTL_MINUTES],
  );

  return nonce;
}

export async function verifyWalletSignature(
  address: string,
  signature: `0x${string}`,
  message: string,
): Promise<boolean> {
  const normalized = address.toLowerCase();

  const result = await database.query<{
    nonce: string;
    expiresAt: string | Date;
  }>(
    `SELECT nonce, "expiresAt"
     FROM wallet_auth_nonces
     WHERE address = $1`,
    [normalized],
  );

  const record = result.rows[0];

  if (!record || new Date(record.expiresAt).getTime() <= Date.now()) {
    return false;
  }

  const expectedMessage =
    `Asset Oracle wallet verification\n` +
    `Address: ${address}\n` +
    `Nonce: ${record.nonce}`;

  if (message !== expectedMessage) {
    return false;
  }

  let valid = false;

  try {
    valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature,
    });
  } catch {
    return false;
  }

  if (!valid) {
    return false;
  }

  // Consume only the nonce that was actually verified.
  const consumed = await database.query(
    `DELETE FROM wallet_auth_nonces
     WHERE address = $1 AND nonce = $2`,
    [normalized, record.nonce],
  );

  return (consumed.rowCount ?? 0) === 1;
}