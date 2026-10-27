// Event ABIs of the third-party sources, each as written in the vendor's source at the commit named.

import { parseAbi } from "viem";

/** coinbase/spend-permissions src/SpendPermissionManager.sol:132, :138, :147-149 at e0004e63edc4e17de7aa978293800ac7a16892e5. */
export const SpendPermissionManagerAbi = parseAbi([
  "struct SpendPermission { address account; address spender; address token; uint160 allowance; uint48 period; uint48 start; uint48 end; uint256 salt; bytes extraData; }",
  "struct PeriodSpend { uint48 start; uint48 end; uint160 spend; }",
  "event SpendPermissionApproved(bytes32 indexed hash, SpendPermission spendPermission)",
  "event SpendPermissionRevoked(bytes32 indexed hash, SpendPermission spendPermission)",
  "event SpendPermissionUsed(bytes32 indexed hash, address indexed account, address indexed spender, address token, PeriodSpend periodSpend)",
]);

/**
 * priors-agents/erc-agent-credit-lines src/IAgentCreditLine.sol:28, :38, :43. Same file at
 * 1e386460fd18de10a2ae551579f0c290054413c6 (s3 §6.4b (6)) and at main 40a0d5661d9bf8d009d0f1426a55af2893cd56ba.
 */
export const AgentCreditLineAbi = parseAbi([
  "event Borrowed(uint256 indexed loanId, uint256 indexed agentId, address indexed to, uint256 principal, uint256 fee, uint64 dueAt)",
  "event Repaid(uint256 indexed loanId, uint256 indexed agentId, address indexed payer, uint256 principal, uint256 fee)",
  "event Defaulted(uint256 indexed loanId, uint256 indexed agentId, address indexed owner, uint256 principal)",
]);

export const CREDIT_LINE_EVENTS = AgentCreditLineAbi;
