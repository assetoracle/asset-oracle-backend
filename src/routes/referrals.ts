import { Router } from "express";
import { isAddress, createPublicClient, http, parseAbiItem, getAddress, decodeEventLog } from "viem";
import { z } from "zod";
import { database } from "../config/database.js";
import { verifyWalletSession, verifyWalletSignature } from "../services/walletAuth.js";
import { isAdminWallet, verifyAdminWallet } from "../services/adminAuth.js";
import { createReferralCodeValue, fingerprintIp } from "../services/referralStore.js";
import { awardLeaderboardPoints, getPointsLeaderboard } from "../services/pointsStore.js";
import { ASSET_CHAIN_TESTNET_ID, CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS } from "../config/assetOracle.js";
import { isStakeAfterReferralAttribution } from "../services/referralQualification.js";

const referralsRouter = Router();
const walletAuthSchema = z.object({
  address: z.string().refine(isAddress, "Invalid wallet address"),
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, "Invalid signature"),
});
const rpcUrl = process.env.ASSET_CHAIN_RPC_URL || "https://enugu-rpc.assetchain.org";
const managerAddress = CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS;
const stakedEvent = parseAbiItem("event Staked(uint256 indexed marketId, address indexed user, bool yesSide, uint256 grossAmount, uint256 fee, uint256 netAmount)");

async function authenticate(address: string, message: string, signature: string) {
  return verifyWalletSignature(address, signature as `0x${string}`, message);
}




async function awardQualifiedReferralPoints(invitedWallet: string, transactionHash: string): Promise<void> {
  const result = await database.query<{ referrer_wallet: string; invited_wallet: string; status: string }>(
    "SELECT referrer_wallet, invited_wallet, status FROM referral_attributions WHERE invited_wallet = $1",
    [invitedWallet.toLowerCase()],
  );
  const attribution = result.rows[0];
  if (!attribution || attribution.status !== "QUALIFIED") return;
  await awardLeaderboardPoints({
    walletAddress: attribution.referrer_wallet,
    eventType: "QUALIFIED_REFERRAL",
    eventKey: "referral:" + attribution.invited_wallet,
    points: 5,
    metadata: { invitedWallet: attribution.invited_wallet, firstPredictionTx: transactionHash.toLowerCase() },
  });
}

