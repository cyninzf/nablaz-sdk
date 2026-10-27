// ERC-8004 sources (R-D2B-2): addresses and ABI items come from the vendor at the pinned commit, never retyped.

import { describe, expect, it } from "vitest";
import { formatAbiItem } from "viem/utils";
import type { AbiEvent, AbiFunction } from "viem";
import erc8004 from "../../src/generated/erc8004.json" with { type: "json" };
import { CHAINS } from "../../src/chains";
import { IdentityRegistryAbi, ReputationRegistryAbi } from "../../src/external-abis";

const VENDOR = "b9e466c250744a7e06b13dff9d3c2844ed64f825";
const SECTION = { 42161: "#### Arbitrum Mainnet", 8453: "#### Base Mainnet" } as const;

describe("ERC-8004 registries", () => {
  it("are pinned to the vendor commit the nablaz-protocol files cite", () => {
    expect(erc8004.source.vendor.commit).toBe(VENDOR);
    expect(erc8004.source.addresses.commit).toBe("51c1379622ec837375e5d8ddf42b29032990b997");
  });

  it("every address is in its chain's section of the vendor README at the pinned commit", async () => {
    const r = await fetch(`https://raw.githubusercontent.com/erc-8004/erc-8004-contracts/${VENDOR}/README.md`);
    expect(r.ok).toBe(true);
    const md = await r.text();
    for (const [chainId, heading] of Object.entries(SECTION)) {
      const at = md.indexOf(`${heading}\n`);
      expect(at, heading).toBeGreaterThanOrEqual(0);
      const section = md.slice(at, md.indexOf("\n####", at + 1));
      const want = (erc8004.chains as Record<string, Record<string, string>>)[chainId]!;
      for (const [name, address] of Object.entries(want)) expect(section).toContain(`**${name}**: [\`${address}\`]`);
      expect(CHAINS[Number(chainId)]!.external.IdentityRegistry).toBe(want.IdentityRegistry);
      expect(CHAINS[Number(chainId)]!.external.ReputationRegistry).toBe(want.ReputationRegistry);
    }
  }, 60_000);

  it("the reader's ABI items equal the vendor's abis/*.json items", () => {
    const vendor = (contract: string, name: string) => {
      const { contract: _, ...item } = (erc8004.abi as { contract: string; name: string }[]).find((x) => x.contract === contract && x.name === name)!;
      return formatAbiItem(item as unknown as AbiEvent | AbiFunction);
    };
    const mine = (abi: readonly unknown[], name: string) => formatAbiItem(abi.find((x) => (x as { name: string }).name === name) as AbiEvent | AbiFunction);
    expect(mine(ReputationRegistryAbi, "NewFeedback")).toBe(vendor("ReputationRegistry", "NewFeedback"));
    expect(mine(IdentityRegistryAbi, "MetadataSet")).toBe(vendor("IdentityRegistry", "MetadataSet"));
    expect(mine(IdentityRegistryAbi, "getAgentWallet")).toBe(vendor("IdentityRegistry", "getAgentWallet"));
    expect(mine(IdentityRegistryAbi, "Transfer")).toBe(vendor("IdentityRegistry", "Transfer"));
    expect(mine(IdentityRegistryAbi, "ownerOf")).toBe(vendor("IdentityRegistry", "ownerOf"));
  });

  it("start blocks are each registry's first block with code (no block is published by the vendor)", () => {
    expect(CHAINS[42161]!.external.startBlocks).toMatchObject({ ReputationRegistry: 428895450, IdentityRegistry: 428895443 });
    expect(CHAINS[8453]!.external.startBlocks).toMatchObject({ ReputationRegistry: 41663784, IdentityRegistry: 41663783 });
  });
});
