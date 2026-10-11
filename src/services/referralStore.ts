import { createHmac, randomBytes } from "node:crypto";
import { database } from "../config/database.js";

export async function initializeReferralStore(): Promise<void> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS referral_codes (
      code TEXT PRIMARY KEY,
      owner_wallet TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await database.query(`
    CREATE TABLE IF NOT EXISTS referral_attributions (
      invited_wallet TEXT PRIMARY KEY,
      referrer_wallet TEXT NOT NULL,
      referral_code TEXT NOT NULL REFERENCES referral_codes(code),
      status TEXT NOT NULL DEFAULT 'PENDING_PREDICTION'
        CHECK (status IN ('PENDING_PREDICTION', 'QUALIFIED', 'FLAGGED')),
      ip_fingerprint TEXT,
      ip_shared_flag BOOLEAN NOT NULL DEFAULT FALSE,
      first_prediction_tx TEXT UNIQUE,
      attributed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      qualified_at TIMESTAMPTZ
    )
  `);
  await database.query(`
    CREATE INDEX IF NOT EXISTS referral_attributions_referrer_status_idx
    ON referral_attributions (referrer_wallet, status)
  `);
}

export function createReferralCodeValue(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

export function fingerprintIp(ip: string | undefined): string | null {
  const secret = process.env.IP_FINGERPRINT_SECRET;
  if (!secret || !ip) return null;
  return createHmac("sha256", secret).update(ip).digest("hex");
}
