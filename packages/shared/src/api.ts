import type { GateResponse, VerifiedPaymentResponse } from "./types.js";

const USER_AGENT = "xenarch-mcp/0.2.0";

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.detail ?? body.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export interface FetchGateResult {
  gated: boolean;
  gate: GateResponse | null;
}

/**
 * Check if a URL has a Xenarch gate by making a request and checking for 402.
 * Returns the parsed gate metadata in the new (post-XEN-179) shape.
 */
export async function fetchGate(url: string): Promise<FetchGateResult> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT },
  });

  if (res.status !== 402) {
    return { gated: false, gate: null };
  }

  const body = (await res.json()) as Partial<GateResponse>;
  if (!body.gate_id || !body.accepts) {
    return { gated: false, gate: null };
  }

  return { gated: true, gate: body as GateResponse };
}

/**
 * Fetch gate info from the platform API by domain.
 */
export async function fetchGateByDomain(
  apiBase: string,
  domain: string,
): Promise<GateResponse | null> {
  const res = await fetch(
    `${apiBase}/v1/gates/domain/${encodeURIComponent(domain)}`,
    { headers: { "User-Agent": USER_AGENT } },
  );

  if (!res.ok) return null;
  return (await res.json()) as GateResponse;
}

/**
 * Verify a payment with the Xenarch platform using the on-chain tx_hash.
 * Stateless: the platform looks up the USDC Transfer event each call.
 */
export async function verifyPayment(
  apiBase: string,
  gateId: string,
  txHash: string,
): Promise<VerifiedPaymentResponse> {
  const res = await fetch(`${apiBase}/v1/gates/${gateId}/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ tx_hash: txHash }),
  });

  if (!res.ok) {
    throw new Error(`Payment verification failed: ${await errorMessage(res)}`);
  }

  return (await res.json()) as VerifiedPaymentResponse;
}

export interface PaymentHistoryItem {
  url: string;
  domain: string;
  amount_usd: string;
  tx_hash: string;
  paid_at: string;
}

/**
 * Get payment history for a wallet address.
 */
export async function getPaymentHistory(
  apiBase: string,
  walletAddress: string,
  options?: { domain?: string; limit?: number },
): Promise<PaymentHistoryItem[]> {
  const params = new URLSearchParams();
  params.set("wallet", walletAddress);
  if (options?.domain) params.set("domain", options.domain);
  if (options?.limit) params.set("limit", String(options.limit));

  const res = await fetch(`${apiBase}/v1/payments/history?${params}`, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(
      `Failed to get payment history: ${await errorMessage(res)}`,
    );
  }

  return (await res.json()) as PaymentHistoryItem[];
}
