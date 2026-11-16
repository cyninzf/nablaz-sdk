// β actorIdentity (Shape Sample §2 β; S222): an additive, optional field on /feed payment items naming the ERC-8004
// agentId the payment's actor (the item's subject: the payer) was bound to at the payment's own block, and how.
//
// R-S191-16, the binding read.ts already uses: an agentId's payment address at a block is its agentWallet there, else
// its owner there. Resolved here from the indexed history alone, agent_wallets (MetadataSet "agentWallet"; null when
// cleared) and agent_owners (Transfer; null on burn): no RPC, no new indexing, no schema change. This file is under
// src/api, outside the build id.
//
// "At block B" is the state after block B, as an eth_call at B reads it: every row at or before B counts.
// Absent when the actor is bound to no agentId at B, and for agentId 0 (R-S222: agentId-0 actors carry no identity).
// Several agentIds bound at once: an agentWallet binding wins over an owner binding, then the lowest agentId.

export type ActorIdentity = { agentId: string; binding: "agentWallet" | "owner"; atBlock: string };

/** One row of agent_wallets (value = wallet) or agent_owners (value = owner). */
export type BindingRow = { agentId: bigint; blockNumber: bigint; logIndex: number; value: string | null };

/** The latest value per agentId at or before `block` (rows in any order). */
function latestAt(rows: BindingRow[], block: bigint): Map<bigint, string | null> {
  const best = new Map<bigint, BindingRow>();
  for (const r of rows) {
    if (r.blockNumber > block) continue;
    const b = best.get(r.agentId);
    if (!b || r.blockNumber > b.blockNumber || (r.blockNumber === b.blockNumber && r.logIndex > b.logIndex)) best.set(r.agentId, r);
  }
  return new Map([...best].map(([id, r]) => [id, r.value]));
}

/**
 * The actor's identity at `block`, from the full wallet and owner histories of every agentId the actor has been
 * agentWallet or owner of (on the item's chain). Null when none binds the actor there.
 */
export function actorIdentityAt(actor: string, block: bigint, wallets: BindingRow[], owners: BindingRow[]): ActorIdentity | null {
  const a = actor.toLowerCase();
  const walletAt = latestAt(wallets, block);
  const ownerAt = latestAt(owners, block);
  const ids = [...new Set([...walletAt.keys(), ...ownerAt.keys()])].filter((id) => id !== 0n).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  let owner: bigint | null = null;
  for (const id of ids) {
    const w = walletAt.get(id) ?? null;
    if (w !== null) {
      if (w.toLowerCase() === a) return { agentId: id.toString(), binding: "agentWallet", atBlock: block.toString() };
      continue; // an agentWallet is set: the owner is not the payment address (R-S191-16)
    }
    const o = ownerAt.get(id) ?? null;
    if (owner === null && o !== null && o.toLowerCase() === a) owner = id;
  }
  return owner === null ? null : { agentId: owner.toString(), binding: "owner", atBlock: block.toString() };
}
