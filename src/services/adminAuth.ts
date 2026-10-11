
import { getAddress, isAddress } from "viem";
import { verifyWalletSignature } from "./walletAuth.js";

export function isAdminWallet(address: string): boolean {
  if (!isAddress(address)) {
    return false;
  }

  // Support multiple designated admins while retaining compatibility with
  // the existing single-wallet Render setting during migration.
  const configuredAddresses = [
    process.env.ADMIN_WALLET_ADDRESSES,
    process.env.ADMIN_WALLET_ADDRESS,
  ]
    .filter(Boolean)
    .flatMap((value) => value!.split(","))
    .map((value) => value.trim())
    .filter((value) => isAddress(value));

  const normalizedAddress = getAddress(address);
  return configuredAddresses.some(
    (configuredAddress) => getAddress(configuredAddress) === normalizedAddress,
  );
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
