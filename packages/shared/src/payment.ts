import { privateKeyToAccount } from "viem/accounts";
import { parseUnits, type Hex } from "viem";
import type { GateResponse, PaymentResult, XenarchConfig } from "./types.js";

// USDC on Base mainnet (XEN-385 — manual settle, dropped x402-fetch
// because the WP plugin replays expect Xenarch-specific headers
// `X-Xenarch-Gate-Id` + `X-Xenarch-Tx-Hash`, not the raw x402 `X-PAYMENT`
// header. Mirrors xenarch-sdks/cli/src/lib/payment.ts.).
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Hex;
const USDC_DECIMALS = 6;
const AUTH_VALIDITY_SECONDS = 600;
const SETTLE_TIMEOUT_MS = 30_000;

const USDC_DOMAIN = {
  name: "USD Coin",
  version: "2",
  chainId: 8453,
  verifyingContract: USDC_BASE,
} as const;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// Canonical Xenarch replay headers — what the WP plugin's middleware
// (and any other Xenarch publisher) reads to verify the payment.
const GATE_ID_HEADER = "X-Xenarch-Gate-Id";
const TX_HASH_HEADER = "X-Xenarch-Tx-Hash";

// Local (no-token) per-call spending guard. The $1 default lives in
// DEFAULT_CONFIG; override with XENARCH_MAX_PAYMENT_USD (0 removes it). This
// is the only ceiling in standalone mode — managed per-tx/daily/monthly caps
// require an XENARCH_API_TOKEN. The pay tool checks this earlier and returns a
// clean refusal; this is the backstop covering pay-links and direct callers.
function enforceLocalCap(amount: bigint, config: XenarchConfig): void {
  if (!config.maxPaymentUsd) return;
  const cap = parseUnits(config.maxPaymentUsd.toString(), USDC_DECIMALS);
  if (amount > cap) {
    const amountUsd = (Number(amount) / 10 ** USDC_DECIMALS).toFixed(2);
    const capUsd = config.maxPaymentUsd.toFixed(2);
    throw new Error(
      `Refused: this payment is $${amountUsd}, above your local per-call cap of $${capUsd}. ` +
        `Raise it with XENARCH_MAX_PAYMENT_USD (set 0 to remove the cap), or sign in with your ` +
        `wallet at https://dash.xenarch.dev for managed per-tx / daily / monthly caps — just a ` +
        `signature, nothing moves.`,
    );
  }
}

interface AcceptEntry {
  scheme?: string;
  network?: string;
  payTo?: string;
  asset?: string;
  maxAmountRequired?: string;
}

interface SignedX402Payload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
}

interface SettleResponseBody {
  success?: boolean;
  transaction?: string;
  errorReason?: string;
  [k: string]: unknown;
}

export class NoFacilitatorSettledError extends Error {
  readonly tried: string[];
  constructor(tried: string[]) {
    super(
      `No facilitator settled the payment. Tried: ${tried.join(", ") || "(none eligible)"}`,
    );
    this.name = "NoFacilitatorSettledError";
    this.tried = tried;
  }
}

function selectAccept(
  accepts: AcceptEntry[],
  network: string,
): AcceptEntry | null {
  if (accepts.length === 0) return null;
  for (const a of accepts) {
    if (
      a.scheme === "exact" &&
      a.network === network &&
      a.asset?.toLowerCase() === USDC_BASE.toLowerCase()
    )
      return a;
  }
  for (const a of accepts) {
    if (a.scheme === "exact" && a.network === network) return a;
  }
  for (const a of accepts) {
    if (a.scheme === "exact") return a;
  }
  return accepts[0] ?? null;
}