function sessionToken(req: import("express").Request): string {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

referralsRouter.post("/code/session", async (req, res, next) => {
  try {
    const parsed = z.object({ address: z.string().refine(isAddress, "Invalid wallet address") }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid wallet address is required" });
    const { address } = parsed.data;
    if (!await verifyWalletSession(sessionToken(req), address)) return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    const wallet = address.toLowerCase();
    const existing = await database.query<{ code: string }>("SELECT code FROM referral_codes WHERE owner_wallet = $1", [wallet]);
    if (existing.rows[0]) return res.json({ code: existing.rows[0].code });
    const code = createReferralCodeValue();
    const inserted = await database.query<{ code: string }>("INSERT INTO referral_codes (code, owner_wallet) VALUES ($1, $2) ON CONFLICT (owner_wallet) DO UPDATE SET owner_wallet = EXCLUDED.owner_wallet RETURNING code", [code, wallet]);
    return res.status(201).json({ code: inserted.rows[0].code });
  } catch (error) { return next(error); }
});

referralsRouter.get("/me/session", async (req, res, next) => {
  try {
    const address = req.query.address;
    if (typeof address !== "string" || !isAddress(address)) return res.status(400).json({ error: "A valid wallet address is required" });
    if (!await verifyWalletSession(sessionToken(req), address)) return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    const wallet = address.toLowerCase();
    const [codeResult, countsResult, rankResult] = await Promise.all([
      database.query<{ code: string }>("SELECT code FROM referral_codes WHERE owner_wallet = $1", [wallet]),
      database.query<{ status: string; total: string }>("SELECT status, COUNT(*)::text AS total FROM referral_attributions WHERE referrer_wallet = $1 GROUP BY status", [wallet]),
      database.query<{ rank: string }>("WITH leaderboard AS (SELECT referrer_wallet, RANK() OVER (ORDER BY COUNT(*) DESC, referrer_wallet ASC) AS rank FROM referral_attributions WHERE status = 'QUALIFIED' GROUP BY referrer_wallet) SELECT rank::text AS rank FROM leaderboard WHERE referrer_wallet = $1", [wallet]),
    ]);
    const counts = Object.fromEntries(countsResult.rows.map((row) => [row.status, Number(row.total)]));
    return res.json({
      address: wallet,
      code: codeResult.rows[0]?.code ?? null,
      verifiedReferrals: counts.QUALIFIED ?? 0,
      pendingReferrals: counts.PENDING_PREDICTION ?? 0,
      flaggedReferrals: counts.FLAGGED ?? 0,
      leaderboardRank: rankResult.rows[0] ? Number(rankResult.rows[0].rank) : null,
      rewardsEarned: null,
      rewardsAvailable: false,
    });
  } catch (error) { return next(error); }
});

referralsRouter.post("/code", async (req, res, next) => {
  try {
    const parsed = walletAuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Valid wallet authentication is required" });
    const { address, message, signature } = parsed.data;
    if (!await authenticate(address, message, signature)) return res.status(401).json({ error: "Wallet verification failed. Request a new nonce and sign again." });
    const wallet = address.toLowerCase();
    const existing = await database.query<{ code: string }>("SELECT code FROM referral_codes WHERE owner_wallet = $1", [wallet]);
    if (existing.rows[0]) return res.json({ code: existing.rows[0].code });
    const code = createReferralCodeValue();
    const inserted = await database.query<{ code: string }>(
      "INSERT INTO referral_codes (code, owner_wallet) VALUES ($1, $2) ON CONFLICT (owner_wallet) DO UPDATE SET owner_wallet = EXCLUDED.owner_wallet RETURNING code",
      [code, wallet],
    );
    return res.status(201).json({ code: inserted.rows[0].code });
  } catch (error) { return next(error); }
});

referralsRouter.post("/attribute", async (req, res, next) => {
  try {
    const parsed = z.object({
      address: z.string().refine(isAddress, "Invalid wallet address"),
      message: z.string().optional(),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
      referralCode: z.string().trim().min(1).max(32),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Valid wallet address and referral code are required" });
    const { address, message, signature, referralCode } = parsed.data;
    const token = sessionToken(req);
    const authenticated = token
      ? await verifyWalletSession(token, address)
      : Boolean(message && signature && await authenticate(address, message, signature));
    if (!authenticated) return res.status(401).json({ error: "Wallet session expired or wallet verification failed. Verify your wallet again." });
    const invited = address.toLowerCase();
    const code = referralCode.toUpperCase();
    const result = await database.query<{ owner_wallet: string }>("SELECT owner_wallet FROM referral_codes WHERE code = $1", [code]);
    if (!result.rows[0]) return res.status(404).json({ error: "Referral code not found" });
    const referrer = result.rows[0].owner_wallet.toLowerCase();
    if (invited === referrer) return res.status(400).json({ error: "Self-referrals are not allowed" });

    const ipHash = fingerprintIp(req.ip);
    const sharedIp = ipHash ? await database.query(
      "SELECT 1 FROM referral_attributions WHERE ip_fingerprint = $1 AND invited_wallet <> $2 LIMIT 1",
      [ipHash, invited],
    ) : { rowCount: 0 };
    const existing = await database.query<{ referrer_wallet: string; status: string }>(
      "SELECT referrer_wallet, status FROM referral_attributions WHERE invited_wallet = $1", [invited],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].referrer_wallet !== referrer) return res.status(409).json({ error: "This wallet already has a referral attribution" });
      return res.status(200).json({ status: existing.rows[0].status, message: "Referral attribution already exists" });
    }

    await database.query(
      `INSERT INTO referral_attributions
       (invited_wallet, referrer_wallet, referral_code, ip_fingerprint, ip_shared_flag)
       VALUES ($1, $2, $3, $4, $5)`,
      [invited, referrer, code, ipHash, Boolean(sharedIp.rowCount)],
    );
    return res.status(201).json({
      status: "PENDING_PREDICTION",
      ipSignalRecorded: Boolean(ipHash),
      reviewFlagged: Boolean(sharedIp.rowCount),
      message: "Referral attributed. It will count only after the invited wallet completes its first confirmed prediction.",
    });
  } catch (error) { return next(error); }
});


referralsRouter.post("/qualify/session", async (req, res, next) => {
  try {
    const parsed = z.object({
      address: z.string().refine(isAddress, "Invalid wallet address"),
      transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid wallet address and transaction hash are required." });
    const { address, transactionHash } = parsed.data;
    if (!await verifyWalletSession(sessionToken(req), address)) return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    if (!managerAddress || !isAddress(managerAddress)) return res.status(503).json({ error: "Referral prediction verification is not enabled until the verified market manager address is configured." });

    const client = createPublicClient({ transport: http(rpcUrl) });
    if (await client.getChainId() !== ASSET_CHAIN_TESTNET_ID) {
      return res.status(503).json({ error: "Referral verification RPC is not Asset Chain Enugu testnet." });
    }
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    if (receipt.status !== "success") return res.status(400).json({ error: "Prediction transaction did not succeed." });
    const matchingLogs = receipt.logs.filter((log) => log.address.toLowerCase() === managerAddress.toLowerCase()).flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: [stakedEvent], data: log.data, topics: log.topics });
        return decoded.eventName === "Staked" ? [decoded.args] : [];
      } catch { return []; }
    });
    const wallet = address.toLowerCase();
    if (!matchingLogs.some((log) => getAddress(log.user).toLowerCase() === wallet)) {
      return res.status(400).json({ error: "Transaction does not contain a verified stake by this wallet on the configured market manager." });
    }
    const transaction = await client.getTransaction({ hash: transactionHash as `0x${string}` });
    if (transaction.from.toLowerCase() !== wallet) {
      return res.status(400).json({ error: "The stake transaction must be sent by the referred wallet." });
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const attribution = await database.query<{ status: string; attributed_at: Date | string; first_prediction_tx: string | null }>(
      "SELECT status, attributed_at, first_prediction_tx FROM referral_attributions WHERE invited_wallet = $1",
      [wallet],
    );
    const existingAttribution = attribution.rows[0];
    if (!existingAttribution) return res.status(404).json({ error: "No referral attribution exists for this wallet." });
    if (existingAttribution.status !== "PENDING_PREDICTION" || existingAttribution.first_prediction_tx) {
      return res.status(409).json({ error: "This referral has already been processed or is not eligible for qualification.", status: existingAttribution.status });
    }
    if (!isStakeAfterReferralAttribution(block.timestamp, existingAttribution.attributed_at)) {
      return res.status(400).json({ error: "The qualifying stake must be confirmed after the referral attribution." });
    }
    const updated = await database.query(
      `UPDATE referral_attributions
       SET status = CASE WHEN ip_shared_flag THEN 'FLAGGED' ELSE 'QUALIFIED' END,
           first_prediction_tx = $1, qualified_at = NOW()
       WHERE invited_wallet = $2 AND status = 'PENDING_PREDICTION'
         AND first_prediction_tx IS NULL
       RETURNING status`,
      [transactionHash.toLowerCase(), wallet],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const already = await database.query<{ status: string }>("SELECT status FROM referral_attributions WHERE invited_wallet = $1", [wallet]);
      if (!already.rows[0]) return res.status(404).json({ error: "No referral attribution exists for this wallet." });
      return res.status(409).json({ error: "This referral has already been processed or is not eligible for qualification.", status: already.rows[0].status });
    }
    const qualifiedStatus = (updated.rows[0] as { status: string }).status;
    if (qualifiedStatus === "QUALIFIED") await awardQualifiedReferralPoints(wallet, transactionHash);
    return res.json({ status: qualifiedStatus, message: "First prediction verified. Referral record updated." });
  } catch (error) {
    if (error instanceof Error && /TransactionReceiptNotFound|could not be found/i.test(error.message)) return res.status(409).json({ error: "Prediction transaction is not confirmed yet." });
    return next(error);
  }
});

