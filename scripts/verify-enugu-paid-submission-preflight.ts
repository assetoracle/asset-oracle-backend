import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
} from "viem";

const RPC_URL = process.env.ASSET_ORACLE_TESTNET_RPC_URL || "https://enugu-rpc.assetchain.org";
// Read-only preflight: never requests signatures or broadcasts transactions.
const EXPECTED_CHAIN_ID = 42421;
const APPROVED_TOKEN_ADDRESS = getAddress("0xc33741fddEBeA854d265db6F9707900Efb0211a2");
const TOKEN_RAW = process.env.ASSET_ORACLE_TESTNET_USDC_ADDRESS || APPROVED_TOKEN_ADDRESS;
const TREASURY_RAW = process.env.ASSET_ORACLE_TESTNET_PAID_SUBMISSION_TREASURY_ADDRESS || "";
const ESCROW_RAW = process.env.ASSET_ORACLE_TESTNET_PAID_SUBMISSION_ESCROW_ADDRESS || "";

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);

function requireCheck(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

async function main() {
  requireCheck(RPC_URL.startsWith("https://"), "Refusing non-HTTPS testnet RPC.");
  requireCheck(isAddress(TOKEN_RAW), "USDC contract address is invalid.");
  const token = getAddress(TOKEN_RAW);
  requireCheck(
    token.toLowerCase() === APPROVED_TOKEN_ADDRESS.toLowerCase(),
    `Refusing unapproved USDC contract. Expected ${APPROVED_TOKEN_ADDRESS}, received ${token}.`,
  );
  const client = createPublicClient({ transport: http(RPC_URL) });

  const chainId = await client.getChainId();
  requireCheck(chainId === EXPECTED_CHAIN_ID, `Wrong network: expected chain ID ${EXPECTED_CHAIN_ID}, received ${chainId}.`);

  const code = await client.getCode({ address: token });
  requireCheck(!!code && code !== "0x", "No contract bytecode exists at the configured USDC address.");

  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  requireCheck(symbol.trim().toUpperCase() === "USDC", `Unexpected token symbol: ${symbol}.`);
  requireCheck(decimals === 6, `Unexpected USDC decimals: expected 6, received ${decimals}.`);

  console.log("READ-ONLY ENUGU TESTNET PREFLIGHT");
  console.log(JSON.stringify({
    chainId,
    rpcUrl: RPC_URL,
    tokenAddress: token,
    tokenName: name,
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    tokenBytecodeBytes: (code.length - 2) / 2,
    expectedSubmissionAmount: "10 USDC",
    expectedAtomicAmount: "10000000",
  }, null, 2));

  if (ESCROW_RAW) {
    requireCheck(isAddress(ESCROW_RAW), "Manual proposal escrow address is invalid.");
    const escrow = getAddress(ESCROW_RAW);
    const escrowCode = await client.getCode({ address: escrow });
    requireCheck(!!escrowCode && escrowCode !== "0x", "No contract bytecode exists at the configured proposal escrow address.");
    const escrowAbi = parseAbi([
      "function usdc() view returns (address)",
      "function treasury() view returns (address)",
      "function PROPOSAL_FEE() view returns (uint256)",
    ]);
    const [escrowToken, escrowTreasury, fee] = await Promise.all([
      client.readContract({ address: escrow, abi: escrowAbi, functionName: "usdc" }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: "treasury" }),
      client.readContract({ address: escrow, abi: escrowAbi, functionName: "PROPOSAL_FEE" }),
    ]);
    requireCheck(escrowToken.toLowerCase() === token.toLowerCase(), "Escrow is configured with a different USDC token.");
    requireCheck(fee === 10_000_000n, "Escrow proposal fee is not exactly 10 USDC.");
    console.log(JSON.stringify({
      escrowAddress: escrow,
      escrowBytecodeBytes: (escrowCode.length - 2) / 2,
      escrowToken,
      escrowTreasury,
      fixedProposalFee: formatUnits(fee, decimals),
      flow: "External payer -> escrow; approved -> Treasury; rejected -> original payer refund",
    }, null, 2));
  } else {
    console.log("No escrow address supplied. Paid proposal fees must remain disabled until the escrow is deployed and verified.");
  }

  if (TREASURY_RAW) {
    requireCheck(isAddress(TREASURY_RAW), "Candidate treasury address is invalid.");
    const treasury = getAddress(TREASURY_RAW);
    const [treasuryCode, balance] = await Promise.all([
      client.getCode({ address: treasury }),
      client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [treasury] }),
    ]);
    console.log(JSON.stringify({
      candidateTreasuryAddress: treasury,
      treasuryBytecodeBytes: treasuryCode && treasuryCode !== "0x" ? (treasuryCode.length - 2) / 2 : 0,
      candidateTreasuryUsdcBalance: formatUnits(balance, decimals),
      treasuryVerificationNote: "This is the final fee recipient only after an authorised proposal approval; the initial $10 payment is held in escrow.",
    }, null, 2));
  } else {
    console.log("No candidate treasury supplied. Set ASSET_ORACLE_TESTNET_PAID_SUBMISSION_TREASURY_ADDRESS to inspect it read-only.");
  }
}

main().catch(error => {
  console.error("Enugu testnet preflight failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
