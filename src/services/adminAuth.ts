import { getAddress, isAddress } from "viem";
import { verifyWalletSignature } from "./walletAuth.js";

export type WalletRole = "OWNER" | "MARKET_CREATOR" | "USER";

function configuredWallets(...values: Array<string | undefined>): string[] {
  return values
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => isAddress(value))
    .map((value) => getAddress(value));
}

/**
 * The owner is deliberately read from the single ADMIN_WALLET_ADDRESS setting.
 * Do not add employee/creator wallets to this setting.
 */
export function isAdminWallet(address: string): boolean {
  if (!isAddress(address)) return false;

  const owner = process.env.ADMIN_WALLET_ADDRESS?.trim();
  if (!owner || !isAddress(owner)) return false;

  return getAddress(owner) === getAddress(address);
}

export function isMarketCreatorWallet(address: string): boolean {
  if (!isAddress(address)) return false;

  const creators = configuredWallets(
    process.env.MARKET_CREATOR_WALLET_ADDRESSES,
  );

  const normalizedAddress = getAddress(address);
  return creators.includes(normalizedAddress) || isAdminWallet(normalizedAddress);
}

export function getWalletRole(address: string): WalletRole {
  if (!isAddress(address)) return "USER";
  if (isAdminWallet(address)) return "OWNER";
  if (isMarketCreatorWallet(address)) return "MARKET_CREATOR";
  return "USER";
}

export async function verifyAdminWallet(
  address: string,
  signature: `0x${string}`,
  message: string,
): Promise<boolean> {
  if (!isAdminWallet(address)) {
    return false;
  }

  return verifyWalletSignature(address, signature, message);
}
