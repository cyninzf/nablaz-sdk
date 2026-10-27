// The banned-word guard (R-S189-2 relay, R-S190-7). NablaZ's own descriptions never use these words. A quoted
// contract name passes only through the exact-name allowlist: the exact, case-sensitive name is removed before
// matching, so a bare "reputation" or "trust" anywhere else still fails.

export const BANNED = /score|verdict|rank|trust|reputation|credit bureau/i;

/** R-S190-7: exact contract names, starting with ERC-8004's "Reputation Registry" only. */
export const ALLOWED_NAMES = ["Reputation Registry"] as const;

/** Every banned match left after removing the exact allowlisted names. */
export function bannedHits(text: string): string[] {
  let rest = text;
  for (const name of ALLOWED_NAMES) rest = rest.split(name).join(" ");
  return [...rest.matchAll(new RegExp(BANNED.source, "gi"))].map((m) => m[0]);
}
