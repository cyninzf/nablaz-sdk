// The s3 §6.4b one-liners (R-D2B-1: the ground truth), rendered per chain with the subject substituted.
// Every line of §6.4b at nablaz-protocol 51c1379622ec837375e5d8ddf42b29032990b997 has one renderer here;
// test/unit/oneliners.test.ts renders each with its placeholders and diffs against
// test/fixtures/s3-6.4b-oneliners.txt. The `reproduce` column of the external tables and the `reproduce`
// field of every /read fact come from this module. RPC URLs stay as shell variables, never values.

const RECORD = "0x80E937f9DEf48060308Ee00EC279d8448d4775b0";
const FACTORY = "0x86dbDF2570a8670b866340e9e0A1A4B1FC5508ca";
const SPM = "0xf85210B21cC50302F477BA56686d2019dC9b67Ad";
const DM = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3";
const REPUTATION = "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";
const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const METADATA_SET_TOPIC = "0x2c149ed548c6d2993cd73efe187df6eccabe4538091b33adbd25fafdb8a1468b";
/** cast keccak agentWallet: topic2 of MetadataSet for the wallet key. */
export const AGENT_WALLET_KEY_TOPIC = "0x2ac6109326e720d1435c0db66f7e35eda7839f52b6f1f5520a60788e132b4e39";
const USDC: Record<number, string> = {
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};
/** First Arbitrum block with code at NablaRecord: no NablaZ log is older (§6.4b rules). */
const NABLA_FROM = "516635327";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const CONTROLLER_ROTATED = "0x9ff442701a7d3d6cc2fbf267a38248c62a68a4d4a432a3ee001313c3285ec170";

const RECORD_ENTRY_SIG =
  "RecordEntry(address indexed subject,bytes32 indexed kind,address indexed writer,bytes32 writerAuth,address counterparty,bytes32 counterpartyAuth,bytes32 policyHash,uint32 policyVersion,address asset,uint256 amount,bytes32 amountCommitment,bytes32 obligationRef,bytes32 source,uint64 time,uint64 seq)";
const ACCOUNT_CREATED_SIG = "AccountCreated(bytes32 indexed accountId, address indexed owner, address indexed account, uint256 version)";
const SPM_STRUCT = "(address,address,address,uint160,uint48,uint48,uint48,uint256,bytes)";

export const RPC_VAR: Record<number, string> = { 42161: '"$ARB_ONE_RPC_URL"', 8453: '"$BASE_RPC_URL"' };

const rpc = (chainId: number) => {
  const v = RPC_VAR[chainId];
  if (!v) throw new Error(`no RPC variable for chain ${chainId}`);
  return v;
};
const usdc = (chainId: number) => USDC[chainId] ?? "<USDC>";

/** Placeholders, exactly as §6.4b writes them. Unfilled, bash refuses the line (Lesson #15(b)). */
type V = {
  chainId: number;
  subject?: string;
  vault?: string;
  tx?: string;
  owner?: string;
  account?: string;
  rootDelegator?: string;
  lender?: string;
  agentId?: string;
  from?: string | number | bigint;
};
const f = (v: V) => (v.from === undefined ? "<FROM>" : String(v.from));

const receiptTransfersFrom = (v: V, argName: string, who: string) =>
  `cast receipt ${v.tx ?? "<TX>"} --rpc-url ${rpc(v.chainId)} --json | jq -r --arg ${argName} "$(cast abi-encode 'f(address)' ${who})" '.logs[] | select(.topics[0] == "${TRANSFER_TOPIC}" and .topics[1] == $${argName}) | [.address, .topics[2], .data] | @tsv'`;

const spmByData = (v: V, event: "SpendPermissionApproved" | "SpendPermissionRevoked") =>
  `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${SPM} "${event}(bytes32 indexed hash, ${SPM_STRUCT} spendPermission)" --json | jq --arg a "$(cast abi-encode 'f(address)' ${v.account ?? "<ACCOUNT>"})" '[.[] | select(.data[66:130] == $a[2:])]'`;

const creditLine = (v: V, sig: string) =>
  `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${v.lender ?? "<LENDER>"} "${sig}" "" ${v.agentId ?? "<AGENT_ID>"}`;

