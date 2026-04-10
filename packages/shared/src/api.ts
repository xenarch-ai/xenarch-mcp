import type { GateResponse } from "./types.js";

const USER_AGENT = "xenarch-mcp/0.1.0";

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
 */
export async function fetchGate(url: string): Promise<FetchGateResult> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": USER_AGENT },
  });

  if (res.status !== 402) {
    return { gated: false, gate: null };
  }

  const body = await res.json();
  if (!body.xenarch) {
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
  const res = await fetch(`${apiBase}/v1/gates/domain/${encodeURIComponent(domain)}`, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!res.ok) return null;
  return (await res.json()) as GateResponse;
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
    throw new Error(`Failed to get payment history: ${await errorMessage(res)}`);
  }

  return (await res.json()) as PaymentHistoryItem[];
}
