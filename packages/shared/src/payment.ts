import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import type { GateResponse, PaymentResult, XenarchConfig } from "./types.js";

function buildWalletClient(config: XenarchConfig): WalletClient {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);
  const chain = config.network === "base-sepolia" ? baseSepolia : base;
  return createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  });
}

/**
 * Make a paid HTTP request to a 402-gated URL.
 *
 * Wraps the native fetch with x402-fetch, which signs an EIP-3009
 * `transferWithAuthorization` for USDC and submits it through the facilitator
 * named in the 402 response. Settles as a generic USDC
 * `Transfer(from=payer, to=payTo, value=maxAmountRequired)` event on Base.
 * Non-custodial — no intermediary contract.
 */
export async function payAndFetch(
  url: string,
  config: XenarchConfig,
  gate: GateResponse,
): Promise<{ response: Response; result: PaymentResult }> {
  const client = buildWalletClient(config);

  const maxBaseUnits = config.maxPaymentUsd
    ? BigInt(Math.round(config.maxPaymentUsd * 1_000_000))
    : undefined;

  const fetchWithPay = wrapFetchWithPayment(
    fetch,
    // viem WalletClient is structurally compatible with x402's wallet interface
    client as unknown as Parameters<typeof wrapFetchWithPayment>[1],
    maxBaseUnits,
  );

  const response = await fetchWithPay(url, { method: "GET" });

  if (!response.ok) {
    const msg = await response.text().catch(() => response.statusText);
    throw new Error(`Paid fetch failed: ${response.status} ${msg}`);
  }

  // x402-fetch surfaces the chosen facilitator in the X-PAYMENT-RESPONSE
  // header. Echo the gate's first facilitator if absent.
  const facilitator =
    response.headers.get("x-payment-response") ??
    gate.facilitators[0]?.name ??
    "unknown";

  // tx_hash extraction: x402-fetch v1 puts settlement details in
  // X-PAYMENT-RESPONSE header (base64-encoded JSON). Best-effort decode.
  let txHash = "";
  const rawHeader = response.headers.get("x-payment-response");
  if (rawHeader) {
    try {
      const decoded = JSON.parse(
        Buffer.from(rawHeader, "base64").toString("utf-8"),
      );
      txHash = decoded.transaction ?? decoded.tx_hash ?? "";
    } catch {
      // header not base64-JSON; leave txHash empty and rely on platform verify
    }
  }

  return {
    response,
    result: {
      txHash,
      facilitator,
    },
  };
}