/** One renderer per §6.4b command line, in section order. Keys name the line: (section)-(what). */
export const ONELINERS = {
  "1-record-entries": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${NABLA_FROM} --address ${RECORD} "${RECORD_ENTRY_SIG}" ${v.subject ?? "<SUBJECT>"}`,
  "2-authorization-used": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${NABLA_FROM} --address ${usdc(v.chainId)} "AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)" ${v.vault ?? "<VAULT>"}`,
  "2-vault-transfer": (v: V) => receiptTransfersFrom(v, "v", v.vault ?? "<VAULT>"),
  "3-account-created-by-owner": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${NABLA_FROM} --address ${FACTORY} "${ACCOUNT_CREATED_SIG}" "" ${v.owner ?? "<OWNER>"}`,
  "4-spm-used": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${SPM} "SpendPermissionUsed(bytes32 indexed hash, address indexed account, address indexed spender, address token, (uint48,uint48,uint160) periodSpend)" "" ${v.account ?? "<ACCOUNT>"}`,
  "4-spm-approved": (v: V) => spmByData(v, "SpendPermissionApproved"),
  "4-spm-revoked": (v: V) => spmByData(v, "SpendPermissionRevoked"),
  "5-redeemed-delegation": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${DM} "RedeemedDelegation(address indexed rootDelegator, address indexed redeemer, (address,address,bytes32,(address,bytes,bytes)[],uint256,bytes) delegation)" ${v.rootDelegator ?? "<ROOT_DELEGATOR>"}`,
  "5-delegator-transfer": (v: V) => receiptTransfersFrom(v, "d", v.rootDelegator ?? "<ROOT_DELEGATOR>"),
  "6-borrowed": (v: V) =>
    creditLine(v, "Borrowed(uint256 indexed loanId, uint256 indexed agentId, address indexed to, uint256 principal, uint256 fee, uint64 dueAt)"),
  "6-repaid": (v: V) =>
    creditLine(v, "Repaid(uint256 indexed loanId, uint256 indexed agentId, address indexed payer, uint256 principal, uint256 fee)"),
  "6-defaulted": (v: V) =>
    creditLine(v, "Defaulted(uint256 indexed loanId, uint256 indexed agentId, address indexed owner, uint256 principal)"),
  "7-new-feedback": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${REPUTATION} "NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)" ${v.agentId ?? "<AGENT_ID>"}`,
  "8-controller-rotated-by-self": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${NABLA_FROM} --address ${RECORD} "${RECORD_ENTRY_SIG}" ${v.account ?? "<ACCOUNT>"} ${CONTROLLER_ROTATED} ${v.account ?? "<ACCOUNT>"}`,
  "8-account-created-by-account": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${NABLA_FROM} --address ${FACTORY} "${ACCOUNT_CREATED_SIG}" "" "" ${v.account ?? "<ACCOUNT>"}`,
  "9-identity-registered": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${IDENTITY} "Registered(uint256 indexed agentId, string agentURI, address indexed owner)" ${v.agentId ?? "<AGENT_ID>"}`,
  "10-agentwallet-history": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${IDENTITY} ${METADATA_SET_TOPIC} "$(cast to-uint256 ${v.agentId ?? "<AGENT_ID>"})" ${AGENT_WALLET_KEY_TOPIC} --json | jq -r '.[].data' | while read -r d; do cast abi-decode --input 'f(string,bytes)' "$d" | tail -1; done`,
  "11-identity-transfers": (v: V) =>
    `cast logs --rpc-url ${rpc(v.chainId)} --from-block ${f(v)} --address ${IDENTITY} "Transfer(address indexed from, address indexed to, uint256 indexed tokenId)" "" "" ${v.agentId ?? "<AGENT_ID>"}`,
} as const;

export type OnelinerId = keyof typeof ONELINERS;

export function render(id: OnelinerId, v: V): string {
  return ONELINERS[id](v);
}

/** The chain each §6.4b line is written for, as the section prints it (the test renders with this chain). */
export const AS_PRINTED_CHAIN: Record<OnelinerId, number> = {
  "1-record-entries": 42161,
  "2-authorization-used": 42161,
  "2-vault-transfer": 42161,
  "3-account-created-by-owner": 42161,
  "4-spm-used": 8453,
  "4-spm-approved": 8453,
  "4-spm-revoked": 8453,
  "5-redeemed-delegation": 42161,
  "5-delegator-transfer": 42161,
  "6-borrowed": 42161,
  "6-repaid": 42161,
  "6-defaulted": 42161,
  "7-new-feedback": 8453,
  "8-controller-rotated-by-self": 42161,
  "8-account-created-by-account": 42161,
  "9-identity-registered": 42161,
  "10-agentwallet-history": 42161,
  "11-identity-transfers": 42161,
};
