
import { getAddress, isAddress } from "viem";
import { verifyWalletSignature } from "./walletAuth.js";

export function isAdminWallet(address: string): boolean {
  const configuredAddress =
    process.env.ADMIN_WALLET_ADDRESS?.trim();

  if (
    !configuredAddress ||
    !isAddress(configuredAddress) ||
    !isAddress(address)
  ) {
    return false;
  }

  return (
    getAddress(configuredAddress) === getAddress(address)
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
