import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "viem";
import { database } from "../config/database.js";

const NONCE_TTL_MINUTES = 5;
const SESSION_TTL_HOURS = 12;

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function initializeWalletAuth(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS wallet_sessions (
      token_hash TEXT PRIMARY KEY,
      address TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await database.query(`
    CREATE INDEX IF NOT EXISTS wallet_sessions_address_idx ON wallet_sessions (address)
  `);

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

/** Issue an opaque, short-lived session after a one-time wallet signature. */
export async function createWalletSession(address: string): Promise<{ token: string; expiresAt: string }> {
  const normalized = address.toLowerCase();
  const token = randomBytes(32).toString("base64url");
  const result = await database.query<{ expires_at: string }>(
    `INSERT INTO wallet_sessions (token_hash, address, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))
     RETURNING expires_at`,
    [hashSessionToken(token), normalized, SESSION_TTL_HOURS],
  );
  return { token, expiresAt: new Date(result.rows[0].expires_at).toISOString() };
}

/** Verify a session against both its token and the currently connected wallet. */
export async function verifyWalletSession(token: string, address: string): Promise<boolean> {
  if (!token || !address) return false;
  const result = await database.query(
    `SELECT 1 FROM wallet_sessions
     WHERE token_hash = $1 AND address = $2 AND expires_at > NOW()`,
    [hashSessionToken(token), address.toLowerCase()],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function revokeWalletSession(token: string): Promise<void> {
  if (!token) return;
  await database.query("DELETE FROM wallet_sessions WHERE token_hash = $1", [hashSessionToken(token)]);
}
