export type PublicationEvidence = {
  expectedChainId: number;
  actualChainId: number;
  receiptStatus: "success" | "reverted";
  transactionTo: string | null;
  transactionFrom: string;
  managerAddress: string;
  authenticatedWallet: string;
  marketId: string;
  eventMarketId: string | null;
  expectedQuestion: string;
  eventQuestion: string | null;
  eventStablecoin: number | null;
  eventCloseTime: bigint | null;
  expectedCloseTime: bigint;
  eventCreator: string | null;
};

export function verifyPublicationEvidence(evidence: PublicationEvidence): string | null {
  if (evidence.expectedChainId !== 42421 || evidence.actualChainId !== 42421 ||
      evidence.actualChainId !== evidence.expectedChainId) {
    return "Configured RPC does not report the expected Asset Chain Enugu testnet chain ID.";
  }
  if (evidence.receiptStatus !== "success") {
    return "The submitted transaction did not succeed on-chain.";
  }
  if (!evidence.transactionTo ||
      evidence.transactionTo.toLowerCase() !== evidence.managerAddress.toLowerCase()) {
    return "Transaction target does not match the configured market manager.";
  }
  if (evidence.transactionFrom.toLowerCase() !== evidence.authenticatedWallet.toLowerCase()) {
    return "Transaction sender does not match the authenticated market-creator wallet.";
  }
  if (
    evidence.eventMarketId !== evidence.marketId ||
    evidence.eventQuestion !== evidence.expectedQuestion ||
    evidence.eventStablecoin !== 0 ||
    evidence.eventCloseTime !== evidence.expectedCloseTime ||
    !evidence.eventCreator ||
    evidence.eventCreator.toLowerCase() !== evidence.authenticatedWallet.toLowerCase()
  ) {
    return "Receipt does not contain a matching MarketCreated event for this approved proposal and creator wallet.";
  }
  return null;
}