referralsRouter.post("/qualify", async (req, res, next) => {
  try {
    const parsed = walletAuthSchema.extend({ transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Valid wallet authentication and transaction hash are required" });
    const { address, message, signature, transactionHash } = parsed.data;
    if (!await authenticate(address, message, signature)) return res.status(401).json({ error: "Wallet verification failed. Request a new nonce and sign again." });
    if (!managerAddress || !isAddress(managerAddress)) return res.status(503).json({ error: "Referral prediction verification is not enabled until the verified market manager address is configured." });

    const client = createPublicClient({ transport: http(rpcUrl) });
    if (await client.getChainId() !== ASSET_CHAIN_TESTNET_ID) {
      return res.status(503).json({ error: "Referral verification RPC is not Asset Chain Enugu testnet." });
    }
    const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
    if (receipt.status !== "success") return res.status(400).json({ error: "Prediction transaction did not succeed" });
    const matchingLogs = receipt.logs.filter((log) => log.address.toLowerCase() === managerAddress.toLowerCase()).flatMap((log) => {
      try {
        const decoded = decodeEventLog({ abi: [stakedEvent], data: log.data, topics: log.topics });
        return decoded.eventName === "Staked" ? [decoded.args] : [];
      } catch { return []; }
    });
    const wallet = address.toLowerCase();
    const userStaked = matchingLogs.some((log) => getAddress(log.user).toLowerCase() === wallet);
    if (!userStaked) return res.status(400).json({ error: "Transaction does not contain a verified stake by this wallet on the configured market manager" });

    const transaction = await client.getTransaction({ hash: transactionHash as `0x${string}` });
    if (transaction.from.toLowerCase() !== wallet) {
      return res.status(400).json({ error: "The stake transaction must be sent by the referred wallet." });
    }
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    const attribution = await database.query<{ status: string; attributed_at: Date | string; first_prediction_tx: string | null }>(
      "SELECT status, attributed_at, first_prediction_tx FROM referral_attributions WHERE invited_wallet = $1",
      [wallet],
    );
    const existingAttribution = attribution.rows[0];
    if (!existingAttribution) return res.status(404).json({ error: "No referral attribution exists for this wallet." });
    if (existingAttribution.status !== "PENDING_PREDICTION" || existingAttribution.first_prediction_tx) {
      return res.status(409).json({ error: "This referral has already been processed or is not eligible for qualification.", status: existingAttribution.status });
    }
    if (!isStakeAfterReferralAttribution(block.timestamp, existingAttribution.attributed_at)) {
      return res.status(400).json({ error: "The qualifying stake must be confirmed after the referral attribution." });
    }
    const updated = await database.query(
      `UPDATE referral_attributions
       SET status = CASE WHEN ip_shared_flag THEN 'FLAGGED' ELSE 'QUALIFIED' END,
           first_prediction_tx = $1, qualified_at = NOW()
       WHERE invited_wallet = $2 AND status = 'PENDING_PREDICTION'
         AND first_prediction_tx IS NULL
       RETURNING status`,
      [transactionHash.toLowerCase(), wallet],
    );
    if ((updated.rowCount ?? 0) === 0) {
      const already = await database.query<{ status: string }>("SELECT status FROM referral_attributions WHERE invited_wallet = $1", [wallet]);
      if (!already.rows[0]) return res.status(404).json({ error: "No referral attribution exists for this wallet" });
      return res.status(409).json({ error: "This referral has already been processed or is not eligible for qualification", status: already.rows[0].status });
    }
    const qualifiedStatus = (updated.rows[0] as { status: string }).status;
    if (qualifiedStatus === "QUALIFIED") await awardQualifiedReferralPoints(wallet, transactionHash);
    return res.json({ status: qualifiedStatus, message: "First prediction verified. Referral record updated." });
  } catch (error) {
    if (error instanceof Error && /TransactionReceiptNotFound|could not be found/i.test(error.message)) return res.status(409).json({ error: "Prediction transaction is not confirmed yet" });
    return next(error);
  }
});


const adminReviewSchema = walletAuthSchema.extend({
  invitedWallet: z.string().refine(isAddress, "Invalid invited wallet address"),
  decision: z.enum(["APPROVE", "KEEP_FLAGGED"]),
});


referralsRouter.post("/review/queue/session", async (req, res, next) => {
  try {
    const parsed = z.object({ address: z.string().refine(isAddress, "Invalid wallet address") }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid owner wallet address is required." });
    const { address } = parsed.data;
    if (!await verifyWalletSession(sessionToken(req), address)) return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    if (!isAdminWallet(address)) return res.status(403).json({ error: "Only the configured owner wallet can review flagged referrals." });
    const result = await database.query<{
      invited_wallet: string; referrer_wallet: string; first_prediction_tx: string; qualified_at: string | null;
    }>(
      `SELECT invited_wallet, referrer_wallet, first_prediction_tx, qualified_at
       FROM referral_attributions
       WHERE status = 'FLAGGED' AND first_prediction_tx IS NOT NULL
       ORDER BY qualified_at ASC NULLS LAST LIMIT 200`,
    );
    return res.json({ flaggedReferrals: result.rows.map((row) => ({
      invitedWallet: row.invited_wallet,
      referrerWallet: row.referrer_wallet,
      firstPredictionTransaction: row.first_prediction_tx,
      flaggedAt: row.qualified_at,
    })) });
  } catch (error) { return next(error); }
});

referralsRouter.post("/review/session", async (req, res, next) => {
  try {
    const parsed = z.object({
      address: z.string().refine(isAddress, "Invalid wallet address"),
      invitedWallet: z.string().refine(isAddress, "Invalid invited wallet address"),
      decision: z.enum(["APPROVE", "KEEP_FLAGGED"]),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Valid owner address, invited wallet, and review decision are required." });
    const { address, invitedWallet, decision } = parsed.data;
    if (!await verifyWalletSession(sessionToken(req), address)) return res.status(401).json({ error: "Wallet session expired. Verify your wallet again." });
    if (!isAdminWallet(address)) return res.status(403).json({ error: "Only the configured owner wallet can review flagged referrals." });
    if (decision === "KEEP_FLAGGED") {
      const stillFlagged = await database.query(
        "SELECT 1 FROM referral_attributions WHERE invited_wallet = $1 AND status = 'FLAGGED' AND first_prediction_tx IS NOT NULL",
        [invitedWallet.toLowerCase()],
      );
      if (!stillFlagged.rowCount) return res.status(409).json({ error: "No stake-verified flagged referral is awaiting review." });
      return res.json({ status: "FLAGGED", message: "Referral remains flagged and excluded from the leaderboard." });
    }
    const updated = await database.query(
      `UPDATE referral_attributions SET status = 'QUALIFIED'
       WHERE invited_wallet = $1 AND status = 'FLAGGED' AND first_prediction_tx IS NOT NULL
       RETURNING invited_wallet, first_prediction_tx`,
      [invitedWallet.toLowerCase()],
    );
    if (!updated.rowCount) return res.status(409).json({ error: "No stake-verified flagged referral is awaiting approval." });
    const approved = updated.rows[0] as { invited_wallet: string; first_prediction_tx: string };
    await awardQualifiedReferralPoints(approved.invited_wallet, approved.first_prediction_tx);
    return res.json({ status: "QUALIFIED", message: "Referral approved, awarded 5 points, and included in the all-time leaderboard." });
  } catch (error) { return next(error); }
});

referralsRouter.post("/review/queue", async (req, res, next) => {
  try {
    const parsed = walletAuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Valid owner wallet authentication is required" });
    const { address, message, signature } = parsed.data;
    if (!await verifyAdminWallet(address, signature as `0x${string}`, message)) {
      return res.status(403).json({ error: "Only the configured owner wallet can review flagged referrals" });
    }
    const result = await database.query<{
      invited_wallet: string; referrer_wallet: string; first_prediction_tx: string; qualified_at: string | null;
    }>(
      `SELECT invited_wallet, referrer_wallet, first_prediction_tx, qualified_at
       FROM referral_attributions
       WHERE status = 'FLAGGED' AND first_prediction_tx IS NOT NULL
       ORDER BY qualified_at ASC NULLS LAST LIMIT 200`,
    );
    return res.json({ flaggedReferrals: result.rows.map((row) => ({
      invitedWallet: row.invited_wallet,
      referrerWallet: row.referrer_wallet,
      firstPredictionTransaction: row.first_prediction_tx,
      flaggedAt: row.qualified_at,
    })) });
  } catch (error) { return next(error); }
});

referralsRouter.post("/review", async (req, res, next) => {
  try {
    const parsed = adminReviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Valid owner authentication, invited wallet, and review decision are required" });
    const { address, message, signature, invitedWallet, decision } = parsed.data;
    if (!await verifyAdminWallet(address, signature as `0x${string}`, message)) {
      return res.status(403).json({ error: "Only the configured owner wallet can review flagged referrals" });
    }
    if (decision === "KEEP_FLAGGED") {
      const stillFlagged = await database.query(
        "SELECT 1 FROM referral_attributions WHERE invited_wallet = $1 AND status = 'FLAGGED' AND first_prediction_tx IS NOT NULL",
        [invitedWallet.toLowerCase()],
      );
      if (!stillFlagged.rowCount) return res.status(409).json({ error: "No stake-verified flagged referral is awaiting review" });
      return res.json({ status: "FLAGGED", message: "Referral remains flagged and excluded from the leaderboard." });
    }
    const updated = await database.query(
      `UPDATE referral_attributions SET status = 'QUALIFIED'
       WHERE invited_wallet = $1 AND status = 'FLAGGED' AND first_prediction_tx IS NOT NULL
       RETURNING invited_wallet`,
      [invitedWallet.toLowerCase()],
    );
    if (!updated.rowCount) return res.status(409).json({ error: "No stake-verified flagged referral is awaiting approval" });
    const approved = updated.rows[0] as { invited_wallet: string; first_prediction_tx: string };
    await awardQualifiedReferralPoints(approved.invited_wallet, approved.first_prediction_tx);
    return res.json({ status: "QUALIFIED", message: "Referral approved, awarded 5 points, and included in the all-time leaderboard." });
  } catch (error) { return next(error); }
});

referralsRouter.get("/leaderboard", async (_req, res, next) => {
  try {
    const result = await database.query<{ wallet: string; verified_referrals: string }>(
      `SELECT referrer_wallet AS wallet, COUNT(*)::text AS verified_referrals
       FROM referral_attributions WHERE status = 'QUALIFIED'
       GROUP BY referrer_wallet ORDER BY COUNT(*) DESC, referrer_wallet ASC LIMIT 100`,
    );
    return res.json({ period: "ALL_TIME", leaderboard: result.rows.map((row, index) => ({
      rank: index + 1, wallet: row.wallet, verifiedReferrals: Number(row.verified_referrals),
    })) });
  } catch (error) { return next(error); }
});



referralsRouter.get("/points-leaderboard", async (_req, res, next) => {
  try {
    const leaderboard = await getPointsLeaderboard(100);
    return res.json({ period: "ALL_TIME", leaderboard });
  } catch (error) { return next(error); }
});

referralsRouter.get("/referral-leaderboard", async (_req, res, next) => {
  try {
    const result = await database.query<{ wallet: string; referrals: string; points: string }>(
      `SELECT lower(a.referrer_wallet) AS wallet, COUNT(*)::text AS referrals,
              COALESCE(SUM(p.points), 0)::text AS points
       FROM referral_attributions a
       LEFT JOIN leaderboard_point_events p
         ON p.event_type = 'QUALIFIED_REFERRAL'
        AND p.event_key = 'referral:' || lower(a.invited_wallet)
        AND lower(p.wallet_address) = lower(a.referrer_wallet)
       WHERE a.status = 'QUALIFIED'
       GROUP BY lower(a.referrer_wallet)
       ORDER BY COUNT(*) DESC, COALESCE(SUM(p.points), 0) DESC, lower(a.referrer_wallet) ASC
       LIMIT 100`
    );
    return res.json({ period: "ALL_TIME", leaderboard: result.rows.map((row, index) => ({
      rank: index + 1, wallet: row.wallet, referrals: Number(row.referrals), referralPoints: Number(row.points),
    })) });
  } catch (error) { return next(error); }
});

referralsRouter.get("/total-leaderboard", async (_req, res, next) => {
  try {
    const result = await database.query<{ wallet: string; referrals: string; referral_points: string; activity_points: string; total_points: string }>(
      `WITH qualified_referrals AS (
         SELECT lower(referrer_wallet) AS wallet, COUNT(*)::text AS referrals FROM referral_attributions WHERE status = 'QUALIFIED' GROUP BY lower(referrer_wallet)
       ), points AS (
         SELECT lower(wallet_address) AS wallet, SUM(points) FILTER (WHERE event_type = 'QUALIFIED_REFERRAL')::text AS referral_points,
                SUM(points) FILTER (WHERE event_type <> 'QUALIFIED_REFERRAL')::text AS activity_points, SUM(points)::text AS total_points
         FROM leaderboard_point_events GROUP BY lower(wallet_address)
       ), wallets AS (SELECT wallet FROM points UNION SELECT wallet FROM qualified_referrals)
       SELECT w.wallet, COALESCE(r.referrals, '0') AS referrals, COALESCE(p.referral_points, '0') AS referral_points,
              COALESCE(p.activity_points, '0') AS activity_points, COALESCE(p.total_points, '0') AS total_points
       FROM wallets w LEFT JOIN qualified_referrals r ON r.wallet = w.wallet LEFT JOIN points p ON p.wallet = w.wallet
       ORDER BY COALESCE(p.total_points::bigint, 0) DESC, COALESCE(r.referrals::bigint, 0) DESC, w.wallet ASC LIMIT 100`
    );
    return res.json({ period: "ALL_TIME", leaderboard: result.rows.map((row, index) => ({
      rank: index + 1, wallet: row.wallet, referrals: Number(row.referrals), referralPoints: Number(row.referral_points),
      activityPoints: Number(row.activity_points), totalPoints: Number(row.total_points),
    })) });
  } catch (error) { return next(error); }
});

export default referralsRouter;
