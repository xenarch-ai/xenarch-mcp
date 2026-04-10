import { z } from "zod";
import {
  fetchGate,
  fetchGateByDomain,
  executePayment,
  verifyPayment,
  createSigner,
  USDC_BASE,
  MOCK_USDC_SEPOLIA,
  SPLITTER_ADDRESS_MAINNET,
  SPLITTER_ADDRESS_SEPOLIA,
} from "@xenarch/shared";
import type { XenarchConfig } from "@xenarch/shared";

export const paySchema = z.object({
  url: z
    .string()
    .describe(
      "The URL or domain to pay for. Must have a Xenarch gate configured.",
    ),
  amount: z
    .string()
    .optional()
    .describe(
      "Override amount in USD (e.g. '0.01'). Defaults to the gate's configured price.",
    ),
});

export type PayInput = z.infer<typeof paySchema>;

export async function pay(input: PayInput, config: XenarchConfig) {
  const { url, amount } = input;
  const signer = createSigner(config);
  const walletAddress = await signer.getAddress();

  // Resolve gate
  let gate;
  if (!url.startsWith("http")) {
    gate = await fetchGateByDomain(config.apiBase, url);
    if (!gate) {
      throw new Error(`No Xenarch gate found for domain: ${url}`);
    }
  } else {
    const result = await fetchGate(url);
    if (!result.gated || !result.gate) {
      throw new Error(`No Xenarch gate found at: ${url}`);
    }
    gate = result.gate;
  }

  // Override price if amount specified
  if (amount) {
    gate = { ...gate, price_usd: amount };
  }

  // Validate splitter is a known Xenarch contract
  const trustedSplitters = [SPLITTER_ADDRESS_MAINNET, SPLITTER_ADDRESS_SEPOLIA];
  if (!trustedSplitters.some(s => s.toLowerCase() === gate.splitter.toLowerCase())) {
    throw new Error(`Untrusted splitter contract: ${gate.splitter}`);
  }

  // Pick USDC address based on network
  const usdcAddress =
    config.network === "base-sepolia" ? MOCK_USDC_SEPOLIA : USDC_BASE;

  // Execute on-chain payment
  const result = await executePayment(gate, signer, usdcAddress);

  // Verify with platform and get access token
  const verification = await verifyPayment(gate.verify_url, result.txHash);

  return {
    success: true,
    tx_hash: result.txHash,
    block_number: result.blockNumber,
    amount_usd: gate.price_usd,
    url: url,
    access_token: verification.access_token,
    expires_at: verification.expires_at,
    wallet: walletAddress,
  };
}
