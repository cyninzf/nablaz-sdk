import type { Address } from "viem";
import { ARBITRUM_ONE } from "@nablaz/sdk/addresses";

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
    /** ERC-8004 Reputation Registry: carried for the feedback grounding read (part 3); not indexed here. */
    ReputationRegistry: Address | null;
    /** Agent Credit Lines lenders. None is known on either chain (s3 §6.4b (6)). */
    creditLineLenders: Address[];
    /** Per source: its deployment block. */
    startBlocks: { SpendPermissionManager: number; DelegationManager: number; creditLineLenders: number };
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
 */
const DEPLOYED = {
  42161: { SpendPermissionManager: 283144909, DelegationManager: 320575464, ReputationRegistry: 428895450 },
  8453: { SpendPermissionManager: 23499060, DelegationManager: 28207787, ReputationRegistry: 41663784 },
} as const;

// Same address on both chains (s3 §6.4c premise 1).
const SPM: Address = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
const DM: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const REPUTATION: Address = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

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
      ReputationRegistry: REPUTATION,
      creditLineLenders: [],
      startBlocks: {
        SpendPermissionManager: DEPLOYED[42161].SpendPermissionManager,
        DelegationManager: DEPLOYED[42161].DelegationManager,
        creditLineLenders: DEPLOYED[42161].SpendPermissionManager,
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
      ReputationRegistry: REPUTATION,
      creditLineLenders: [],
      startBlocks: {
        SpendPermissionManager: DEPLOYED[8453].SpendPermissionManager,
        DelegationManager: DEPLOYED[8453].DelegationManager,
        creditLineLenders: DEPLOYED[8453].SpendPermissionManager,
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
  external: ChainSources["external"] & { SpendPermissionManager: Address; DelegationManager: Address; ReputationRegistry: Address };
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

/**
 * Implementations ProtocolConfig has published as currentAccountImpl, oldest first: NablaAccountV3 at P1,
 * then NablaAccountV3_1 (Safe nonce 147, tx 0x4e6fc2c23182ea9ec1b56039524eafaee19346be8c1146c616d23989c65a1033,
 * block 517848229; s3 §10 row VF). A fork test asserts the tip equals ProtocolConfig.currentAccountImpl().
 */
export const CURRENT_ACCOUNT_IMPL_LINEAGE: readonly Address[] = [arb.NablaAccountV3.address, arb.NablaAccountV3_1.address];
/** ProtocolConfig and NablaAccountBootstrap, from nablaz-protocol script/expected/permanent-arbitrum.txt. */
export const PROTOCOL_CONFIG: Address = "0x59C3023543956e133dce6E1D22D4974bCF1097AE";
export const NABLA_ACCOUNT_BOOTSTRAP: Address = "0xCa3330683eD6659B44EBA03B8d057e65e6Ff2eD5";
