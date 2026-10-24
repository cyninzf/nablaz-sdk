import { createConfig, factory } from "ponder";
import { getAbiItem, parseAbi } from "viem";
import { enabledChains } from "./src/chains";
import { AccountRegistryV6Abi, NablaAccountFactoryPermanentAbi, NablaRecordAbi } from "@nablaz/sdk/abis";

// Every source is parameterized by chain (src/chains.ts). Only enabled chains are configured.
// Optional overrides, used by the tests: READER_START_BLOCK, READER_END_BLOCK, READER_PGLITE_DIR.

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

function perChain<T>(build: (c: (typeof chainsOn)[number]) => T) {
  return Object.fromEntries(
    chainsOn.map((c) => [
      c.name,
      { ...build(c), startBlock: startOverride ?? c.startBlock, ...(endOverride ? { endBlock: endOverride } : {}) },
    ]),
  );
}

export default createConfig({
  ordering: "omnichain",
  database: { kind: "pglite", directory: process.env.READER_PGLITE_DIR ?? ".ponder/pglite" },
  chains: Object.fromEntries(
    chainsOn.map((c) => [c.name, { id: c.chainId, rpc: process.env[c.rpcEnv] }]),
  ),
  contracts: {
    NablaRecord: {
      abi: NablaRecordAbi,
      chain: perChain((c) => ({ address: c.contracts.NablaRecord })),
    },
    AccountFactory: {
      abi: NablaAccountFactoryPermanentAbi,
      chain: perChain((c) => ({ address: c.contracts.NablaAccountFactoryPermanent })),
    },
    AccountRegistry: {
      abi: AccountRegistryV6Abi,
      chain: perChain((c) => ({ address: c.contracts.AccountRegistryV6 })),
    },
    // ERC-1967 Upgraded on every account proxy, discovered from either AccountCreated.
    AccountProxyViaFactory: {
      abi: UpgradedAbi,
      chain: perChain((c) => ({
        address: factory({
          address: c.contracts.NablaAccountFactoryPermanent,
          event: factoryCreated,
          parameter: "account",
        }),
      })),
    },
    AccountProxyViaRegistry: {
      abi: UpgradedAbi,
      chain: perChain((c) => ({
        address: factory({ address: c.contracts.AccountRegistryV6, event: registryCreated, parameter: "account" }),
      })),
    },
    // USDC AuthorizationUsed, all authorizers; the handler keeps only vaults discovered from
    // PAY_AUTHORIZED. A vault is never the emitter, so a Ponder factory cannot narrow this filter.
    Usdc: {
      abi: UsdcAbi,
      chain: perChain((c) => ({ address: c.usdc })),
    },
  },
});
