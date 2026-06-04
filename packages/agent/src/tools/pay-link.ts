// Wrapped pay-link payment tool (XEN-415) — the Xenarch-rails counterpart to
// xenarch_pay (pure x402 gate). Sources the x402 envelope from
// POST /v1/links/{id}/initiate, settles EIP-3009 on Base (settleX402,
// shared with the gate path), and finalizes with POST /v1/links/{id}/claim.

import { z } from "zod";
import { formatUnits } from "viem";
import {
  initiateLinkPayment,
  claimLinkPayment,
  settleX402,
  getWalletAddress,
  type XenarchConfig,
  type GateResponse,
  type PayLinkClaimResponse,
} from "@xenarch/core";
import { checkPreflight, formatDenyMessage } from "../agent-preflight.js";
import { reportReceipt } from "../agent-receipts.js";

const CLAIM_RETRIES = 6;
const CLAIM_RETRY_DELAY_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only "tx not indexed yet" is worth retrying; revoked/expired/invalid-tx are
 * terminal and should fail fast (the tx already settled on-chain). */
function isTransientClaimError(err: unknown): boolean {
  const m = ((err as Error)?.message ?? "").toLowerCase();
  return /not found|not yet|pending|unconfirmed|not confirmed|no transaction|try again|still/.test(
    m,
  );
}

/** Recognize a Xenarch hosted-checkout URL and pull out its link id (§12.7). */
export function hostedCheckoutLinkId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)xenarch\.(com|dev)$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/l\/([A-Za-z0-9]+)\/?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export interface PayLinkFlowResult {
  tx_hash: string;
  facilitator: string;
  link_id: string;
  amount_usd: string;
  claim: PayLinkClaimResponse;
  auth_token: string | null;
}

export async function payLinkWrapped(
  config: XenarchConfig,
  linkId: string,
  maxPriceUsd: number,
): Promise<PayLinkFlowResult> {
  const env = await initiateLinkPayment(config.apiBase, linkId);
  if (env.error) throw new Error(env.error);
  if (!env.accepts.length) {
    throw new Error("Pay-link returned no payment options (open-amount links aren't payable here yet).");
  }
  const accept = env.accepts.find((a) => a.scheme === "exact") ?? env.accepts[0];
  const priceUsd = formatUnits(BigInt(accept.maxAmountRequired), 6);
  if (parseFloat(priceUsd) > maxPriceUsd) {
    throw new Error(`Pay-link price $${priceUsd} exceeds max_price_usd $${maxPriceUsd}.`);
  }

  // Agent control-plane preflight (XEN-373): gate the pay-link by the agent's
  // caps / scope / pause before settling — same enforcement xenarch_pay uses.
  // No-op unless XENARCH_API_TOKEN is configured (fail-closed if it is).
  const preflight = await checkPreflight(
    config.apiBase,
    `https://pay.xenarch.com/l/${linkId}`,
    priceUsd,
  );
  if (!preflight.ok) {
    // formatDenyMessage already prefixes "Refused by Xenarch control plane:";
    // only the unreachable (detail) case needs the prefix added.
    const reason =
      "detail" in preflight
        ? `Refused by Xenarch control plane: ${preflight.detail}`
        : formatDenyMessage(preflight);
    throw new Error(reason);
  }
  const authToken = "bypassed" in preflight ? null : preflight.auth_token;

  const gate: GateResponse = {
    gate_id: env.link_id,
    x402Version: env.x402Version,
    accepts: env.accepts,
    facilitators: env.facilitators,
    seller_wallet: accept.payTo,
    network: env.network,
    asset: env.asset,
    expires: env.expires ?? undefined,
  };

  const settle = await settleX402(config, gate);

  let lastErr: unknown;
  for (let attempt = 0; attempt < CLAIM_RETRIES; attempt++) {
    try {
      const claim = await claimLinkPayment(config.apiBase, linkId, settle.txHash);
      return {
        tx_hash: settle.txHash,
        facilitator: settle.facilitator,
        link_id: linkId,
        amount_usd: priceUsd,
        claim,
        auth_token: authToken,
      };
    } catch (err) {
      lastErr = err;
      if (!isTransientClaimError(err)) {
        throw new Error(
          `Payment settled (tx ${settle.txHash}) but the link rejected it: ${(err as Error).message}`,
        );
      }
      if (attempt < CLAIM_RETRIES - 1) await sleep(CLAIM_RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `Payment settled (tx ${settle.txHash}) but the link could not confirm it after retries: ${(lastErr as Error).message}`,
  );
}

export const xenarchPayLinkSchema = z.object({
  link_id: z.string().describe("The Xenarch pay-link id to pay"),
  max_price_usd: z.number().optional().describe("Refuse to pay if the price exceeds this (default 1.00)"),
});
export type XenarchPayLinkInput = z.infer<typeof xenarchPayLinkSchema>;

export async function xenarchPayLink(input: XenarchPayLinkInput, config: XenarchConfig) {
  const res = await payLinkWrapped(config, input.link_id, input.max_price_usd ?? 1.0);
  // Report the receipt (best-effort; no-op without a control-plane token) so
  // pay-link payments show up in `agent receipts` like gate-pay does.
  try {
    await reportReceipt(config.apiBase, {
      url: `https://pay.xenarch.com/l/${res.link_id}`,
      amount_usd: res.amount_usd,
      source: "mcp",
      status: res.claim.status === "confirmed" ? "paid" : "pending",
      paid_at: new Date().toISOString(),
      tx_hash: res.tx_hash,
      facilitator: res.facilitator,
      wallet_address: getWalletAddress(config),
      auth_token: res.auth_token,
    });
  } catch {
    // receipts are telemetry — never fail a settled payment over them
  }
  return res;
}
