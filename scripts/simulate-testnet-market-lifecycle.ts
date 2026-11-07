import "dotenv/config";
import pg from "pg";
import { createPublicClient, defineChain, getAddress, http, type Address } from "viem";
import {
  CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS,
  ASSET_CHAIN_TESTNET_ID,
  ASSET_CHAIN_TESTNET_RPC_URL,
} from "../src/config/assetOracle.js";
import {
  isDisputeRefundDue, isMarketClosable, isMarketFinalizable,
  isUnresolvedRefundDue, canProcessPayoutBatch,
  normalizePayoutStartIndex, getPayoutBatchSize,
} from "../src/workers/marketLifecyclePolicy.js";

const { Pool } = pg;
const manager = getAddress(CURRENT_ASSET_ORACLE_MARKET_MANAGER_ADDRESS) as Address;
const rpc = process.env.ASSET_CHAIN_RPC_URL?.trim() || ASSET_CHAIN_TESTNET_RPC_URL;
const USDC = getAddress("0xc33741fddEBeA854d265db6F9707900Efb0211a2");
const CHALLENGE = 3600n;
const DISPUTE_TIMEOUT = 7n * 24n * 60n * 60n;
const MAX_MARKETS = 500;
const MAX_BATCHES = 10;
const BATCH_SIZE = 50;
const abi = [
 {type:"function",name:"marketCount",stateMutability:"view",inputs:[],outputs:[{type:"uint256"}]},
 {type:"function",name:"getMarket",stateMutability:"view",inputs:[{name:"marketId",type:"uint256"}],outputs:[{name:"market",type:"tuple",components:[
  {name:"id",type:"uint256"},{name:"creator",type:"address"},{name:"marketType",type:"uint8"},{name:"stablecoin",type:"uint8"},
  {name:"question",type:"string"},{name:"resolutionRules",type:"string"},{name:"evidenceSource",type:"string"},
  {name:"closeTime",type:"uint64"},{name:"challengePeriod",type:"uint64"},{name:"resolvedAt",type:"uint64"},
  {name:"totalYes",type:"uint256"},{name:"totalNo",type:"uint256"},{name:"totalStaked",type:"uint256"},
  {name:"outcome",type:"uint8"},{name:"status",type:"uint8"},{name:"evidenceHash",type:"bytes32"}
 ]}]},
 {type:"function",name:"participantCountByMarket",stateMutability:"view",inputs:[{name:"marketId",type:"uint256"}],outputs:[{type:"uint256"}]},
 {type:"function",name:"claimCountByMarket",stateMutability:"view",inputs:[{name:"marketId",type:"uint256"}],outputs:[{type:"uint256"}]},
 {type:"function",name:"stablecoins",stateMutability:"view",inputs:[{name:"index",type:"uint8"}],outputs:[{name:"token",type:"address"},{name:"decimals",type:"uint8"},{name:"enabled",type:"bool"}]}
] as const;

