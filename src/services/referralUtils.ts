import { createHmac, randomBytes } from "node:crypto";

export function createReferralCodeValue(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

export function fingerprintIp(ip: string | undefined): string | null {
  const secret = process.env.IP_FINGERPRINT_SECRET;
  if (!secret || !ip) return null;
  return createHmac("sha256", secret).update(ip).digest("hex");
}
