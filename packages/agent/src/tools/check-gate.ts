import { z } from "zod";
import { fetchGate, fetchGateByDomain } from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";

export const checkGateSchema = z.object({
  url: z
    .string()
    .describe(
      "The URL or domain to check for an x402 payment gate. Accepts a full URL (https://example.com/article) or bare domain (example.com). Returns pricing in USD and payment requirements if gated.",
    ),
});

export type CheckGateInput = z.infer<typeof checkGateSchema>;

export async function checkGate(input: CheckGateInput, config: XenarchConfig) {
  const { url } = input;

  if (!url.startsWith("http")) {
    const gate = await fetchGateByDomain(config.apiBase, url);
    if (gate) {
      return {
        gated: true,
        gate_id: gate.gate_id,
        accepts: gate.accepts,
        facilitators: gate.facilitators,
        seller_wallet: gate.seller_wallet,
        network: gate.network,
        asset: gate.asset,
      };
    }
    return { gated: false, message: `No Xenarch gate found for ${url}` };
  }

  const result = await fetchGate(url);
  if (!result.gated || !result.gate) {
    return { gated: false, message: `No Xenarch gate found at ${url}` };
  }

  return {
    gated: true,
    gate_id: result.gate.gate_id,
    accepts: result.gate.accepts,
    facilitators: result.gate.facilitators,
    seller_wallet: result.gate.seller_wallet,
    network: result.gate.network,
    asset: result.gate.asset,
  };
}