function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return (
    "0x" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

async function postSettle(
  facilitatorUrl: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: SettleResponseBody | null }> {
  const url = `${facilitatorUrl.replace(/\/+$/, "")}/settle`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    let parsed: SettleResponseBody | null = null;
    try {
      parsed = (await res.json()) as SettleResponseBody;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make a paid HTTP request to a 402-gated URL.
 *
 * XEN-385: dropped `x402-fetch` because its replay sends the raw x402
 * `X-PAYMENT` header, which the Xenarch WP plugin's middleware doesn't
 * recognize — the plugin verifies payments via the canonical Xenarch
 * `X-Xenarch-Gate-Id` + `X-Xenarch-Tx-Hash` headers. Mirrors the
 * CLI's pattern (xenarch-sdks/cli/src/lib/payment.ts).
 *
 * Steps:
 *   1. Pick the x402 `accepts` entry to settle against (prefer exact
 *      scheme on the gate's network + USDC).
 *   2. Sign EIP-3009 `transferWithAuthorization` for USDC on Base via
 *      viem (`account.signTypedData`).
 *   3. Iterate through `gate.facilitators` in order, POSTing the signed
 *      payload to each `/settle` endpoint until one returns
 *      `success: true` with a tx hash.
 *   4. Re-fetch the gated URL with the canonical Xenarch headers; the
 *      publisher's middleware stateless-verifies the tx on-chain and
 *      serves the content.
 *
 * Throws `NoFacilitatorSettledError` if no facilitator settles. Throws
 * `Error("Paid fetch failed: ...")` if every facilitator settled but
 * the publisher's replay returns non-200.
 */
/**
 * Settle an x402 envelope and return the on-chain tx — WITHOUT the gate URL
 * re-fetch. This is the wrapped-pay-link counterpart to payAndFetch: a pay-link
 * finalizes via POST /v1/links/{id}/claim, not a publisher replay. Kept here so
 * it reuses the module-private EIP-3009 signing constants; the signing body
 * mirrors payAndFetch (XEN-414).
 */
export async function settleX402(
  config: XenarchConfig,
  gate: GateResponse,
): Promise<{ txHash: string; facilitator: string }> {
  const account = privateKeyToAccount(config.privateKey as Hex);

  const accept = selectAccept(
    (gate.accepts as AcceptEntry[]) ?? [],
    gate.network,
  );
  if (accept === null || !accept.payTo || !accept.maxAmountRequired) {
    throw new Error(
      "Pay-link has no compatible payment scheme in `accepts` (need scheme=exact + payTo + maxAmountRequired).",
    );
  }

  const amount = BigInt(accept.maxAmountRequired);
  enforceLocalCap(amount, config);

  const from = account.address;
  const validAfter = 0n;
  const validBefore = BigInt(
    Math.floor(Date.now() / 1000) + AUTH_VALIDITY_SECONDS,
  );
  const nonce = randomHex32() as Hex;

  const signature = await account.signTypedData({
    domain: USDC_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: accept.payTo as Hex,
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const signed: SignedX402Payload = {
    x402Version: 1,
    scheme: "exact",
    network: accept.network ?? gate.network,
    payload: {
      signature,
      authorization: {
        from,
        to: accept.payTo,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const settleBody = {
    x402Version: 1,
    paymentPayload: signed,
    paymentRequirements: accept,
  };

  const tried: string[] = [];
  for (const facilitator of gate.facilitators ?? []) {
    tried.push(facilitator.url);
    let result;
    try {
      result = await postSettle(facilitator.url, settleBody, SETTLE_TIMEOUT_MS);
    } catch {
      continue;
    }
    if (
      !result.ok ||
      result.body === null ||
      result.body.success !== true ||
      typeof result.body.transaction !== "string" ||
      result.body.transaction.length === 0
    ) {
      continue;
    }
    return { txHash: result.body.transaction, facilitator: facilitator.url };
  }

  throw new NoFacilitatorSettledError(tried);
}

export async function payAndFetch(
  url: string,
  config: XenarchConfig,
  gate: GateResponse,
): Promise<{ response: Response; result: PaymentResult }> {
  const account = privateKeyToAccount(config.privateKey as Hex);

  const accept = selectAccept(
    (gate.accepts as AcceptEntry[]) ?? [],
    gate.network,
  );
  if (accept === null || !accept.payTo || !accept.maxAmountRequired) {
    throw new Error(
      "Gate has no compatible payment scheme in `accepts` (need scheme=exact + payTo + maxAmountRequired).",
    );
  }

  // The gate's `maxAmountRequired` is already in base units (e.g.
  // "3000" = $0.003 USDC at 6 decimals). The local per-call cap is the
  // standalone-mode ceiling; managed caps (with a token) are enforced
  // upstream by the control-plane preflight.
  const amount = BigInt(accept.maxAmountRequired);
  enforceLocalCap(amount, config);

  const from = account.address;
  const validAfter = 0n;
  const validBefore = BigInt(
    Math.floor(Date.now() / 1000) + AUTH_VALIDITY_SECONDS,
  );
  const nonce = randomHex32() as Hex;

  const signature = await account.signTypedData({
    domain: USDC_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: accept.payTo as Hex,
      value: amount,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const signed: SignedX402Payload = {
    x402Version: 1,
    scheme: "exact",
    network: accept.network ?? gate.network,
    payload: {
      signature,
      authorization: {
        from,
        to: accept.payTo,
        value: amount.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };

  const settleBody = {
    x402Version: 1,
    paymentPayload: signed,
    paymentRequirements: accept,
  };

  // Try each facilitator in order. The first to return success wins.
  const tried: string[] = [];
  let txHash: string | null = null;
  let chosenFacilitatorUrl: string | null = null;
  for (const facilitator of gate.facilitators ?? []) {
    tried.push(facilitator.url);
    let result;
    try {
      result = await postSettle(facilitator.url, settleBody, SETTLE_TIMEOUT_MS);
    } catch {
      continue;
    }
    if (
      !result.ok ||
      result.body === null ||
      result.body.success !== true ||
      typeof result.body.transaction !== "string" ||
      result.body.transaction.length === 0
    ) {
      continue;
    }
    txHash = result.body.transaction;
    chosenFacilitatorUrl = facilitator.url;
    break;
  }

  if (txHash === null || chosenFacilitatorUrl === null) {
    throw new NoFacilitatorSettledError(tried);
  }

  // Replay the gated URL with the canonical Xenarch headers — this is
  // what the publisher's middleware reads to verify the payment.
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "xenarch-mcp-agent",
      [GATE_ID_HEADER]: gate.gate_id,
      [TX_HASH_HEADER]: txHash,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    // Tx_hash IS known here even though the replay failed — preserve it
    // on the error so the caller can post a status='failed' receipt
    // referring to the actual on-chain tx (it landed; only delivery
    // failed).
    const err = new Error(
      `Paid fetch failed: ${response.status} ${body.slice(0, 400)}`,
    ) as Error & { txHash?: string; facilitator?: string };
    err.txHash = txHash;
    err.facilitator = chosenFacilitatorUrl;
    throw err;
  }

  return {
    response,
    result: {
      txHash,
      facilitator: chosenFacilitatorUrl,
    },
  };
}
