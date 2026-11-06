// R-S205-5: every /read field carrying epoch seconds gains an additive sibling `<field>Utc`, the reader-computed
// ISO-8601 UTC string (YYYY-MM-DDTHH:MM:SSZ), so a consuming client never converts the epoch itself. The raw field
// stays untouched, and an existing key is never overwritten. Applied at response assembly only (src/api/, outside
// Ponder's build id), never to indexed rows.
//
// The epoch-second fields at this commit:
// - vault payments: terms.authorization.envelopeExpiry (the CAM V4 envelope expiry read at the payment block);
// - credit lines: terms.dueAt (Borrowed's uint64 dueAt);
// - Coinbase spend permissions: terms.start and terms.end (SpendPermission's uint48 start and end);
// - decoded MetaMask caveats, wherever they nest: startDate (the period-transfer enforcers), startTime (the
//   streaming enforcers), afterTimestamp and beforeTimestamp (TimestampEnforcer).
// Durations (SpendPermission's period, an enforcer's periodDuration) are not instants and get no sibling.

/** Keys carrying epoch seconds wherever they appear inside a fact's terms. */
export const EPOCH_KEYS = ["envelopeExpiry", "dueAt", "startDate", "startTime", "afterTimestamp", "beforeTimestamp"] as const;
/** Keys carrying epoch seconds only in a Coinbase spend permission's own terms ("start"/"end" are too generic elsewhere). */
export const SPM_EPOCH_KEYS = ["start", "end"] as const;
const SPM_SOURCE = "coinbase:spend_permission";

/** 9999-12-31T23:59:59Z: the last instant YYYY-MM-DDTHH:MM:SSZ can write. */
const MAX_FOUR_DIGIT_YEAR = 253402300799n;

/**
 * Epoch seconds → "YYYY-MM-DDTHH:MM:SSZ". null for a null/absent value, a non-integer, a negative value, or an
 * instant past year 9999 (e.g. SpendPermission's "no end" sentinel 2^48−1): the raw field beside it says it.
 */
export function utcOf(epoch: unknown): string | null {
  let s: bigint;
  if (typeof epoch === "bigint") s = epoch;
  else if (typeof epoch === "number" && Number.isSafeInteger(epoch)) s = BigInt(epoch);
  else if (typeof epoch === "string" && /^\d+$/.test(epoch)) s = BigInt(epoch);
  else return null;
  if (s < 0n || s > MAX_FOUR_DIGIT_YEAR) return null;
  return new Date(Number(s) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function addUtc(node: unknown, keys: ReadonlySet<string>): unknown {
  if (Array.isArray(node)) return node.map((x) => addUtc(x, keys));
  if (node === null || typeof node !== "object") return node;
  const o = node as Record<string, unknown>;
  // A fact nested inside terms (a grounding fact's payment) carries its own source.
  if (typeof o.source === "string" && "terms" in o) return withUtcFact(o);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    out[k] = addUtc(v, keys);
    const sib = `${k}Utc`;
    if (keys.has(k) && !(sib in o)) out[sib] = utcOf(v);
  }
  return out;
}

const BASE_KEYS: ReadonlySet<string> = new Set(EPOCH_KEYS);
const SPM_KEYS: ReadonlySet<string> = new Set([...EPOCH_KEYS, ...SPM_EPOCH_KEYS]);

function withUtcFact(f: Record<string, unknown>): Record<string, unknown> {
  const terms = f.terms;
  if (terms === null || typeof terms !== "object" || Array.isArray(terms)) return f;
  // SPM start/end apply to the permission's own terms object only, not to anything nested below it.
  const top = f.source === SPM_SOURCE ? SPM_KEYS : BASE_KEYS;
  const t = terms as Record<string, unknown>;
  const outTerms: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    outTerms[k] = addUtc(v, BASE_KEYS);
    const sib = `${k}Utc`;
    if (top.has(k) && !(sib in t)) outTerms[sib] = utcOf(v);
  }
  return { ...f, terms: outTerms };
}

/** The facts as served: each fact's terms with a `<field>Utc` sibling beside every epoch-second field. */
export function withUtc<T>(facts: T[]): T[] {
  return facts.map((f) => (f !== null && typeof f === "object" ? (withUtcFact(f as Record<string, unknown>) as T) : f));
}
