// The chain reads behind feedback grounding (R-S191-11, R-S191-16), shared by GET /read and the AFG test.
//
// Plain transfers are not indexed: no source filter can name every rater in advance. They are read at read
// time with eth_getLogs, topic0 = Transfer, topic1 = the rater, any token address, over an explicit block range
// that ends at the feedback block. ERC-721 Transfers (four topics) are dropped. A transfer counts only if its
// recipient is the address bound at the transfer's own block (R-S191-16): getAgentWallet there, else ownerOf
// there. Candidates are the recipients that appear in the agentId's agentWallet history (MetadataSet, s3 §6.4b
// (10)) or owner history (the Identity Registry's ERC-721 Transfer, s3 §6.4b (11)); each candidate's binding is
// read at exactly the transfer's block, never later.

import { getAddress, hexToBigInt, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { IdentityRegistryAbi } from "./external-abis.ts";
import { AGENT_WALLET_KEY_TOPIC } from "./oneliners.ts";
import { TRANSFER_TOPIC } from "./delegation.ts";
import type { Binding, RaterTransfer } from "./read.ts";

const ownerOfAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

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

/** Every address that has owned `agentId` up to `toBlock` (the Identity Registry's ERC-721 Transfer, topic3). */
export async function ownerHistory(client: PublicClient, registry: Address, agentId: bigint, fromBlock: bigint, toBlock: bigint): Promise<Set<string>> {
  const logs = await getLogsSplit(client, { address: registry, topics: [TRANSFER_TOPIC, null, null, pad32(`0x${agentId.toString(16)}`)] }, fromBlock, toBlock);
  const out = new Set<string>();
  for (const l of logs) if (l.topics.length === 4) out.add(`0x${l.topics[2]!.slice(26)}`.toLowerCase());
  out.delete(ZERO);
  return out;
}

/**
 * R-S191-16 at one block: getAgentWallet, else ownerOf; "none" when ownerOf reverts with the registry's
 * ERC721NonexistentToken (the identity did not exist). Any other failure is thrown: a read that cannot be made.
 */
export async function bindingAt(client: PublicClient, registry: Address, agentId: bigint, blockNumber: bigint): Promise<Binding> {
  const wallet = await walletAt(client, registry, agentId, blockNumber);
  if (wallet) return { kind: "agentWallet", address: wallet };
  try {
    const owner = await client.readContract({ address: registry, abi: ownerOfAbi, functionName: "ownerOf", args: [agentId], blockNumber });
    return { kind: "owner", address: getAddress(owner) };
  } catch (e) {
    // ERC721NonexistentToken(uint256): selector 0x7e273289.
    if (/0x7e273289/.test(String((e as { message?: string }).message ?? e)) || /0x7e273289/.test(JSON.stringify(e, Object.getOwnPropertyNames(e as object)))) return { kind: "none" };
    throw e;
  }
}

/** Every address the agentId has been bound to up to `toBlock`: its agentWallet history and its owner history. */
export async function boundHistory(client: PublicClient, registry: Address, agentId: bigint, fromBlock: bigint, toBlock: bigint): Promise<Set<string>> {
  const [w, o] = await Promise.all([agentWalletHistory(client, registry, agentId, fromBlock, toBlock), ownerHistory(client, registry, agentId, fromBlock, toBlock)]);
  return new Set([...w, ...o]);
}

/**
 * The binding at each candidate transfer's own block, for transfers whose recipient is in `candidates`. Returns
 * the lookup groundingTransfers takes; a block with no candidate transfer reads as undefined.
 */
export async function bindingsAtTransferBlocks(
  client: PublicClient,
  registry: Address,
  agentId: bigint,
  transfers: RaterTransfer[],
  candidates: Set<string>,
): Promise<(block: bigint) => Binding | undefined> {
  const at = new Map<bigint, Binding>();
  for (const t of transfers) {
    if (!candidates.has(t.to.toLowerCase()) || at.has(t.block)) continue;
    at.set(t.block, await bindingAt(client, registry, agentId, t.block));
  }
  return (block) => at.get(block);
}
