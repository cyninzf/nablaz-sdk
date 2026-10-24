import type { Address } from "viem";
import { ARBITRUM_ONE } from "@nablaz/sdk/addresses";

/** One chain's sources. Every address is public on chain; nothing here is a secret. */
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
  /** First block to index. The earliest deployment block of the contracts below. */
  startBlock: number;
  contracts: {
    NablaRecord: Address | null;
    NablaAccountFactoryPermanent: Address;
    AccountRegistryV6: Address | null;
    ConsumerAIMandateV4: Address | null;
    GranteeVault: Address | null;
  };
};

const arb = ARBITRUM_ONE.contracts;

export const CHAINS: Record<number, ChainSources> = {
  42161: {
    chainId: 42161,
    name: "arbitrum",
    enabled: true,
    rpcEnv: "READER_ARB_RPC_URL",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    startBlock: Math.min(
      arb.NablaRecord.deployBlock,
      arb.NablaAccountFactoryPermanent.deployBlock,
      arb.AccountRegistryV6.deployBlock,
    ),
    contracts: {
      NablaRecord: arb.NablaRecord.address,
      NablaAccountFactoryPermanent: arb.NablaAccountFactoryPermanent.address,
      AccountRegistryV6: arb.AccountRegistryV6.address,
      ConsumerAIMandateV4: arb.ConsumerAIMandateV4.address,
      GranteeVault: arb.GranteeVault.address,
    },
  },
  // Base: present, disabled. The permanent factory's address is the same as on Arbitrum; as read on
  // 2026-10-23 there is no code at it on Base yet, and no other address is published for Base.
  8453: {
    chainId: 8453,
    name: "base",
    enabled: false,
    rpcEnv: "READER_BASE_RPC_URL",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    startBlock: 0,
    contracts: {
      NablaRecord: null,
      NablaAccountFactoryPermanent: arb.NablaAccountFactoryPermanent.address,
      AccountRegistryV6: null,
      ConsumerAIMandateV4: null,
      GranteeVault: null,
    },
  },
};

export type EnabledChain = ChainSources & {
  contracts: { [K in keyof ChainSources["contracts"]]: Address };
};

/** Enabled chains. Refuses to enable a chain with an unpublished address. */
export function enabledChains(chains: Record<number, ChainSources> = CHAINS): EnabledChain[] {
  return Object.values(chains)
    .filter((c) => c.enabled)
    .map((c) => {
      for (const [name, address] of Object.entries(c.contracts)) {
        if (address === null) throw new Error(`chain ${c.chainId} is enabled but ${name} has no address`);
      }
      return c as EnabledChain;
    });
}

export function chainById(chainId: number): EnabledChain {
  const c = enabledChains().find((x) => x.chainId === chainId);
  if (!c) throw new Error(`chain ${chainId} is not enabled`);
  return c;
}
