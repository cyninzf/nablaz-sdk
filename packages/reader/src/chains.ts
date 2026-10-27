import type { Address } from "viem";
import { ARBITRUM_ONE } from "@nablaz/sdk/addresses";
import erc8004 from "./generated/erc8004.json" with { type: "json" };

/**
 * One chain's sources. Every address is public on chain; nothing here is a secret.
 *
 * `nabla`: NablaZ contracts. Null means no NablaZ source on this chain (R-S189-1: NablaZ entries stay
 * Arbitrum-only). `external`: third-party sources (s3 §6.4c), pasted from nablaz-protocol
 * script/expected/external-{arbitrum,base}.txt at 4ace372840989469430996afd7f4668cab046e8e. An enabled
 * chain must have every external address.
 */
export type ChainSources = {
  chainId: number;
  /** Ponder chain name. */
  name: string;
  /** Disabled chains stay in the registry but never reach the Ponder config. */
  enabled: boolean;
  /** Environment variable holding this chain's RPC URL. The URL itself is never stored in the repo. */
  rpcEnv: string;
  /** Native USDC on this chain (Circle). */
  usdc: Address;
  nabla: {
    NablaRecord: Address | null;
    NablaAccountFactoryPermanent: Address | null;
    AccountRegistryV6: Address | null;
    ConsumerAIMandateV4: Address | null;
    /** First block to index the NablaZ sources from: their earliest deployment block. */
    startBlock: number | null;
  };
  external: {
    SpendPermissionManager: Address | null;
    DelegationManager: Address | null;
    /** ERC-8004 Reputation Registry: NewFeedback, the input of the feedback grounding read (R-D2B-2). */
    ReputationRegistry: Address | null;
    /** ERC-8004 Identity Registry: agentWallet history (MetadataSet) and getAgentWallet at a block. */
    IdentityRegistry: Address | null;
    /** Agent Credit Lines lenders. None is known on either chain (s3 §6.4b (6)). */
    creditLineLenders: Address[];
    /** Per source: its deployment block. */
    startBlocks: {
      SpendPermissionManager: number;
      DelegationManager: number;
      creditLineLenders: number;
      ReputationRegistry: number;
      IdentityRegistry: number;
    };
  };
};

const arb = ARBITRUM_ONE.contracts;

/**
 * Deployment blocks of the external contracts: the first block with code, by binary search on eth_getCode,
 * cross-checked against the first log each emitted (Oct 27 2026):
 *   Arbitrum: SpendPermissionManager 283144909 (first log 392611911); DelegationManager 320575464 (first
 *   log same block); ReputationRegistry 428895450 (same block).
 *   Base: SpendPermissionManager 23499060 (first log 23622712); DelegationManager 28207787 (same block);
 *   ReputationRegistry 41663784 (same block).
 * ERC-8004 IdentityRegistry, same method (Oct 27 2026): Arbitrum 428895443 (first Registered 428913028);
 * Base 41663783 (first Registered 41673162). erc-8004/erc-8004-contracts publishes addresses only, no
 * deployment block, at the pinned vendor commit (src/generated/erc8004.json).
 */
const DEPLOYED = {
  42161: { SpendPermissionManager: 283144909, DelegationManager: 320575464, ReputationRegistry: 428895450, IdentityRegistry: 428895443 },
  8453: { SpendPermissionManager: 23499060, DelegationManager: 28207787, ReputationRegistry: 41663784, IdentityRegistry: 41663783 },
} as const;

/** ERC-8004 registries per chain, from src/generated/erc8004.json (scripts/gen-erc8004.ts). */
const ERC8004 = erc8004.chains as Record<string, { IdentityRegistry: string; ReputationRegistry: string }>;

// Same address on both chains (s3 §6.4c premise 1).
const SPM: Address = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
const DM: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";

export const CHAINS: Record<number, ChainSources> = {
  42161: {
    chainId: 42161,
    name: "arbitrum",
    enabled: true,
    rpcEnv: "READER_ARB_RPC_URL",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    nabla: {
      NablaRecord: arb.NablaRecord.address,
      NablaAccountFactoryPermanent: arb.NablaAccountFactoryPermanent.address,
      AccountRegistryV6: arb.AccountRegistryV6.address,
      ConsumerAIMandateV4: arb.ConsumerAIMandateV4.address,
      startBlock: Math.min(arb.NablaRecord.deployBlock, arb.NablaAccountFactoryPermanent.deployBlock, arb.AccountRegistryV6.deployBlock),
    },
    external: {
      SpendPermissionManager: SPM,
      DelegationManager: DM,
      ReputationRegistry: ERC8004["42161"]!.ReputationRegistry as Address,
      IdentityRegistry: ERC8004["42161"]!.IdentityRegistry as Address,
      creditLineLenders: [],
      startBlocks: {
        SpendPermissionManager: DEPLOYED[42161].SpendPermissionManager,
        DelegationManager: DEPLOYED[42161].DelegationManager,
        creditLineLenders: DEPLOYED[42161].SpendPermissionManager,
        ReputationRegistry: DEPLOYED[42161].ReputationRegistry,
        IdentityRegistry: DEPLOYED[42161].IdentityRegistry,
      },
    },
  },
  // Base: third-party sources only. No NablaZ contract is deployed on Base (R-S189-1).
  8453: {
    chainId: 8453,
    name: "base",
    enabled: true,
    rpcEnv: "READER_BASE_RPC_URL",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    nabla: { NablaRecord: null, NablaAccountFactoryPermanent: null, AccountRegistryV6: null, ConsumerAIMandateV4: null, startBlock: null },
    external: {
      SpendPermissionManager: SPM,
      DelegationManager: DM,
      ReputationRegistry: ERC8004["8453"]!.ReputationRegistry as Address,
      IdentityRegistry: ERC8004["8453"]!.IdentityRegistry as Address,
      creditLineLenders: [],
      startBlocks: {
        SpendPermissionManager: DEPLOYED[8453].SpendPermissionManager,
        DelegationManager: DEPLOYED[8453].DelegationManager,
        creditLineLenders: DEPLOYED[8453].SpendPermissionManager,
        ReputationRegistry: DEPLOYED[8453].ReputationRegistry,
        IdentityRegistry: DEPLOYED[8453].IdentityRegistry,
      },
    },
  },
};

