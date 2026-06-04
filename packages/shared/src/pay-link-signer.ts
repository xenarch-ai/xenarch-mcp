// Client-side `signed_params` for pay-link creation (viem).
//
// Implements Information/design/signed-params-spec.md, matching the platform
// reference (xenarch-platform/app/services/signed_params.py) byte-for-byte.
// Mirrors the CLI's ethers implementation; here we use viem because that's the
// MCP's signing stack (see payment.ts / config.ts).
//
// Canonicalization caveat: the platform's `canonical_json` is a JCS *subset*
// (Python json.dumps with sorted keys, compact separators, ensure_ascii=False),
// NOT full RFC-8785. The server recomputes templateHash from the SAME `params`
// we POST, so this just has to match Python's bytes for that object — keep every
// `params` value STRING-valued (amount is a string per the spec).

import { keccak256, stringToBytes, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";

const DOMAIN = {
  name: "Xenarch Pay Links",
  version: "1",
  chainId: 8453,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex,
} as const;

const PAY_LINK_TYPES = {
  PayLink: [
    { name: "to", type: "address" },
    { name: "amount", type: "string" },
    { name: "currency", type: "string" },
    { name: "network", type: "string" },
    { name: "kind", type: "string" },
    { name: "templateHash", type: "bytes32" },
    { name: "createdAt", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Compare strings by Unicode code point — Python `sort_keys` order (JS's
 * default `.sort()` orders by UTF-16 code unit, diverging on astral keys). */
function compareByCodePoint(a: string, b: string): number {
  const aa = Array.from(a);
  const bb = Array.from(b);
  const n = Math.min(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    const ca = aa[i].codePointAt(0)!;
    const cb = bb[i].codePointAt(0)!;
    if (ca !== cb) return ca - cb;
  }
  return aa.length - bb.length;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    const src = value as Record<string, unknown>;
    for (const key of Object.keys(src).sort(compareByCodePoint))
      out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/** Recursively coerce JS numbers to strings so canonical JSON matches Python
 * (1.0→"1" vs "1.0", exponents, precision diverge between JSON.stringify and
 * json.dumps). The spec mandates string-valued params; bools/null are identical
 * in both encoders and pass through. */
export function stringifyNumbers(value: unknown): unknown {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(stringifyNumbers);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stringifyNumbers(v);
    }
    return out;
  }
  return value;
}

/** JCS-subset canonical JSON (see file header for the parity caveat). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeTemplateHash(params: Record<string, unknown>): Hex {
  return keccak256(stringToBytes(canonicalJson(params)));
}

export interface PayLinkLit {
  to: string;
  amount: string;
  currency: string;
  network: string;
  kind: string;
}

export interface SignedPayLink {
  signed_params: string;
  nonce: string;
  created_at: number;
}

/**
 * Sign a pay-link template with the local agent key. The recovered signer must
 * equal the SIWE session wallet (created_by), else the platform rejects the
 * create with 403 — the MCP signs with config.privateKey, so the session must
 * belong to that same wallet.
 */
export async function signPayLink(
  privateKey: string,
  params: Record<string, unknown>,
  lit: PayLinkLit,
): Promise<SignedPayLink> {
  if (lit.network !== "base") {
    throw new Error(`Unsupported network for signing: ${lit.network} (only "base" at MVP).`);
  }
  const account = privateKeyToAccount(privateKey as Hex);
  const templateHash = computeTemplateHash(params);
  const nonce = ("0x" + randomBytes(32).toString("hex")) as Hex;
  const createdAt = Math.floor(Date.now() / 1000);

  const signed_params = await account.signTypedData({
    domain: DOMAIN,
    types: PAY_LINK_TYPES,
    primaryType: "PayLink",
    message: {
      to: getAddress(lit.to),
      amount: lit.amount,
      currency: lit.currency,
      network: lit.network,
      kind: lit.kind,
      templateHash,
      createdAt: BigInt(createdAt),
      nonce,
    },
  });
  return { signed_params, nonce, created_at: createdAt };
}
