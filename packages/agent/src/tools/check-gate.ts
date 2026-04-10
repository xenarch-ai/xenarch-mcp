import { z } from "zod";
import { fetchGate, fetchGateByDomain } from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";

export const checkGateSchema = z.object({
  url: z
    .string()
    .describe(
      "The URL to check for a Xenarch payment gate. Can be a full URL (https://example.com/page) or just a domain (example.com).",
    ),
});

export type CheckGateInput = z.infer<typeof checkGateSchema>;

export async function checkGate(input: CheckGateInput, config: XenarchConfig) {
  const { url } = input;

  // If it looks like a bare domain, try the platform API first
  if (!url.startsWith("http")) {
    const gate = await fetchGateByDomain(config.apiBase, url);
    if (gate) {
      return {
        gated: true,
        gate_id: gate.gate_id,
        price_usd: gate.price_usd,
        splitter: gate.splitter,
        collector: gate.collector,
        network: gate.network,
        asset: gate.asset,
        protocol: gate.protocol,
      };
    }
    return { gated: false, message: `No Xenarch gate found for ${url}` };
  }

  // Full URL — make a request and check for 402
  const result = await fetchGate(url);
  if (!result.gated || !result.gate) {
    return { gated: false, message: `No Xenarch gate found at ${url}` };
  }

  return {
    gated: true,
    gate_id: result.gate.gate_id,
    price_usd: result.gate.price_usd,
    splitter: result.gate.splitter,
    collector: result.gate.collector,
    network: result.gate.network,
    asset: result.gate.asset,
    protocol: result.gate.protocol,
  };
}
