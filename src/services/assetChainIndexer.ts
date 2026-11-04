import { createPublicClient, http } from "viem";
import { database } from "../config/database.js";

const CHAIN_ID = 42421;
const RPC_DEFAULT = "https://enugu-rpc.assetchain.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) => typeof v === "bigint" ? v.toString() : v);
}
function addressTopic(topic?: string): string | null {
  return topic && /^0x[0-9a-fA-F]{64}$/.test(topic) ? `0x${topic.slice(-40)}`.toLowerCase() : null;
}
export function decodeIndexedTransfer(log: { address: string; topics: readonly string[]; data: string }) {
  if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  const from = addressTopic(log.topics[1]);
  const to = addressTopic(log.topics[2]);
  if (!from || !to) return null;
  return { tokenAddress: log.address.toLowerCase(), fromAddress: from, toAddress: to, amountRaw: BigInt(log.data).toString() };
}

async function schema(): Promise<void> {
  await database.query(`CREATE TABLE IF NOT EXISTS asset_chain_blocks (
    chain_id INTEGER NOT NULL, block_number BIGINT NOT NULL, block_hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL, block_timestamp TIMESTAMPTZ NOT NULL, transaction_count INTEGER NOT NULL,
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(chain_id,block_number), UNIQUE(chain_id,block_hash))`);
  await database.query(`CREATE TABLE IF NOT EXISTS asset_chain_transactions (
    chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, block_number BIGINT NOT NULL, transaction_index INTEGER NOT NULL,
    from_address TEXT NOT NULL, to_address TEXT, value_wei NUMERIC(78,0) NOT NULL, nonce BIGINT NOT NULL,
    gas_limit NUMERIC(78,0) NOT NULL, gas_price_wei NUMERIC(78,0), input_data TEXT NOT NULL,
    receipt_status TEXT NOT NULL, gas_used NUMERIC(78,0) NOT NULL, effective_gas_price_wei NUMERIC(78,0),
    transaction_json JSONB NOT NULL, receipt_json JSONB NOT NULL, indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(chain_id,tx_hash))`);
  await database.query(`CREATE TABLE IF NOT EXISTS asset_chain_logs (
    chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number BIGINT NOT NULL,
    contract_address TEXT NOT NULL, topics TEXT[] NOT NULL, data TEXT NOT NULL, removed BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY(chain_id,tx_hash,log_index))`);
  await database.query(`CREATE TABLE IF NOT EXISTS asset_chain_transfers (
    chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number BIGINT NOT NULL,
    transfer_type TEXT NOT NULL CHECK(transfer_type IN ('NATIVE','ERC20')), token_address TEXT,
    from_address TEXT NOT NULL, to_address TEXT NOT NULL, amount_raw NUMERIC(78,0) NOT NULL,
    PRIMARY KEY(chain_id,tx_hash,log_index))`);
  await database.query(`CREATE TABLE IF NOT EXISTS asset_chain_wallets (
    chain_id INTEGER NOT NULL, wallet_address TEXT NOT NULL, first_seen_block BIGINT NOT NULL,
    last_seen_block BIGINT NOT NULL, PRIMARY KEY(chain_id,wallet_address))`);
  await database.query(`CREATE TABLE IF NOT EXISTS asset_chain_indexer_cursors (
    chain_id INTEGER PRIMARY KEY, start_block BIGINT NOT NULL, last_indexed_block BIGINT NOT NULL,
    last_block_hash TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await database.query("CREATE INDEX IF NOT EXISTS asset_chain_tx_block_idx ON asset_chain_transactions(chain_id,block_number DESC)");
  await database.query("CREATE INDEX IF NOT EXISTS asset_chain_tx_from_idx ON asset_chain_transactions(chain_id,from_address,block_number DESC)");
  await database.query("CREATE INDEX IF NOT EXISTS asset_chain_tx_to_idx ON asset_chain_transactions(chain_id,to_address,block_number DESC) WHERE to_address IS NOT NULL");
  await database.query("CREATE INDEX IF NOT EXISTS asset_chain_logs_contract_idx ON asset_chain_logs(chain_id,contract_address,block_number DESC)");
  await database.query("CREATE INDEX IF NOT EXISTS asset_chain_transfers_from_idx ON asset_chain_transfers(chain_id,from_address,block_number DESC)");
  await database.query("CREATE INDEX IF NOT EXISTS asset_chain_transfers_to_idx ON asset_chain_transfers(chain_id,to_address,block_number DESC)");
}

async function concurrent<T,R>(items:T[], limit:number, fn:(item:T)=>Promise<R>):Promise<R[]> {
  const out = new Array<R>(items.length); let cursor=0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(true){const i=cursor++;if(i>=items.length)return;out[i]=await fn(items[i]);}}));
  return out;
}

async function addWallet(db: import("pg").PoolClient, chainId:number, wallet:string, block:string) {
  const address=wallet.toLowerCase(); if(address===ZERO)return;
  await db.query(`INSERT INTO asset_chain_wallets(chain_id,wallet_address,first_seen_block,last_seen_block)
    VALUES($1,$2,$3,$3) ON CONFLICT(chain_id,wallet_address) DO UPDATE SET
    first_seen_block=LEAST(asset_chain_wallets.first_seen_block,EXCLUDED.first_seen_block),
    last_seen_block=GREATEST(asset_chain_wallets.last_seen_block,EXCLUDED.last_seen_block)`,[chainId,address,block]);
}

async function indexOneBlock(client: ReturnType<typeof createPublicClient>, chainId:number, height:bigint):Promise<string> {
  const block=await client.getBlock({blockNumber:height,includeTransactions:true});
  if(!block.hash)throw new Error(`Block ${height} has no hash`);
  const txs=[...block.transactions];
  const receipts=await concurrent(txs,8,tx=>client.getTransactionReceipt({hash:tx.hash}));
  const db=await database.connect(); const heightText=height.toString();
  try {
    await db.query("BEGIN");
    await db.query(`INSERT INTO asset_chain_blocks(chain_id,block_number,block_hash,parent_hash,block_timestamp,transaction_count)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(chain_id,block_number) DO UPDATE SET block_hash=EXCLUDED.block_hash,
      parent_hash=EXCLUDED.parent_hash,block_timestamp=EXCLUDED.block_timestamp,transaction_count=EXCLUDED.transaction_count,indexed_at=NOW()`,
      [chainId,heightText,block.hash,block.parentHash,new Date(Number(block.timestamp)*1000),txs.length]);
    for(let i=0;i<txs.length;i++){
      const tx=txs[i], receipt=receipts[i], hash=tx.hash.toLowerCase();
      await db.query(`INSERT INTO asset_chain_transactions(chain_id,tx_hash,block_number,transaction_index,from_address,to_address,
        value_wei,nonce,gas_limit,gas_price_wei,input_data,receipt_status,gas_used,effective_gas_price_wei,transaction_json,receipt_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)
        ON CONFLICT(chain_id,tx_hash) DO UPDATE SET block_number=EXCLUDED.block_number,transaction_index=EXCLUDED.transaction_index,
        receipt_status=EXCLUDED.receipt_status,gas_used=EXCLUDED.gas_used,effective_gas_price_wei=EXCLUDED.effective_gas_price_wei,
        transaction_json=EXCLUDED.transaction_json,receipt_json=EXCLUDED.receipt_json`,
        [chainId,hash,heightText,i,tx.from.toLowerCase(),tx.to?.toLowerCase()??null,tx.value.toString(),tx.nonce,
          tx.gas.toString(),tx.gasPrice?.toString()??null,tx.input,receipt.status,receipt.gasUsed.toString(),
          receipt.effectiveGasPrice?.toString()??null,json(tx),json(receipt)]);
      await addWallet(db,chainId,tx.from,heightText);
      if(tx.to)await addWallet(db,chainId,tx.to,heightText);
      if(tx.to&&tx.value>0n)await db.query(`INSERT INTO asset_chain_transfers
        (chain_id,tx_hash,log_index,block_number,transfer_type,token_address,from_address,to_address,amount_raw)
        VALUES($1,$2,-1,$3,'NATIVE',NULL,$4,$5,$6) ON CONFLICT(chain_id,tx_hash,log_index) DO NOTHING`,
        [chainId,hash,heightText,tx.from.toLowerCase(),tx.to.toLowerCase(),tx.value.toString()]);
      for(const log of receipt.logs){
        await db.query(`INSERT INTO asset_chain_logs(chain_id,tx_hash,log_index,block_number,contract_address,topics,data,removed)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(chain_id,tx_hash,log_index) DO UPDATE SET
          contract_address=EXCLUDED.contract_address,topics=EXCLUDED.topics,data=EXCLUDED.data,removed=EXCLUDED.removed`,
          [chainId,hash,log.logIndex,heightText,log.address.toLowerCase(),[...log.topics],log.data,log.removed??false]);
        const transfer=decodeIndexedTransfer({address:log.address,topics:log.topics,data:log.data});
        if(transfer){
          await db.query(`INSERT INTO asset_chain_transfers(chain_id,tx_hash,log_index,block_number,transfer_type,token_address,from_address,to_address,amount_raw)
            VALUES($1,$2,$3,$4,'ERC20',$5,$6,$7,$8) ON CONFLICT(chain_id,tx_hash,log_index) DO UPDATE SET
            token_address=EXCLUDED.token_address,from_address=EXCLUDED.from_address,to_address=EXCLUDED.to_address,amount_raw=EXCLUDED.amount_raw`,
            [chainId,hash,log.logIndex,heightText,transfer.tokenAddress,transfer.fromAddress,transfer.toAddress,transfer.amountRaw]);
          await addWallet(db,chainId,transfer.fromAddress,heightText); await addWallet(db,chainId,transfer.toAddress,heightText);
        }
      }
    }
    await db.query("UPDATE asset_chain_indexer_cursors SET last_indexed_block=$2,last_block_hash=$3,updated_at=NOW() WHERE chain_id=$1",
      [chainId,heightText,block.hash]);
    await db.query("COMMIT");
  } catch(error){await db.query("ROLLBACK");throw error;} finally{db.release();}
  return block.hash;
}

let initialized=false;
export async function initializeAssetChainIndexer():Promise<void>{
  if(initialized)return;
  if(process.env.ASSET_CHAIN_INDEXER_ENABLED!=="true"){console.log("Full Asset Chain indexer is disabled.");return;}
  const chainId=intEnv("ASSET_CHAIN_ID",CHAIN_ID,1,2147483647);
  if(chainId!==CHAIN_ID)throw new Error("Asset Chain full indexer currently supports Enugu testnet (42421) only.");
  const start=BigInt(intEnv("ASSET_CHAIN_INDEXER_START_BLOCK",0,0,2147483647));
  const rpc=process.env.ASSET_CHAIN_RPC_URL?.trim()||RPC_DEFAULT;
  const client=createPublicClient({transport:http(rpc,{timeout:30000})});
  const actual=await client.getChainId(); if(actual!==chainId)throw new Error(`Asset Chain RPC mismatch: expected ${chainId}, got ${actual}`);
  await schema();
  await database.query(`INSERT INTO asset_chain_indexer_cursors(chain_id,start_block,last_indexed_block,last_block_hash)
    VALUES($1,$2,$3,NULL) ON CONFLICT(chain_id) DO NOTHING`,[chainId,start.toString(),(start-1n).toString()]);
  const stored=await database.query<{start_block:string,last_indexed_block:string,last_block_hash:string|null}>(
    "SELECT start_block,last_indexed_block,last_block_hash FROM asset_chain_indexer_cursors WHERE chain_id=$1",[chainId]);
  const effectiveStart=BigInt(stored.rows[0].start_block);
  initialized=true;
  const interval=intEnv("ASSET_CHAIN_INDEXER_POLL_MS",15000,5000,300000);
  const maxBlocks=intEnv("ASSET_CHAIN_INDEXER_BLOCKS_PER_POLL",3,1,20);
  const confirmations=BigInt(intEnv("ASSET_CHAIN_INDEXER_CONFIRMATIONS",3,1,100));
  const poll=async()=>{
    try{
      const cursor=await database.query<{last_indexed_block:string,last_block_hash:string|null}>(
        "SELECT last_indexed_block,last_block_hash FROM asset_chain_indexer_cursors WHERE chain_id=$1",[chainId]);
      let last=BigInt(cursor.rows[0].last_indexed_block);
      if(cursor.rows[0].last_block_hash){
        const canonical=await client.getBlock({blockNumber:last});
        if(canonical.hash?.toLowerCase()!==cursor.rows[0].last_block_hash?.toLowerCase()){
          const rewind=BigInt(intEnv("ASSET_CHAIN_INDEXER_REORG_DEPTH",12,3,100));
          const ancestor=last>rewind&&last-rewind>=effectiveStart?last-rewind:effectiveStart-1n;
          const db=await database.connect();
          try{await db.query("BEGIN");
            for(const table of ["asset_chain_transfers","asset_chain_logs","asset_chain_transactions","asset_chain_blocks"])
              await db.query(`DELETE FROM ${table} WHERE chain_id=$1 AND block_number>$2`,[chainId,ancestor.toString()]);
            const ancestorBlock=ancestor>=0n?await client.getBlock({blockNumber:ancestor}).catch(()=>null):null;
            await db.query("UPDATE asset_chain_indexer_cursors SET last_indexed_block=$2,last_block_hash=$3,updated_at=NOW() WHERE chain_id=$1",
              [chainId,ancestor.toString(),ancestorBlock?.hash??null]);
            await db.query("DELETE FROM asset_chain_wallets WHERE chain_id=$1",[chainId]);
            await db.query(`INSERT INTO asset_chain_wallets(chain_id,wallet_address,first_seen_block,last_seen_block)
              SELECT $1,wallet,MIN(block_number),MAX(block_number) FROM (
                SELECT from_address wallet,block_number FROM asset_chain_transactions WHERE chain_id=$1
                UNION ALL SELECT to_address,block_number FROM asset_chain_transactions WHERE chain_id=$1 AND to_address IS NOT NULL
                UNION ALL SELECT from_address,block_number FROM asset_chain_transfers WHERE chain_id=$1
                UNION ALL SELECT to_address,block_number FROM asset_chain_transfers WHERE chain_id=$1
              ) x WHERE wallet<>$2 GROUP BY wallet`,[chainId,ZERO]);
            await db.query("COMMIT"); last=ancestor;
          }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
          console.warn(`Asset Chain indexer reorg detected; rewound to block ${ancestor}`);
        }
      }
      const head=await client.getBlockNumber(), safeHead=head>confirmations?head-confirmations:0n;
      let processed=0;
      while(last<safeHead&&processed<maxBlocks){last++;await indexOneBlock(client,chainId,last);processed++;}
      if(processed)console.log(`Asset Chain indexer stored ${processed} confirmed blocks through ${last}`);
    }catch(error){console.error("Asset Chain indexer poll failed:",error instanceof Error?error.message:"Unknown error");}
    setTimeout(()=>{void poll();},interval).unref();
  };
  void poll();
  console.log(`Asset Chain full indexer initialized on Enugu testnet from block ${effectiveStart}`);
}
