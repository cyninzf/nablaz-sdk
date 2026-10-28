// Writes test/fixtures/delegations.json and test/fixtures/spm-logs.json: the raw logs (topics, data) of the
// step-0 redemptions and spend-permission logs listed below, plus each redemption tx's ERC-20 Transfer
// logs, read from chain. The unit tests decode these offline and assert shape and label for every one.
//
//   node --experimental-strip-types scripts/gen-fixtures.ts
//
// Needs READER_ARBITRUM_RPC_URL and READER_BASE_RPC_URL (never printed).

import { writeFileSync } from "node:fs";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";

const DM = "0xdb9b1e94b5b69df7e401ddbede43491141047db3";
const SPM = "0xf85210b21cc50302f477ba56686d2019dc9b67ad";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type Ref = [chainId: 42161 | 8453, tx: Hex, logIndex: number];

// The 24 P0-3 redemptions (docs/reader/b4-part1.md), the Base multi-hop tx (both hops, leaf then root) and
// the worked (c) example (an enforcer in no vendor list).
const REDEMPTIONS: Ref[] = [
  [42161, "0xe6dd7f54c89a1b70c802d4456fa0a2a0e9a8ffef74e3fd8244c6edb6dbbc1478", 3],
  [42161, "0xab20e32de61fc21a21eb9dfe57f2b17b32746e2d676f59f76cbea17c511e94aa", 20],
  [42161, "0xdd34cb012aacf38320894bc3ed38ee27bf35ef1de292d5cfa9b86fd8f8cebd73", 6],
  [42161, "0x9dfe64c035638a82ac420df80b5d850694e88c68eabb26d357e2d18038b776c6", 4],
  [42161, "0x57a7d9b807292fa56976763aabcde30e0b97c414b44806d4f729c1d472436479", 15],
  [42161, "0x9c38d30ac358c627c922a8f40ecf661f05cb3b6a571b1b7cad352e435cf86e43", 9],
  [42161, "0xffc1006c54adce8526816e6673297719e8f047d8b956c3306ff09f447937da39", 5],
  [42161, "0xec9c7fb6f5d47cdaae7cacdab0c795e8c004350e1e2062c4078808fa6320bd19", 8],
  [42161, "0xeb4582e7bb0d55a45cc704c8ba86f8bb066cbc045901a7ab282b00c11cff8614", 7],
  [42161, "0x8fc88f69586f6f6853f03c6eea674cf8abba27d9590d807c7b72428dd40c5906", 2],
  [42161, "0xc7cca23a01e0d5082872409e0445b535309e4cc06546e0290f34bcc21031285a", 8],
  [42161, "0xe75b7e7146ea4da3c93e662c8214120191b15576a7c7a8efdcae74625be92cf9", 7],
  [8453, "0x7a940f6d9bd84edd5d5909b829096d2d7b6f94d2da9a54520e1e7923a54ed063", 237],
  [8453, "0x219d9d6572b34d525f3c142e605baa302c34689e17a22a23c072ff89c0459782", 311],
  [8453, "0xe25d05788d4c05fcf500a84b60298e2ee2de99981fa6a7447254da8b48de41da", 469],
  [8453, "0x93774af1f00d8a2f4d7511589f4147c2628f088bc38dd5520c1f3065ebb55dc2", 660],
  [8453, "0x19c3dfe9edf7eae156f26c936a059a535bcac1e8625c7195229b3927754e8e84", 113],
  [8453, "0x9f839882543833cdb31a4caf7114fbc7776294e28702ce7ad7920f9e00d38e84", 289],
  [8453, "0x8933f1ed90df4969103392bf84e14d47c99f979edc3197e7f0c424c1fcc2e643", 747],
  [8453, "0xf1a66ed187c2792b26ac5519831dd225bef2773731a78b8d7c18a7d6f80cf26f", 118],
  [8453, "0x7e9887131cc9db2e54061dbc88e83d11db41b6c6919950ad0da81ef426d20068", 229],
  [8453, "0x6f4596d1c1ba8f8928b576fb07ed9350f86b18d3b8d61d724162b2fecdcb44e9", 439],
  [8453, "0x5665950ff828dc79a6a7ab52f0203f48f360b6438de181b8ec51e71f7bcd1b46", 652],
  [8453, "0xde725607cea8edb0cffc561a5ed908986e1e0a4849523355c2e2b5db79135e71", 274],
  [8453, "0xcc399fad3554f9c7e42f465124c8114b42a420140647b178c03ae3217a22562e", 352],
  [8453, "0xcc399fad3554f9c7e42f465124c8114b42a420140647b178c03ae3217a22562e", 353],
  [8453, "0xe2f861045f44fd86e15ca9d39656c1a8a714570bcd8214efd896a9d76bc9773a", 516],
];

