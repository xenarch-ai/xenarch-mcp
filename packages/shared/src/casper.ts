/**
 * Casper settlement seam for x402 (XEN-500).
 *
 * Xenarch settles today against EIP-3009 USDC on Base (see payment.ts). This
 * module adds a second settlement provider — Casper — behind the exact same
 * shape: pick an `accepts` entry, build a signed x402 envelope, POST it to a
 * facilitator's `/settle`, return `{ txHash, facilitator }`.
 *
 * Deliberate constraints:
 *   - Zero new dependencies. Plain `fetch` + `node:crypto`, matching the rest
 *     of @xenarch/core (payment.ts already hand-rolls its settle POST).
 *   - Opt-in. Nothing here runs unless a gate advertises an `accepts` entry on
 *     a `casper:*` network. Existing Base/USDC gates take a byte-identical path
 *     to before.
 *   - Exact integer math. wCSPR is a CEP-18 token with 9 decimals (motes).
 *     Sub-mote precision throws `CasperAmountPrecisionError` — we never
 *     truncate and never touch floats.
 *   - Fail closed. Any facilitator ambiguity (non-2xx, unreachable host,
 *     unparseable body, missing or non-`true` verdict) is a verification
 *     FAILURE, never a pass.
 */

import { randomBytes } from "node:crypto";
import type { GateResponse, PaymentRequirements } from "./types.js";

// --- Networks -------------------------------------------------------------

/** Casper mainnet, in x402 CAIP-ish network-id form. */
export const CASPER_MAINNET = "casper:casper";

/** Casper testnet. */
export const CASPER_TESTNET = "casper:casper-test";

export const CASPER_NETWORKS = [CASPER_MAINNET, CASPER_TESTNET] as const;

export type CasperNetwork = (typeof CASPER_NETWORKS)[number];

/** wCSPR is a CEP-18 token with 9 decimals. 1 CSPR = 1_000_000_000 motes. */
export const CSPR_DECIMALS = 9;

const MOTES_PER_CSPR = 10n ** BigInt(CSPR_DECIMALS);

/** Default public facilitator. Override with XENARCH_CASPER_FACILITATOR_URL. */
export const DEFAULT_CASPER_FACILITATOR_URL =
  "https://x402-facilitator.cspr.cloud";

const FACILITATOR_TIMEOUT_MS = 30_000;

/**
 * True iff `network` is a Casper x402 network id. Anything else — including
 * `base`, `base-sepolia`, `undefined` and stray casing — is false, so the
 * Base path is never diverted.
 */
export function isCasperNetwork(
  network: string | undefined | null,
): network is CasperNetwork {
  if (typeof network !== "string") return false;
  return (CASPER_NETWORKS as readonly string[]).includes(network);
}

/**
 * Resolve the facilitator base URL. Env var wins, then the gate's own
 * facilitator list is used by the caller; this is the fallback default.
 * Mirrors the XENARCH_* env convention in config.ts.
 */
export function casperFacilitatorUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.XENARCH_CASPER_FACILITATOR_URL;
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim().replace(/\/+$/, "");
  }
  return DEFAULT_CASPER_FACILITATOR_URL;
}

// --- Error taxonomy -------------------------------------------------------

/** Base class so callers can `instanceof` the whole Casper family at once. */
export class CasperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CasperError";
  }
}

/**
 * A CSPR amount could not be represented exactly in motes. Thrown rather than
 * rounded — silently truncating a payment amount is a correctness bug, not a
 * warning.
 */
export class CasperAmountPrecisionError extends CasperError {
  readonly value: string;
  constructor(value: string, detail: string) {
    super(
      `Cannot represent "${value}" exactly in motes (wCSPR has ${CSPR_DECIMALS} decimals): ${detail}`,
    );
    this.name = "CasperAmountPrecisionError";
    this.value = value;
  }
}

/** A gate's Casper `accepts` entry was missing required fields. */
export class CasperConfigurationError extends CasperError {
  constructor(message: string) {
    super(message);
    this.name = "CasperConfigurationError";
  }
}