async function main() {
 if (process.env.ASSET_ORACLE_NEW_CONTRACT_VERIFIED !== "true") throw new Error("Contract verification flag is not true.");
 if (Number(process.env.ASSET_CHAIN_ID || ASSET_CHAIN_TESTNET_ID) !== ASSET_CHAIN_TESTNET_ID) throw new Error("Refusing non-Enugu chain.");
 if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
 if (!/^0x[0-9a-fA-F]{40}$/.test(manager)) throw new Error("Invalid market manager address.");
 const pool = new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:1,connectionTimeoutMillis:15000});
 const client = createPublicClient({chain:defineChain({id:ASSET_CHAIN_TESTNET_ID,name:"Asset Chain Enugu Testnet",nativeCurrency:{name:"RWA",symbol:"RWA",decimals:18},rpcUrls:{default:{http:[rpc]}},testnet:true}),transport:http(rpc)});
 const report:any = {mode:"READ_ONLY_SIMULATION",transactionsSubmitted:0,databaseWrites:0,manager,chainId:ASSET_CHAIN_TESTNET_ID,approvedUnpublishedCandidates:[],markets:[],summary:{}};
 let db;
 try {
  db=await pool.connect();
  await db.query("BEGIN READ ONLY");
  const dbCheck=await db.query("SELECT current_database() AS database_name");
  report.database=dbCheck.rows[0].database_name;
  const proposals=await db.query(`SELECT id, question, origin, "closesAt" AS closes_at, status
    FROM market_proposals
    WHERE status='APPROVED' AND onchain_market_id IS NULL AND onchain_tx_hash IS NULL
    ORDER BY "submittedAt" ASC`);
  const now=BigInt(Math.floor(Date.now()/1000));
  report.approvedUnpublishedCandidates=proposals.rows.map((p:any)=>({
   id:p.id,question:p.question,origin:p.origin,
   action:BigInt(Math.floor(new Date(p.closes_at).getTime()/1000))>now?"WOULD_PUBLISH_IF_AUTOMATION_ENABLED":"SKIP_EXPIRED_REQUIRES_REVIEW"
  }));
  const chainId=await client.getChainId();
  if(chainId!==ASSET_CHAIN_TESTNET_ID) throw new Error(`RPC chain mismatch: ${chainId}`);
  const code=await client.getBytecode({address:manager});
  if(!code||code==="0x") throw new Error("Market manager has no bytecode.");
  const token=await client.readContract({address:manager,abi,functionName:"stablecoins",args:[0]});
  if(!token[2]||getAddress(token[0])!==USDC||Number(token[1])!==6) throw new Error("USDC configuration mismatch.");
  const count=Number(await client.readContract({address:manager,abi,functionName:"marketCount"}));
  report.onchainMarketCount=count;
  let payoutBatches=0;
  for(let id=1;id<=Math.min(count,MAX_MARKETS);id++){
   const m=await client.readContract({address:manager,abi,functionName:"getMarket",args:[BigInt(id)]});
   let action="NO_ACTION";
   if(isMarketClosable(m.status,m.closeTime,now)) action="WOULD_CLOSE";
   else if(isUnresolvedRefundDue(m.status,m.closeTime,m.challengePeriod,now)) action="WOULD_MARK_REFUNDABLE";
   else if(isMarketFinalizable(m.status,m.resolvedAt,m.challengePeriod,now)) action="WOULD_FINALIZE";
   else if(isDisputeRefundDue(m.status,m.resolvedAt,DISPUTE_TIMEOUT,now)) action="WOULD_MARK_DISPUTE_REFUNDABLE";
   else if(canProcessPayoutBatch(m.status,payoutBatches,MAX_BATCHES)){
    const [participants,claims]=await Promise.all([
     client.readContract({address:manager,abi,functionName:"participantCountByMarket",args:[BigInt(id)]}),
     client.readContract({address:manager,abi,functionName:"claimCountByMarket",args:[BigInt(id)]})
    ]);
    if(participants>0n&&claims<participants){
     const table=await db.query("SELECT to_regclass('public.market_lifecycle_payout_progress') AS name");
     const p=table.rows[0]?.name ? await db.query("SELECT next_index FROM market_lifecycle_payout_progress WHERE market_id=$1",[String(id)]) : {rows:[]};
     const saved=Number(p.rows[0]?.next_index??0);
     const start=normalizePayoutStartIndex(Number(participants),saved);
     const size=getPayoutBatchSize(Number(participants),start,BATCH_SIZE);
     if(size>0){action=`WOULD_DISTRIBUTE_PAYOUT_BATCH start=${start} size=${size}`;payoutBatches++;}
    }
   }
   report.markets.push({id,status:["OPEN","CLOSED","DISPUTED","SETTLED","REFUNDABLE","CANCELLED","ARBITRATION"][m.status]??`UNKNOWN_${m.status}`,totalStaked:m.totalStaked.toString(),participants: m.status===3 ? String(await client.readContract({address:manager,abi,functionName:"participantCountByMarket",args:[BigInt(id)]})) : undefined,action});
  }
  await db.query("ROLLBACK");
  report.summary={marketsScanned:report.markets.length,approvedUnpublishedCandidates:report.approvedUnpublishedCandidates.length,proposedActions:report.markets.filter((m:any)=>m.action!=="NO_ACTION").length,payoutBatchesWouldProcess:payoutBatches,scanLimit:MAX_MARKETS};
  console.log("READ-ONLY LIFECYCLE SIMULATION PASSED");
  console.log(JSON.stringify(report,null,2));
 } finally {
  if(db){await db.query("ROLLBACK").catch(()=>undefined);db.release();}
  await pool.end();
 }
}
main().catch(e=>{console.error("READ-ONLY LIFECYCLE SIMULATION FAILED:",e instanceof Error?e.message:"Unknown error");process.exitCode=1;});
