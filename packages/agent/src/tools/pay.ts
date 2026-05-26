import { z } from "zod";
import {
  fetchGate,
  fetchGateByDomain,
  payAndFetch,
  verifyPayment,
  getWalletAddress,
} from "@xenarch/core";
import type { GateResponse, XenarchConfig } from "@xenarch/core";
import { reportReceipt } from "../agent-receipts.js";

export const paySchema = z.object({
  url: z
    .string()
    .describe(
      "The URL or domain to pay for. Must have an active x402 payment gate. Payment settles in USDC on Base L2, agent wallet to seller wallet direct. The agent wallet only ever holds USDC; no ETH or other gas coin needed.",
    ),
});

export type PayInput = z.infer<typeof paySchema>;

export async function pay(input: PayInput, config: XenarchConfig) {
  const { url } = input;
  const walletAddress = getWalletAddress(config);

  // Resolve a target URL we can actually GET. For bare domains, look up the
  // canonical resource URL on the platform; for full URLs, hit them directly.
  let gate: GateResponse;
  let resourceUrl: string;
  if (!url.startsWith("http")) {
    const found = await fetchGateByDomain(config.apiBase, url);
    if (!found) {
      throw new Error(`No Xenarch gate found for domain: ${url}`);
    }
    gate = found;
    const firstResource = gate.accepts[0]?.resource;
    if (!firstResource) {
      throw new Error(
        `Gate ${gate.gate_id} has no accepts[].resource — cannot determine URL to fetch.`,
      );
    }
    resourceUrl = firstResource;
  } else {
    const result = await fetchGate(url);
    if (!result.gated || !result.gate) {
      throw new Error(`No Xenarch gate found at: ${url}`);
    }
    gate = result.gate;
    resourceUrl = url;
  }

  // Sign the EIP-3009 USDC transfer authorization, submit the payment, and
  // re-fetch the resource. Returns the response body as text so the caller
  // can use it.
  const { response, result } = await payAndFetch(resourceUrl, config, gate);
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  // Best-effort platform-side verification using the on-chain tx_hash.
  // Platform looks up the USDC Transfer event each call (stateless).
  let verified = null;
  if (result.txHash) {
    try {
      verified = await verifyPayment(config.apiBase, gate.gate_id, result.txHash);
    } catch {
      // Verification is advisory — don't fail the user request if the
      // platform is unreachable; the on-chain payment itself is canonical.
    }
  }

  // Agent control plane (XEN-372): fire-and-forget receipt report.
  // No-op without XENARCH_API_TOKEN. Never blocks the pay flow.
  if (result.txHash) {
    await reportReceipt(config.apiBase, {
      url: resourceUrl,
      amount_usd: gate.price_usd,
      source: "mcp",
      status: "paid",
      paid_at: new Date().toISOString(),
      tx_hash: result.txHash,
      facilitator: result.facilitator,
      wallet_address: walletAddress,
    });
  }

  return {
    success: true,
    gate_id: gate.gate_id,
    tx_hash: result.txHash,
    facilitator: result.facilitator,
    seller_wallet: gate.seller_wallet,
    url: resourceUrl,
    wallet: walletAddress,
    content: body,
    verified,
  };
}
