import type { Address } from "viem";
import { ARBITRUM_ONE } from "@nablaz/sdk/addresses";
import erc8004 from "./generated/erc8004.json" with { type: "json" };

/**
 * One chain's sources. Every address is public on chain; nothing here is a secret.
 *
 * `nabla`: NablaZ contracts. Null means no NablaZ source on this chain (R-S189-1: NablaZ entries stay
 * Arbitrum-only). `external`: third-party sources (s3 §6.4c), pasted from nablaz-protocol
 * script/expected/external-{arbitrum,base}.txt at 4ace372840989469430996afd7f4668cab046e8e (Arbitrum, Base),
 * from MetaMask's own deployment list (Polygon, below), and at the same canonical addresses (Optimism, Linea; S230). An external source a chain does not carry is null in both
 * its address and its start block (R-S221-8: Polygon carries the DelegationManager only); an enabled chain with
 * one of the two set and not the other is refused.
 */
export type ChainSources = {
  chainId: number;
  /** Ponder chain name. */
  name: string;
  /** Disabled chains stay in the registry but never reach the Ponder config. */
  enabled: boolean;
  /**
   * Environment variable holding this chain's indexer RPC URL: head tracking and state reads (src/rpc.ts).
   * The URLs themselves are never stored in the repo.
   */
  rpcEnv: string;
  /** Environment variable holding this chain's grounding RPC URL: backfill eth_getLogs and the grounding reads. */
  groundingRpcEnv: string;
  /** Native USDC on this chain (Circle); read only by the NablaZ vault source. Null on a chain without NablaZ sources that has no need of it. */
  usdc: Address | null;
  nabla: {
    NablaRecord: Address | null;
    /**
     * NablaRecordV2 (G1-A; R-S221-4): V3_2 accounts write here, V3_1 and older keep writing to NablaRecord until each
     * holder upgrades. Same RecordEntry topic0, so one decoder serves both; read merged per subject.
     */
    NablaRecordV2: Address | null;
    NablaAccountFactoryPermanent: Address | null;
    AccountRegistryV6: Address | null;
    ConsumerAIMandateV4: Address | null;
    /**
     * CAM V5 (G1-B): NablaAccountV3_2's immutable MANDATE_PIN; a V3_2 account is initialized with it (PIN_MISMATCH(1)
     * otherwise). ABI-identical to V4. Accounts created on V3_1 or older keep V4 until a DEPENDENCY_SET replaces it.
     */
    ConsumerAIMandateV5: Address | null;
    /** NablaAccountV3_2: the implementation whose accounts start on CAM V5. */
    NablaAccountV3_2: Address | null;
    /** First block to index the NablaZ sources from: their earliest deployment block. */
    startBlock: number | null;
    /** NablaRecordV2's deployment block (G1 deploy tx 9, S220), where its source starts. */
    recordV2StartBlock: number | null;
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
    /** Per source: its deployment block; null exactly when the source is not on this chain. */
    startBlocks: {
      SpendPermissionManager: number | null;
      DelegationManager: number | null;
      creditLineLenders: number | null;
      ReputationRegistry: number | null;
      IdentityRegistry: number | null;
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
  137: { DelegationManager: 69623266 },
  // S230 chain join (S230-SE2), same method, 2026-11-25, read-only on the Alchemy grounding key's opt-mainnet and
  // linea-mainnet hosts (record: docs/runbooks/s230-chain-join-measurements.md):
  //   Optimism DelegationManager 133803172: eth_getCode empty at 133803171, 11,503 bytes at 133803172; first log
  //   same block (tx 0x835aafefbbcc5072ac320a76873169dfec237c5d03b249675cae5a16249c904b, logIndex 75, OwnershipTransferred).
  //   Optimism SpendPermissionManager 129095661: empty at 129095660, 12,610 bytes at 129095661; first log 129214148
  //   (tx 0xbe1a4d3b1c8fd7ca9e4f88dbdb5eda3b7cb65fdb8e68a6277a3d9251a6795bc4, logIndex 68).
  //   Linea DelegationManager 17474505: empty at 17474504, 11,503 bytes at 17474505; first log same block
  //   (tx 0xd23a15a0a715899d6854587e39942d80b2e9974f7667bb5799eea1ff24141772, logIndex 0, OwnershipTransferred).
  10: { SpendPermissionManager: 129095661, DelegationManager: 133803172 },
  59144: { DelegationManager: 17474505 },
} as const;

/** ERC-8004 registries per chain, from src/generated/erc8004.json (scripts/gen-erc8004.ts). */
const ERC8004 = erc8004.chains as Record<string, { IdentityRegistry: string; ReputationRegistry: string }>;

// Same address on both chains (s3 §6.4c premise 1).
const SPM: Address = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
/**
 * MetaMask DelegationManager v1.3.0. Polygon (R-S221-8 #2), read from MetaMask's own publications on 2026-11-16:
 * npm @metamask/delegation-deployments@2.1.0, dist/index.mjs, DELEGATOR_CONTRACTS["1.3.0"][137] = DEPLOYMENTS_1_3_0,
 * whose DelegationManager is this address; and MetaMask/delegation-framework documents/Deployments.md at b4b8c41
 * ("v1.3.0", DelegationManager, Polygon among the mainnets). Polygon's deployment block 69623266: eth_getCode is
 * empty at 69623265 and 11,503 bytes at 69623266 (archive RPC, 2026-11-16). Its runtime code equals Arbitrum's and
 * Base's except the immutables (chain id and cached EIP-712 domain separator), so the one decoder serves all three.
 * Polygon also has v1.0.0 and v1.1.0 managers at other addresses; like Arbitrum and Base, only v1.3.0 is indexed.
 * Optimism and Linea (S230): the same address; scripts/grantor-count.ts's bytecode gate (R-S226-7) holds the same
 * claim for each before it counts (record: docs/runbooks/s230-chain-join-measurements.md).
 */
const DM: Address = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";

export const CHAINS: Record<number, ChainSources> = {
  42161: {
    chainId: 42161,
    name: "arbitrum",
    enabled: true,
    rpcEnv: "READER_ARBITRUM_RPC_URL",
    groundingRpcEnv: "READER_ARBITRUM_GROUNDING_RPC_URL",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    nabla: {
      NablaRecord: arb.NablaRecord.address,
      NablaRecordV2: arb.NablaRecordV2.address,
      NablaAccountFactoryPermanent: arb.NablaAccountFactoryPermanent.address,
      AccountRegistryV6: arb.AccountRegistryV6.address,
      ConsumerAIMandateV4: arb.ConsumerAIMandateV4.address,
      ConsumerAIMandateV5: arb.ConsumerAIMandateV5.address,
      NablaAccountV3_2: arb.NablaAccountV3_2.address,
      startBlock: Math.min(arb.NablaRecord.deployBlock, arb.NablaAccountFactoryPermanent.deployBlock, arb.AccountRegistryV6.deployBlock),
      recordV2StartBlock: arb.NablaRecordV2.deployBlock,
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
    groundingRpcEnv: "READER_BASE_GROUNDING_RPC_URL",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    nabla: {
      NablaRecord: null,
      NablaRecordV2: null,
      NablaAccountFactoryPermanent: null,
      AccountRegistryV6: null,
      ConsumerAIMandateV4: null,
      ConsumerAIMandateV5: null,
      NablaAccountV3_2: null,
      startBlock: null,
      recordV2StartBlock: null,
    },
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
  // Polygon PoS (R-S221-8 #2): the MetaMask DelegationManager only. No NablaZ contract (R-S189-1), no
  // SpendPermissionManager, ERC-8004 registry or credit-line source. Falsifier: under ~1k distinct root delegators
  // across 90 days of this index pauses the chain; the measurement is published either way.
  137: {
    chainId: 137,
    name: "polygon",
    enabled: true,
    rpcEnv: "READER_POLYGON_RPC_URL",
    groundingRpcEnv: "READER_POLYGON_GROUNDING_RPC_URL",
    usdc: null,
    nabla: {
      NablaRecord: null,
      NablaRecordV2: null,
      NablaAccountFactoryPermanent: null,
      AccountRegistryV6: null,
      ConsumerAIMandateV4: null,
      ConsumerAIMandateV5: null,
      NablaAccountV3_2: null,
      startBlock: null,
      recordV2StartBlock: null,
    },
    external: {
      SpendPermissionManager: null,
      DelegationManager: DM,
      ReputationRegistry: null,
      IdentityRegistry: null,
      creditLineLenders: [],
      startBlocks: {
        SpendPermissionManager: null,
        DelegationManager: DEPLOYED[137].DelegationManager,
        creditLineLenders: null,
        ReputationRegistry: null,
        IdentityRegistry: null,
      },
    },
  },
  // OP Mainnet (S230 chain join): the SpendPermissionManager and the MetaMask DelegationManager. No NablaZ contract
  // (R-S189-1), no ERC-8004 registry or credit-line source. Join measurement, DelegationManager: 503 distinct
  // grantors over 30 days (scripts/grantor-count.ts, falsifier 500; docs/runbooks/s230-chain-join-measurements.md).
  10: {
    chainId: 10,
    name: "optimism",
    enabled: true,
    rpcEnv: "READER_OPTIMISM_RPC_URL",
    groundingRpcEnv: "READER_OPTIMISM_GROUNDING_RPC_URL",
    usdc: null,
    nabla: {
      NablaRecord: null,
      NablaRecordV2: null,
      NablaAccountFactoryPermanent: null,
      AccountRegistryV6: null,
      ConsumerAIMandateV4: null,
      ConsumerAIMandateV5: null,
      NablaAccountV3_2: null,
      startBlock: null,
      recordV2StartBlock: null,
    },
    external: {
      SpendPermissionManager: SPM,
      DelegationManager: DM,
      ReputationRegistry: null,
      IdentityRegistry: null,
      creditLineLenders: [],
      startBlocks: {
        SpendPermissionManager: DEPLOYED[10].SpendPermissionManager,
        DelegationManager: DEPLOYED[10].DelegationManager,
        creditLineLenders: null,
        ReputationRegistry: null,
        IdentityRegistry: null,
      },
    },
  },
  // Linea (S230 chain join): the MetaMask DelegationManager only (the join scope of record). No NablaZ contract
  // (R-S189-1), no SpendPermissionManager (eth_getCode at its canonical address is empty on Linea, 2026-11-25),
  // ERC-8004 registry or credit-line source.
  59144: {
    chainId: 59144,
    name: "linea",
    enabled: true,
    rpcEnv: "READER_LINEA_RPC_URL",
    groundingRpcEnv: "READER_LINEA_GROUNDING_RPC_URL",
    usdc: null,
    nabla: {
      NablaRecord: null,
      NablaRecordV2: null,
      NablaAccountFactoryPermanent: null,
      AccountRegistryV6: null,
      ConsumerAIMandateV4: null,
      ConsumerAIMandateV5: null,
      NablaAccountV3_2: null,
      startBlock: null,
      recordV2StartBlock: null,
    },
    external: {
      SpendPermissionManager: null,
      DelegationManager: DM,
      ReputationRegistry: null,
      IdentityRegistry: null,
      creditLineLenders: [],
      startBlocks: {
        SpendPermissionManager: null,
        DelegationManager: DEPLOYED[59144].DelegationManager,
        creditLineLenders: null,
        ReputationRegistry: null,
        IdentityRegistry: null,
      },
    },
  },
};

/**
 * Where an external source starts indexing: its deployment block, unless READER_EXTERNAL_FROM
 * ("<chainId>:<block>,…") moves it later for a local read over a window. READER_START_BLOCK, when set,
 * overrides both in ponder.config.ts.
 */
export function externalStart(c: ChainSources, source: ExternalSource, env = process.env): number | null {
  const deployed = c.external.startBlocks[source];
  if (deployed === null) return null;
  if (env.READER_START_BLOCK) return Number(env.READER_START_BLOCK);
  for (const kv of (env.READER_EXTERNAL_FROM ?? "").split(",").filter(Boolean)) {
    const [id, block] = kv.split(":").map((x) => Number(x.trim()));
    if (id === c.chainId && block !== undefined && Number.isFinite(block)) return Math.max(block, deployed);
  }
  return deployed;
}

export type ExternalSource = keyof ChainSources["external"]["startBlocks"];

/** True when the chain carries this external source (credit lines: when it has a registered lender). */
export function hasExternal(c: ChainSources, source: ExternalSource): boolean {
  if (source === "creditLineLenders") return c.external.creditLineLenders.length > 0 && c.external.startBlocks.creditLineLenders !== null;
  return c.external[source] !== null && c.external.startBlocks[source] !== null;
}

/** READER_SOURCES: which source groups this instance indexes ("nabla", "external"; default both). */
export function sourcesOn(env = process.env): Set<"nabla" | "external"> {
  return new Set((env.READER_SOURCES || "nabla,external").split(",").map((s) => s.trim()) as ("nabla" | "external")[]);
}

/** Where NablaRecordV2 starts indexing: its deployment block, unless READER_START_BLOCK overrides it. */
export function recordV2Start(c: ChainSources, env = process.env): number | null {
  if (c.nabla.recordV2StartBlock === null) return null;
  return env.READER_START_BLOCK ? Number(env.READER_START_BLOCK) : c.nabla.recordV2StartBlock;
}

/** Where the NablaZ sources start indexing. */
export function nablaStart(c: ChainSources, env = process.env): number | null {
  if (c.nabla.startBlock === null) return null;
  return env.READER_START_BLOCK ? Number(env.READER_START_BLOCK) : c.nabla.startBlock;
}

/** The earliest block any source on the chain starts from. */
export function startBlockOf(c: ChainSources): number {
  const xs = [c.external.startBlocks.SpendPermissionManager, c.external.startBlocks.DelegationManager, c.nabla.startBlock].filter((x): x is number => x !== null);
  return Math.min(...xs);
}

export type NablaContracts = { [K in Exclude<keyof ChainSources["nabla"], "startBlock" | "recordV2StartBlock">]: Address } & {
  startBlock: number;
  recordV2StartBlock: number;
};

export type EnabledChain = ChainSources;

/** True when every NablaZ source on the chain has an address. */
export function hasNabla(c: ChainSources): c is ChainSources & { nabla: NablaContracts } {
  return Object.values(c.nabla).every((v) => v !== null);
}

/**
 * Enabled chains. Refuses an enabled chain with an external source whose address and start block disagree (one
 * null, the other set), a chain with no source at all, and a chain whose NablaZ sources are partly set. NablaZ
 * nulls together mean "no NablaZ sources on this chain"; an external null pair means "not on this chain".
 * READER_CHAINS (comma-separated chain ids) narrows the set; the tests use it.
 */
export function enabledChains(chains: Record<number, ChainSources> = CHAINS, only = process.env.READER_CHAINS): EnabledChain[] {
  const want = only ? new Set(only.split(",").map((s) => Number(s.trim()))) : null;
  return Object.values(chains)
    .filter((c) => c.enabled && (want === null || want.has(c.chainId)))
    .map((c) => {
      for (const name of ["SpendPermissionManager", "DelegationManager", "ReputationRegistry", "IdentityRegistry"] as const) {
        if ((c.external[name] === null) !== (c.external.startBlocks[name] === null))
          throw new Error(`chain ${c.chainId} is enabled but external ${name} has an address without a start block, or a start block without an address`);
      }
      if (c.external.creditLineLenders.length > 0 && c.external.startBlocks.creditLineLenders === null)
        throw new Error(`chain ${c.chainId} has credit-line lenders but no creditLineLenders start block`);
      const nulls = Object.values(c.nabla).filter((v) => v === null).length;
      if (nulls !== 0 && nulls !== Object.keys(c.nabla).length) throw new Error(`chain ${c.chainId} has a partial NablaZ source set`);
      const anyExternal = (["SpendPermissionManager", "DelegationManager", "ReputationRegistry", "IdentityRegistry"] as const).some((n) => c.external[n] !== null);
      if (nulls !== 0 && !anyExternal) throw new Error(`chain ${c.chainId} is enabled but carries no source`);
      return c;
    });
}

/** A registered source's deployment block on the chain; throws when the chain does not carry it (handlers only run where it does). */
export function sourceStart(chainId: number, source: ExternalSource): number {
  const b = chainById(chainId).external.startBlocks[source];
  if (b === null) throw new Error(`chain ${chainId} does not carry ${source}`);
  return b;
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
