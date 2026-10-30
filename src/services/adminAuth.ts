import { getAddress, isAddress } from "viem";
import { verifyWalletSignature } from "./walletAuth.js";
import { HUMAN_VALIDATOR_ADDRESSES } from "../config/assetOracle.js";

export type WalletRole = "OWNER" | "VALIDATOR_2" | "VALIDATOR_3" | "MARKET_CREATOR" | "USER";

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

export function getHumanValidatorNumber(address: string): 1 | 2 | 3 | null {
  if (!isAddress(address)) return null;
  const normalized = getAddress(address);
  const index = HUMAN_VALIDATOR_ADDRESSES.findIndex(
    (validator) => getAddress(validator) === normalized,
  );
  return index < 0 ? null : (index + 1) as 1 | 2 | 3;
}

export function isHumanValidator(address: string): boolean {
  return getHumanValidatorNumber(address) !== null;
}

export function getWalletRole(address: string): WalletRole {
  if (!isAddress(address)) return "USER";
  if (isAdminWallet(address)) return "OWNER";
  const validatorNumber = getHumanValidatorNumber(address);
  if (validatorNumber === 2) return "VALIDATOR_2";
  if (validatorNumber === 3) return "VALIDATOR_3";
  if (isMarketCreatorWallet(address)) return "MARKET_CREATOR";
  return "USER";
}

export function getWalletRoleDetails(address: string) {
  const isOwner = isAdminWallet(address);
  const validatorNumber = getHumanValidatorNumber(address);
  return {
    role: getWalletRole(address),
    isOwner,
    humanValidator: validatorNumber !== null,
    validatorNumber,
    permissions: {
      createMarketProposal: isMarketCreatorWallet(address),
      submitPaidMarketProposal: !isMarketCreatorWallet(address),
      viewOwnProposals: true,
      reviewAllProposals: isOwner || isMarketCreatorWallet(address),
      approveOrRejectProposals: isOwner || isMarketCreatorWallet(address),
      isHumanValidator: validatorNumber !== null,
      validatorNumber,
    },
  };
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
