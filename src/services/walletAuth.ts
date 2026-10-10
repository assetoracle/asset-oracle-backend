import {
  createPublicClient,
  http,
  verifyMessage,
} from "viem";

const NONCE_TTL_MS = 5 * 60 * 1000;

type NonceRecord = {
  nonce: string;
  expiresAt: number;
};

const nonces = new Map<string, NonceRecord>();

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export function createWalletNonce(address: string): string {
  const normalized = normalizeAddress(address);
  const nonce = crypto.randomUUID();

  nonces.set(normalized, {
    nonce,
    expiresAt: Date.now() + NONCE_TTL_MS,
  });

  return nonce;
}

export async function verifyWalletSignature(
  address: string,
  signature: `0x${string}`,
  message: string,
): Promise<boolean> {
  const normalized = normalizeAddress(address);
  const record = nonces.get(normalized);

  if (!record || record.expiresAt < Date.now()) {
    nonces.delete(normalized);
    return false;
  }

  const expectedMessage =
    `Asset Oracle wallet verification\n` +
    `Address: ${address}\n` +
    `Nonce: ${record.nonce}`;

  if (message !== expectedMessage) {
    return false;
  }

  try {
    const valid = await verifyMessage({
      address: address as `0x${string}`,
      message,
      signature,
    });

    if (valid) {
      nonces.delete(normalized);
    }

    return valid;
  } catch {
    return false;
  }
}