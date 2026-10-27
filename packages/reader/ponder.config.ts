import { createConfig, factory } from "ponder";
import { getAbiItem, parseAbi } from "viem";
import { enabledChains, externalStart, hasNabla, nablaStart, sourcesOn, type EnabledChain, type NablaContracts } from "./src/chains";
import { DelegationManagerAbi } from "./src/delegation";
import { AgentCreditLineAbi, IdentityRegistryAbi, ReputationRegistryAbi, SpendPermissionManagerAbi } from "./src/external-abis";
import { AccountRegistryV6Abi, NablaAccountFactoryPermanentAbi, NablaRecordAbi } from "@nablaz/sdk/abis";

// Every source is parameterized by chain (src/chains.ts). Only enabled chains are configured; a NablaZ
// source is registered only on chains that have one (R-S189-1).
// Optional overrides, used by the tests: READER_START_BLOCK, READER_END_BLOCK, READER_PGLITE_DIR,
// READER_CHAINS (chain ids, comma-separated), READER_SOURCES ("nabla", "external" or both, comma-separated),
// READER_EXTERNAL_FROM (src/chains.ts).
// USDC Transfer is not indexed wholesale: the redemption handler reads the tx receipt (R-S189-5).

const UpgradedAbi = parseAbi(["event Upgraded(address indexed implementation)"]);
const UsdcAbi = parseAbi(["event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]);

const factoryCreated = getAbiItem({ abi: NablaAccountFactoryPermanentAbi, name: "AccountCreated" });
const registryCreated = getAbiItem({ abi: AccountRegistryV6Abi, name: "AccountCreated" });

const envBlock = (name: string) => {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : Number(v);
};
const startOverride = envBlock("READER_START_BLOCK");
const endOverride = envBlock("READER_END_BLOCK");

const chainsOn = enabledChains();
const sources = sourcesOn();

/** One entry per chain that `pick` accepts; each with its own start block unless overridden. */
function on<T extends object>(pick: (c: EnabledChain) => boolean, build: (c: EnabledChain) => T, start: (c: EnabledChain) => number) {
  return Object.fromEntries(
    chainsOn
      .filter(pick)
      .map((c) => [c.name, { ...build(c), startBlock: startOverride ?? start(c), ...(endOverride ? { endBlock: endOverride } : {}) }]),
  );
}
const nablaOn = (c: EnabledChain) => sources.has("nabla") && hasNabla(c);
const externalOn = () => sources.has("external");
type NablaChain = EnabledChain & { nabla: NablaContracts };
function perChain<T extends object>(build: (c: NablaChain) => T) {
  return on(nablaOn, (c) => build(c as NablaChain), (c) => nablaStart(c)!);
}

export default createConfig({
  ordering: "omnichain",
  database: { kind: "pglite", directory: process.env.READER_PGLITE_DIR ?? ".ponder/pglite" },
  chains: Object.fromEntries(chainsOn.map((c) => [c.name, { id: c.chainId, rpc: process.env[c.rpcEnv] }])),
  contracts: {
    NablaRecord: {
      abi: NablaRecordAbi,
      chain: perChain((c) => ({ address: c.nabla.NablaRecord })),
    },
    AccountFactory: {
      abi: NablaAccountFactoryPermanentAbi,
      chain: perChain((c) => ({ address: c.nabla.NablaAccountFactoryPermanent })),
    },
    AccountRegistry: {
      abi: AccountRegistryV6Abi,
      chain: perChain((c) => ({ address: c.nabla.AccountRegistryV6 })),
    },
    // ERC-1967 Upgraded on every account proxy, discovered from either AccountCreated.
    AccountProxyViaFactory: {
      abi: UpgradedAbi,
      chain: perChain((c) => ({
        address: factory({
          address: c.nabla.NablaAccountFactoryPermanent,
          event: factoryCreated,
          parameter: "account",
        }),
      })),
    },
    AccountProxyViaRegistry: {
      abi: UpgradedAbi,
      chain: perChain((c) => ({
        address: factory({ address: c.nabla.AccountRegistryV6, event: registryCreated, parameter: "account" }),
      })),
    },
    // USDC AuthorizationUsed, all authorizers; the handler keeps only vaults discovered from
    // PAY_AUTHORIZED. A vault is never the emitter, so a Ponder factory cannot narrow this filter.
    Usdc: {
      abi: UsdcAbi,
      chain: perChain((c) => ({ address: c.usdc })),
    },

    // ── External sources (s3 §6.4c), every enabled chain ──
    SpendPermissionManager: {
      abi: SpendPermissionManagerAbi,
      chain: on(externalOn, (c) => ({ address: c.external.SpendPermissionManager }), (c) => externalStart(c, "SpendPermissionManager")),
    },
    DelegationManager: {
      abi: DelegationManagerAbi,
      chain: on(externalOn, (c) => ({ address: c.external.DelegationManager }), (c) => externalStart(c, "DelegationManager")),
    },
    // ERC-8004 (R-D2B-2): NewFeedback, and the agentWallet history from MetadataSet (other keys are skipped by
    // the handler).
    ReputationRegistry: {
      abi: ReputationRegistryAbi,
      chain: on(externalOn, (c) => ({ address: c.external.ReputationRegistry }), (c) => externalStart(c, "ReputationRegistry")),
    },
    IdentityRegistry: {
      abi: IdentityRegistryAbi,
      chain: on(externalOn, (c) => ({ address: c.external.IdentityRegistry }), (c) => externalStart(c, "IdentityRegistry")),
    },
    // Agent Credit Lines: registered only on chains with a configured lender. None today (R-S189-6: the
    // decoder and its fixtures ship anyway; a source with nothing indexed says "nothing indexed", R-S190-5).
    CreditLine: {
      abi: AgentCreditLineAbi,
      chain: on(
        (c) => externalOn() && c.external.creditLineLenders.length > 0,
        (c) => ({ address: c.external.creditLineLenders }),
        (c) => externalStart(c, "creditLineLenders"),
      ),
    },
  },
});
