// pnpm report:c-share <chainId> <fromBlock> <toBlock>
//
// R-S190-3: per token, the count and value of payment facts labelled (c) over all payment facts, over the whole
// index in the block range. Reads the PGlite index directly (READER_PGLITE_DIR, default .ponder/pglite); stop
// the reader first, PGlite allows one process. Vault payments are labelled by their account's NablaZ label,
// which needs the chain's RPC (READER_ARBITRUM_RPC_URL) for the mandate code hash at <toBlock>. Prints the inputs,
// the shares and the reproducing queries.

import { PGlite } from "@electric-sql/pglite";
import { createPublicClient, http, keccak256, type Address, type Hex } from "viem";
import { NablaAccountV3_1Abi } from "@nablaz/sdk/abis";
import { CHAINS, hasNabla } from "../src/chains.ts";
import { nablaLabel } from "../src/labels.ts";
import { EXTERNAL_PAYMENTS_SQL, VAULT_PAYMENTS_SQL, cShareOverIndex, formatShare } from "../src/c-share.ts";

const [chainArg, fromArg, toArg] = process.argv.slice(2);
if (!chainArg || !fromArg || !toArg) throw new Error("usage: pnpm report:c-share <chainId> <fromBlock> <toBlock>");
const chainId = Number(chainArg);
const from = BigInt(fromArg);
const to = BigInt(toArg);
const chain = CHAINS[chainId];
if (!chain) throw new Error(`chain ${chainId} is not read here`);
const dir = process.env.READER_PGLITE_DIR ?? ".ponder/pglite";

const db = new PGlite(dir);
const q = async <T>(sql: string, params: unknown[]) => (await db.query<T>(sql, params)).rows;

async function accountShape(account: Address): Promise<string> {
  if (!hasNabla(chain!)) return "c";
  const url = process.env[chain!.rpcEnv];
  if (!url) throw new Error(`${chain!.rpcEnv} is not set: a vault payment's label needs the account's mandate code hash`);
  const client = createPublicClient({ transport: http(url) });
  const impls = await q<{ implementation: string }>(
    "SELECT implementation FROM reader.implementation_history WHERE chain_id = $1 AND account = $2 AND source = 'Upgraded' ORDER BY block_number, log_index",
    [chainId, account.toLowerCase()],
  );
  const code = async (a: Address) => {
    const c = await client.getCode({ address: a, blockNumber: to });
    return c && c !== "0x" ? keccak256(c) : null;
  };
  const deps = await client.readContract({ address: account, abi: NablaAccountV3_1Abi, functionName: "dependencies", blockNumber: to }).catch(() => null);
  const mandate = deps ? (deps[0] as Address) : null;
  return nablaLabel({
    implementations: impls.map((r) => r.implementation as Address),
    mandateCodeHash: mandate ? await code(mandate) : null,
    camV4CodeHash: (await code(chain!.nabla.ConsumerAIMandateV4!)) as Hex,
  }).shape;
}

try {
  const r = await cShareOverIndex(q, chainId, from, to, accountShape);
  console.log(`inputs: chainId ${chainId}, blocks ${from}..${to}, index ${dir} (schema reader)`);
  for (const line of formatShare(chainId, from, to, r)) console.log(line);
  console.log(`queries ($1 = ${chainId}, $2 = ${from}, $3 = ${to}):\n${EXTERNAL_PAYMENTS_SQL};\n${VAULT_PAYMENTS_SQL};`);
} finally {
  await db.close();
}
