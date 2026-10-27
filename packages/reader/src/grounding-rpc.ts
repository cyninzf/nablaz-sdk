// The chain reads behind feedback grounding (R-S191-11, R-S191-12), shared by GET /read and the AFG test.
//
// Plain transfers are not indexed: no source filter can name every rater in advance. They are read at read
// time with eth_getLogs, topic0 = Transfer, topic1 = the rater, any token address, over an explicit block range
// that ends at the feedback block. ERC-721 Transfers (four topics) are dropped. A transfer counts only if its
// recipient is the agentWallet at the transfer's own block: candidates are the recipients in the agentId's
// agentWallet history (MetadataSet, s3 §6.4b (10)), each confirmed by getAgentWallet at that block.

import { getAddress, hexToBigInt, type Address, type Hex, type PublicClient } from "viem";
import { IdentityRegistryAbi } from "./external-abis.ts";
import { AGENT_WALLET_KEY_TOPIC } from "./oneliners.ts";
import { TRANSFER_TOPIC } from "./delegation.ts";
import type { RaterTransfer } from "./read.ts";

const METADATA_SET_TOPIC: Hex = "0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b";
const ZERO = "0x0000000000000000000000000000000000000000";
const pad32 = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex; logIndex: Hex };

/** eth_getLogs over [from, to], halving the range whenever the RPC refuses it (result caps, range caps). */
async function getLogsSplit(client: PublicClient, filter: { address?: Address; topics: (Hex | null)[] }, from: bigint, to: bigint): Promise<RawLog[]> {
  try {
    return (await client.request({
      method: "eth_getLogs",
      params: [{ ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` } as never],
    })) as RawLog[];
  } catch (e) {
    if (to - from < 1n) throw e;
    const mid = (from + to) / 2n;
    return [...(await getLogsSplit(client, filter, from, mid)), ...(await getLogsSplit(client, filter, mid + 1n, to))];
  }
}

/** Every ERC-20 Transfer whose sender (topic1) is `from`, in [fromBlock, toBlock]. */
export async function transfersFrom(client: PublicClient, chainId: number, from: Address, fromBlock: bigint, toBlock: bigint): Promise<RaterTransfer[]> {
  const logs = await getLogsSplit(client, { topics: [TRANSFER_TOPIC, pad32(from)] }, fromBlock, toBlock);
  return logs
    .filter((l) => l.topics.length === 3 && (l.data.length - 2) / 2 === 32)
    .map((l) => ({
      chainId,
      token: getAddress(l.address),
      from: getAddress(`0x${l.topics[1]!.slice(26)}`),
      to: getAddress(`0x${l.topics[2]!.slice(26)}`),
      amount: hexToBigInt(l.data),
      block: hexToBigInt(l.blockNumber),
      tx: l.transactionHash,
      logIndex: Number(hexToBigInt(l.logIndex)),
    }));
}

/** Every address `agentId`'s agentWallet has held up to `toBlock` (MetadataSet with the agentWallet key). */
export async function agentWalletHistory(client: PublicClient, registry: Address, agentId: bigint, fromBlock: bigint, toBlock: bigint): Promise<Set<string>> {
  const logs = await getLogsSplit(client, { address: registry, topics: [METADATA_SET_TOPIC, pad32(`0x${agentId.toString(16)}`), AGENT_WALLET_KEY_TOPIC] }, fromBlock, toBlock);
  const out = new Set<string>();
  for (const l of logs) {
    // data = abi.encode(string metadataKey, bytes metadataValue); a 20-byte value is a wallet, empty clears.
    const value = l.data.slice(2);
    const off = Number(BigInt(`0x${value.slice(64, 128)}`)) * 2;
    const len = Number(BigInt(`0x${value.slice(off, off + 64)}`));
    if (len === 20) out.add(`0x${value.slice(off + 64, off + 64 + 40)}`.toLowerCase());
  }
  return out;
}

/** getAgentWallet(agentId) at a block; the zero address reads as null. */
export async function walletAt(client: PublicClient, registry: Address, agentId: bigint, blockNumber: bigint): Promise<Address | null> {
  const w = await client.readContract({ address: registry, abi: IdentityRegistryAbi, functionName: "getAgentWallet", args: [agentId], blockNumber });
  return w === ZERO ? null : getAddress(w);
}

/**
 * The agentWallet at each candidate transfer's block, for transfers whose recipient the agentId's wallet
 * history contains. Returns a lookup for groundingTransfers; a block not looked up reads as null.
 */
export async function walletsAtTransferBlocks(
  client: PublicClient,
  registry: Address,
  agentId: bigint,
  transfers: RaterTransfer[],
  history: Set<string>,
): Promise<(block: bigint) => Address | null> {
  const at = new Map<bigint, Address | null>();
  for (const t of transfers) {
    if (!history.has(t.to.toLowerCase()) || at.has(t.block)) continue;
    at.set(t.block, await walletAt(client, registry, agentId, t.block));
  }
  return (block) => at.get(block) ?? null;
}
