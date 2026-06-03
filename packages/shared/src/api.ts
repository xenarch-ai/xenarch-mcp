import type {
  GateResponse,
  VerifiedPaymentResponse,
  MeAgentProfile,
  AgentSummary,
  AgentCaps,
  AgentCapsPut,
  CapResetResult,
  ScopeReadResult,
  ScopeRuleInput,
  ScopeMode,
  PauseResult,
  AgentApiKeySummary,
  AgentApiKeyIssued,
  AgentReceiptList,
} from "./types.js";
import { SESSION_COOKIE_NAME } from "./types.js";

const USER_AGENT = "xenarch-mcp/0.2.0";

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const detail = body.detail ?? body.message;
    if (detail === undefined || detail === null) return res.statusText;
    if (typeof detail === "string") return detail;
    // FastAPI 422 returns `detail` as an array of { loc, msg, type } objects;
    // stringify so callers don't surface the useless "[object Object]".
    if (Array.isArray(detail)) {
      return detail.map((d) => d?.msg ?? JSON.stringify(d)).join("; ");
    }
    return JSON.stringify(detail);
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

// --- Agent control plane (SIWE session: /v1/me/agent/*) ---
//
// SIWE-owner-authed via the `xen_session` cookie. The MCP reuses the session
// the CLI's `xenarch agent login` writes to ~/.xenarch/config.json. These are
// the management endpoints behind the dashboard's /agent/* pages.

/** Thrown when the SIWE session cookie is missing/expired (HTTP 401). */
export class SessionExpiredError extends Error {
  constructor(message = "Session expired") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

async function meAgentRequest<T>(
  apiBase: string,
  sessionToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiBase}/v1/me/agent${path}`, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    throw new SessionExpiredError(await errorMessage(res));
  }
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  if (res.status === 204) return undefined as T; // key revoke
  return (await res.json()) as T;
}

export function getMeAgent(
  apiBase: string,
  token: string,
): Promise<MeAgentProfile> {
  return meAgentRequest<MeAgentProfile>(apiBase, token, "GET", "");
}

export function getAgentSummary(
  apiBase: string,
  token: string,
  period = "24h",
): Promise<AgentSummary> {
  return meAgentRequest<AgentSummary>(
    apiBase,
    token,
    "GET",
    `/summary?period=${encodeURIComponent(period)}`,
  );
}

export function getAgentCaps(apiBase: string, token: string): Promise<AgentCaps> {
  return meAgentRequest<AgentCaps>(apiBase, token, "GET", "/caps");
}

export function putAgentCaps(
  apiBase: string,
  token: string,
  caps: AgentCapsPut,
): Promise<AgentCaps> {
  return meAgentRequest<AgentCaps>(apiBase, token, "PUT", "/caps", caps);
}

export function resetAgentDayCap(
  apiBase: string,
  token: string,
): Promise<CapResetResult> {
  return meAgentRequest<CapResetResult>(
    apiBase,
    token,
    "POST",
    "/caps/reset-day",
  );
}

export function getAgentScope(
  apiBase: string,
  token: string,
): Promise<ScopeReadResult> {
  return meAgentRequest<ScopeReadResult>(apiBase, token, "GET", "/scope");
}

export function putAgentScope(
  apiBase: string,
  token: string,
  defaultMode: ScopeMode,
  rules: ScopeRuleInput[],
): Promise<ScopeReadResult> {
  return meAgentRequest<ScopeReadResult>(apiBase, token, "PUT", "/scope", {
    default_mode: defaultMode,
    rules,
  });
}

export function setAgentPause(
  apiBase: string,
  token: string,
  paused: boolean,
): Promise<PauseResult> {
  return meAgentRequest<PauseResult>(apiBase, token, "POST", "/pause", {
    paused,
  });
}

export function listAgentKeys(
  apiBase: string,
  token: string,
): Promise<AgentApiKeySummary[]> {
  return meAgentRequest<AgentApiKeySummary[]>(apiBase, token, "GET", "/keys");
}

export function createAgentKey(
  apiBase: string,
  token: string,
  label: string | null,
): Promise<AgentApiKeyIssued> {
  return meAgentRequest<AgentApiKeyIssued>(apiBase, token, "POST", "/keys", {
    label,
  });
}

export function rotateAgentKey(
  apiBase: string,
  token: string,
  keyId: string,
): Promise<AgentApiKeyIssued> {
  return meAgentRequest<AgentApiKeyIssued>(
    apiBase,
    token,
    "POST",
    `/keys/${keyId}/rotate`,
  );
}

export function revokeAgentKey(
  apiBase: string,
  token: string,
  keyId: string,
): Promise<void> {
  return meAgentRequest<void>(apiBase, token, "DELETE", `/keys/${keyId}`);
}

export function listAgentReceipts(
  apiBase: string,
  token: string,
  query = "",
): Promise<AgentReceiptList> {
  const qs = query ? `?${query}` : "";
  return meAgentRequest<AgentReceiptList>(
    apiBase,
    token,
    "GET",
    `/receipts${qs}`,
  );
}