/**
 * Where an external source starts indexing: its deployment block, unless READER_EXTERNAL_FROM
 * ("<chainId>:<block>,…") moves it later for a local read over a window. READER_START_BLOCK, when set,
 * overrides both in ponder.config.ts.
 */
export function externalStart(c: ChainSources, source: keyof ChainSources["external"]["startBlocks"], env = process.env): number {
  if (env.READER_START_BLOCK) return Number(env.READER_START_BLOCK);
  for (const kv of (env.READER_EXTERNAL_FROM ?? "").split(",").filter(Boolean)) {
    const [id, block] = kv.split(":").map((x) => Number(x.trim()));
    if (id === c.chainId && block !== undefined && Number.isFinite(block)) return Math.max(block, c.external.startBlocks[source]);
  }
  return c.external.startBlocks[source];
}

/** READER_SOURCES: which source groups this instance indexes ("nabla", "external"; default both). */
export function sourcesOn(env = process.env): Set<"nabla" | "external"> {
  return new Set((env.READER_SOURCES || "nabla,external").split(",").map((s) => s.trim()) as ("nabla" | "external")[]);
}

/** Where the NablaZ sources start indexing. */
export function nablaStart(c: ChainSources, env = process.env): number | null {
  if (c.nabla.startBlock === null) return null;
  return env.READER_START_BLOCK ? Number(env.READER_START_BLOCK) : c.nabla.startBlock;
}

/** The earliest block any source on the chain starts from. */
export function startBlockOf(c: ChainSources): number {
  const xs = [c.external.startBlocks.SpendPermissionManager, c.external.startBlocks.DelegationManager];
  if (c.nabla.startBlock !== null) xs.push(c.nabla.startBlock);
  return Math.min(...xs);
}

export type NablaContracts = { [K in Exclude<keyof ChainSources["nabla"], "startBlock">]: Address } & { startBlock: number };

export type EnabledChain = ChainSources & {
  external: ChainSources["external"] & { SpendPermissionManager: Address; DelegationManager: Address; ReputationRegistry: Address; IdentityRegistry: Address };
};

/** True when every NablaZ source on the chain has an address. */
export function hasNabla(c: ChainSources): c is ChainSources & { nabla: NablaContracts } {
  return Object.values(c.nabla).every((v) => v !== null);
}

/**
 * Enabled chains. Refuses an enabled chain with a null external address, and a chain whose NablaZ
 * sources are partly set. NablaZ nulls together mean "no NablaZ sources on this chain".
 * READER_CHAINS (comma-separated chain ids) narrows the set; the tests use it.
 */
export function enabledChains(chains: Record<number, ChainSources> = CHAINS, only = process.env.READER_CHAINS): EnabledChain[] {
  const want = only ? new Set(only.split(",").map((s) => Number(s.trim()))) : null;
  return Object.values(chains)
    .filter((c) => c.enabled && (want === null || want.has(c.chainId)))
    .map((c) => {
      for (const [name, address] of Object.entries(c.external)) {
        if (address === null) throw new Error(`chain ${c.chainId} is enabled but external ${name} has no address`);
      }
      const nulls = Object.values(c.nabla).filter((v) => v === null).length;
      if (nulls !== 0 && nulls !== Object.keys(c.nabla).length) throw new Error(`chain ${c.chainId} has a partial NablaZ source set`);
      return c as EnabledChain;
    });
}

export function chainById(chainId: number): EnabledChain {
  const c = enabledChains().find((x) => x.chainId === chainId);
  if (!c) throw new Error(`chain ${chainId} is not enabled`);
  return c;
}

/** The chain's NablaZ contracts; throws on a chain without them. */
export function nablaOf(chainId: number): NablaContracts {
  const c = chainById(chainId);
  if (!hasNabla(c)) throw new Error(`chain ${chainId} has no NablaZ sources`);
  return c.nabla;
}

// ── NablaZ canonical checks (nablaLabel, R-S189-4 AMENDED 2) ─────────

// The currentAccountImpl lineage, the bootstrap and ProtocolConfig live in src/generated/account-lineage.json,
// copied from nablaz-protocol script/expected/permanent-arbitrum.txt (scripts/gen-lineage.ts), with each
// lineage entry's provenance. A fork test asserts the tip equals ProtocolConfig.currentAccountImpl().
export { CURRENT_ACCOUNT_IMPL_LINEAGE, NABLA_ACCOUNT_BOOTSTRAP, PROTOCOL_CONFIG } from "./labels.ts";