// Six SpendPermissionApproved and two SpendPermissionRevoked from P0-4.
const SPM_LOGS: Ref[] = [
  [42161, "0x5b69ffb5c3dded174def2ff02488a65fb405b3c7cd87fbd1fce2f35c2cbdbfcf", 3],
  [42161, "0x0deb1d1c7e9b79922316a7d2a08a22e1014d7c7db0c52cbf65586fb01d56e31a", 2],
  [42161, "0x301f8a25eca51f1d59edea57f779b24e240a25520cb70dcb2e88c17624633dec", 11],
  [8453, "0x3d8b59313b347595dd522a5e812f597be05ba6d91c35874ee402dcda75eae586", 516],
  [8453, "0xd3fee338f066209f143f81038bb15549a56391ead9c6b5e0377c035f125dfcb0", 972],
  [8453, "0x189e4427b3ad1c59f8bff67f834dea9d363b606a88963f9f93a9e870e3e60713", 9],
  [42161, "0x65a049949acb08aed6f55d72aeb9fa153eedcbfcae32176d7f1e86d61e3f0d2b", 16],
  [8453, "0x3c30ad5056be6020a4b397805e3a092e7e2b054cbb766ee3d8121d999c11e821", 225],
];

const clients: Record<number, PublicClient> = {
  42161: createPublicClient({ transport: http(process.env.READER_ARBITRUM_RPC_URL!, { retryCount: 5 }) }) as PublicClient,
  8453: createPublicClient({ transport: http(process.env.READER_BASE_RPC_URL!, { retryCount: 5 }) }) as PublicClient,
};

const raw = (l: { address: string; topics: readonly Hex[]; data: Hex; logIndex: number }) => ({
  address: l.address.toLowerCase(),
  topics: [...l.topics],
  data: l.data,
  logIndex: l.logIndex,
});

async function pick([chainId, tx, logIndex]: Ref, emitter: string) {
  const r = await clients[chainId]!.getTransactionReceipt({ hash: tx });
  const log = r.logs.find((l) => l.logIndex === logIndex);
  if (!log || log.address.toLowerCase() !== emitter) throw new Error(`${chainId} ${tx}:${logIndex} is not a log of ${emitter}`);
  return { chainId, block: r.blockNumber.toString(), tx, log: raw(log as any), receipt: r };
}

const delegations = [];
for (const ref of REDEMPTIONS) {
  const p = await pick(ref, DM);
  delegations.push({
    chainId: p.chainId,
    block: p.block,
    tx: p.tx,
    log: p.log,
    // Every log needed to replay the payment rule offline: the tx's redemptions and its ERC-20 Transfers.
    txLogs: p.receipt.logs
      .filter((l) => (l.address.toLowerCase() === DM && l.topics[0] === p.log.topics[0]) || l.topics[0] === TRANSFER)
      .map((l) => raw(l as any)),
  });
}
const spm = [];
for (const ref of SPM_LOGS) {
  const p = await pick(ref, SPM);
  spm.push({ chainId: p.chainId, block: p.block, tx: p.tx, log: p.log });
}

const header = "Generated by scripts/gen-fixtures.ts from Arbitrum One and Base on Oct 27 2026.";
writeFileSync(new URL("../test/fixtures/delegations.json", import.meta.url), `${JSON.stringify({ header, delegations }, null, 1)}\n`);
writeFileSync(new URL("../test/fixtures/spm-logs.json", import.meta.url), `${JSON.stringify({ header, logs: spm }, null, 1)}\n`);
console.log(`${delegations.length} delegations, ${spm.length} spm logs`);