/** The facilitator did not affirmatively settle/verify. Always fail-closed. */
export class CasperFacilitatorError extends CasperError {
  readonly facilitator: string;
  readonly status?: number;
  constructor(facilitator: string, message: string, status?: number) {
    super(`Casper facilitator ${facilitator}: ${message}`);
    this.name = "CasperFacilitatorError";
    this.facilitator = facilitator;
    this.status = status;
  }
}

// --- Exact mote math ------------------------------------------------------

const DECIMAL_RE = /^-?\d*(?:\.\d*)?$/;

/**
 * Convert a decimal CSPR string to an exact integer mote amount.
 *
 * `"1"` -> 1000000000n, `"0.000000001"` -> 1n. Anything finer than one mote
 * (`"0.0000000001"`) throws `CasperAmountPrecisionError`. Numbers are rejected
 * outright at the type level — callers must pass strings so we never inherit
 * IEEE-754 rounding.
 */
export function csprToMotes(value: string): bigint {
  if (typeof value !== "string") {
    throw new CasperAmountPrecisionError(
      String(value),
      "amount must be a decimal string, not a number (floats lose precision)",
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !DECIMAL_RE.test(trimmed)) {
    throw new CasperAmountPrecisionError(value, "not a plain decimal string");
  }
  if (trimmed.startsWith("-")) {
    throw new CasperAmountPrecisionError(value, "amount must not be negative");
  }

  const [whole = "", fraction = ""] = trimmed.split(".");
  if (whole.length === 0 && fraction.length === 0) {
    throw new CasperAmountPrecisionError(value, "no digits");
  }
  if (fraction.length > CSPR_DECIMALS) {
    // Only reject when the excess digits actually carry value; "1.0000000000"
    // is exactly 1 CSPR and must not be a hard error.
    const excess = fraction.slice(CSPR_DECIMALS);
    if (/[^0]/.test(excess)) {
      throw new CasperAmountPrecisionError(
        value,
        `sub-mote precision (${fraction.length} fractional digits, max ${CSPR_DECIMALS})`,
      );
    }
  }
  const padded = fraction.padEnd(CSPR_DECIMALS, "0").slice(0, CSPR_DECIMALS);
  return BigInt(whole || "0") * MOTES_PER_CSPR + BigInt(padded || "0");
}

/** Inverse of `csprToMotes`. Exact; no floats. Trailing zeros trimmed. */
export function motesToCspr(motes: bigint): string {
  if (motes < 0n) {
    throw new CasperAmountPrecisionError(
      motes.toString(),
      "amount must not be negative",
    );
  }
  const whole = motes / MOTES_PER_CSPR;
  const fraction = (motes % MOTES_PER_CSPR)
    .toString()
    .padStart(CSPR_DECIMALS, "0")
    .replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Parse a base-unit (mote) string as it appears in an x402
 * `maxAmountRequired`. Rejects decimals — base units are integers by
 * definition, and a `"1.5"` here means the gate is malformed, not that we
 * should round.
 */
export function parseMoteAmount(raw: string): bigint {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw new CasperAmountPrecisionError(
      String(raw),
      "maxAmountRequired must be an integer number of motes",
    );
  }
  return BigInt(raw.trim());
}

// --- x402 v2 payload ------------------------------------------------------

export interface CasperAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface CasperPaymentPayload {
  x402Version: 2;
  scheme: "exact";
  network: CasperNetwork;
  payload: {
    signature: string;
    authorization: CasperAuthorization;
  };
}

export interface BuildCasperPayloadArgs {
  accept: Pick<
    PaymentRequirements,
    "scheme" | "network" | "payTo" | "asset" | "maxAmountRequired"
  >;
  /** Payer public key (hex-encoded Casper account public key). */
  from: string;
  /** Detached signature over the authorization, hex-encoded. */
  signature: string;
  /** Seconds the authorization stays valid. */
  validitySeconds?: number;
  /** Injectable for deterministic tests. */
  now?: () => number;
  /** Injectable for deterministic tests. */
  nonce?: string;
}

const DEFAULT_VALIDITY_SECONDS = 600;

/** 32 random bytes, hex-encoded — same shape as the Base path's nonce. */
export function casperNonce(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

/**
 * Build the x402 v2 `exact`-scheme payload for a Casper wCSPR transfer.
 * Validates the `accepts` entry fully before producing anything.
 */
export function buildCasperPaymentPayload(
  args: BuildCasperPayloadArgs,
): CasperPaymentPayload {
  const { accept, from, signature } = args;

  if (accept.scheme !== "exact") {
    throw new CasperConfigurationError(
      `Unsupported Casper scheme "${accept.scheme}" (only "exact" is implemented).`,
    );
  }
  if (!isCasperNetwork(accept.network)) {
    throw new CasperConfigurationError(
      `Not a Casper network: "${accept.network}". Expected one of ${CASPER_NETWORKS.join(", ")}.`,
    );
  }
  if (!accept.payTo) {
    throw new CasperConfigurationError(
      "Casper accepts entry is missing `payTo`.",
    );
  }
  if (!accept.asset) {
    throw new CasperConfigurationError(
      "Casper accepts entry is missing `asset` (expected the wCSPR CEP-18 contract hash).",
    );
  }
  if (!from) {
    throw new CasperConfigurationError("Missing payer public key.");
  }
  if (!signature) {
    throw new CasperConfigurationError("Missing authorization signature.");
  }

  // Throws on a malformed / non-integer amount rather than coercing.
  const value = parseMoteAmount(accept.maxAmountRequired);
  if (value <= 0n) {
    throw new CasperConfigurationError(
      "Casper accepts entry has a non-positive `maxAmountRequired`.",
    );
  }

  const nowSeconds = Math.floor((args.now?.() ?? Date.now()) / 1000);
  const validity = args.validitySeconds ?? DEFAULT_VALIDITY_SECONDS;

  return {
    x402Version: 2,
    scheme: "exact",
    network: accept.network,
    payload: {
      signature,
      authorization: {
        from,
        to: accept.payTo,
        value: value.toString(),
        validAfter: "0",
        validBefore: String(nowSeconds + validity),
        nonce: args.nonce ?? casperNonce(),
      },
    },
  };
}

/**
 * Pick the Casper `accepts` entry to settle against. Prefers an exact match on
 * the gate's own network, then any Casper network. Returns null when the gate
 * advertises no Casper option at all — which is the normal case for today's
 * Base gates and is what keeps this feature opt-in.
 */
export function selectCasperAccept(
  accepts: PaymentRequirements[] | undefined,
  preferredNetwork?: string,
): PaymentRequirements | null {
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const casperAccepts = accepts.filter(
    (a) => a.scheme === "exact" && isCasperNetwork(a.network),
  );
  if (casperAccepts.length === 0) return null;
  if (isCasperNetwork(preferredNetwork)) {
    const exact = casperAccepts.find((a) => a.network === preferredNetwork);
    if (exact) return exact;
  }
  return casperAccepts[0] ?? null;
}

/**
 * True iff this gate can be settled on Casper. Used as the branch condition in
 * the payment path so that a gate without Casper `accepts` never enters this
 * module.
 */
export function gateSupportsCasper(gate: Pick<GateResponse, "accepts">): boolean {
  return selectCasperAccept(gate.accepts) !== null;
}

// --- Fail-closed facilitator client --------------------------------------

export interface CasperVerifyResult {
  isValid: true;
  payer?: string;
}

export interface CasperSettleResult {
  success: true;
  transaction: string;
  network: CasperNetwork;
  payer?: string;
}

interface FacilitatorPost {
  ok: boolean;
  status: number;
  body: Record<string, unknown> | null;
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<FacilitatorPost> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

export interface CasperFacilitatorClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Thin client for the Casper x402 facilitator (`/verify`, `/settle`,
 * `/supported`).
 *
 * Every method fails CLOSED: a transport error, a non-2xx status, a body that
 * isn't JSON, or a body whose verdict field is absent or anything other than
 * literal `true` all raise `CasperFacilitatorError`. There is no code path
 * where an ambiguous response is treated as a pass.
 */
export class CasperFacilitatorClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CasperFacilitatorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? casperFacilitatorUrl()).replace(
      /\/+$/,
      "",
    );
    this.timeoutMs = options.timeoutMs ?? FACILITATOR_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<FacilitatorPost> {
    try {
      return await postJson(
        `${this.baseUrl}${path}`,
        body,
        this.timeoutMs,
        this.fetchImpl,
      );
    } catch (err) {
      // Unreachable host, DNS failure, TLS error, abort/timeout — all failures.
      throw new CasperFacilitatorError(
        this.baseUrl,
        `unreachable (${(err as Error)?.message ?? "transport error"})`,
      );
    }
  }

  /** Verify a payment payload. Throws unless `isValid === true`. */
  async verify(
    paymentPayload: CasperPaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<CasperVerifyResult> {
    const res = await this.post("/verify", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
    if (!res.ok) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        `/verify returned HTTP ${res.status}`,
        res.status,
      );
    }
    if (res.body === null) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        "/verify returned an unparseable body",
        res.status,
      );
    }
    if (res.body.isValid !== true) {
      const reason =
        typeof res.body.invalidReason === "string"
          ? res.body.invalidReason
          : "verdict missing or not true";
      throw new CasperFacilitatorError(
        this.baseUrl,
        `/verify rejected the payment (${reason})`,
        res.status,
      );
    }
    return {
      isValid: true,
      payer: typeof res.body.payer === "string" ? res.body.payer : undefined,
    };
  }

  /** Settle a payment payload. Throws unless a tx hash comes back. */
  async settle(
    paymentPayload: CasperPaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<CasperSettleResult> {
    const res = await this.post("/settle", {
      x402Version: 2,
      paymentPayload,
      paymentRequirements,
    });
    if (!res.ok) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        `/settle returned HTTP ${res.status}`,
        res.status,
      );
    }
    if (res.body === null) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        "/settle returned an unparseable body",
        res.status,
      );
    }
    if (res.body.success !== true) {
      const reason =
        typeof res.body.errorReason === "string"
          ? res.body.errorReason
          : "success missing or not true";
      throw new CasperFacilitatorError(
        this.baseUrl,
        `/settle did not settle (${reason})`,
        res.status,
      );
    }
    const transaction = res.body.transaction;
    if (typeof transaction !== "string" || transaction.length === 0) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        "/settle reported success without a transaction hash",
        res.status,
      );
    }
    return {
      success: true,
      transaction,
      network: paymentPayload.network,
      payer: typeof res.body.payer === "string" ? res.body.payer : undefined,
    };
  }

  /** List the (scheme, network) pairs the facilitator supports. */
  async supported(): Promise<{ scheme: string; network: string }[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/supported`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        `unreachable (${(err as Error)?.message ?? "transport error"})`,
      );
    }
    if (!res.ok) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        `/supported returned HTTP ${res.status}`,
        res.status,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new CasperFacilitatorError(
        this.baseUrl,
        "/supported returned an unparseable body",
        res.status,
      );
    }
    const kinds = (body as { kinds?: unknown })?.kinds;
    if (!Array.isArray(kinds)) {
      throw new CasperFacilitatorError(
        this.baseUrl,
        "/supported returned no `kinds` array",
        res.status,
      );
    }
    return kinds
      .filter(
        (k): k is { scheme: string; network: string } =>
          typeof (k as { scheme?: unknown })?.scheme === "string" &&
          typeof (k as { network?: unknown })?.network === "string",
      )
      .map((k) => ({ scheme: k.scheme, network: k.network }));
  }
}
