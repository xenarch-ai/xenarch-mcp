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
  DeviceStartResponse,
  DevicePollResponse,
  PayLinkSchemaResponse,
  PayLinkValidateResponse,
  PayLinkCreateBody,
  PayLinkCreateResponse,
  PayLinkListResponse,
  PayLinkDetail,
  PayLinkRevokeResponse,
  MerchantPaymentListResponse,
  SubscriberListResponse,
  MerchantProfileResponse,
  MerchantProfileBody,
  PayLinkInitiateResponse,
  PayLinkClaimResponse,
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

// --- Device-authorization flow (XEN-411) ---

/** Begin a browser device-login. No auth — useless until a human approves. */
export async function deviceStart(
  apiBase: string,
): Promise<DeviceStartResponse> {
  const res = await fetch(`${apiBase}/v1/auth/device/start`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to start device login: ${await errorMessage(res)}`);
  }
  return (await res.json()) as DeviceStartResponse;
}

/** Poll for approval; returns the session token once a human approves. */
export async function devicePoll(
  apiBase: string,
  deviceCode: string,
): Promise<DevicePollResponse> {
  const res = await fetch(`${apiBase}/v1/auth/device/poll`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  if (!res.ok) {
    throw new Error(`Device poll failed: ${await errorMessage(res)}`);
  }
  return (await res.json()) as DevicePollResponse;
}

// --- Merchant ops (SIWE session on bare /v1/* paths, XEN-414) -------------
//
// The agent control plane lives under /v1/me/agent (meAgentRequest). Merchant
// routes (/v1/links, /v1/payments, /v1/subscribers, /v1/merchant-profile)
// share the same xen_session cookie but sit at bare /v1/* paths.

export async function meSessionRequest<T>(
  apiBase: string,
  sessionToken: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(extraHeaders ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    throw new SessionExpiredError(await errorMessage(res));
  }
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** GET /v1/links/schema — public, no auth. The create-body descriptor. */
export async function getLinkSchema(
  apiBase: string,
): Promise<PayLinkSchemaResponse> {
  const res = await fetch(`${apiBase}/v1/links/schema`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as PayLinkSchemaResponse;
}

export function validateLink(
  apiBase: string,
  token: string,
  params: Record<string, unknown>,
): Promise<PayLinkValidateResponse> {
  return meSessionRequest<PayLinkValidateResponse>(
    apiBase,
    token,
    "POST",
    "/v1/links/validate",
    { params },
  );
}

export function createLink(
  apiBase: string,
  token: string,
  body: PayLinkCreateBody,
  idempotencyKey: string,
): Promise<PayLinkCreateResponse> {
  return meSessionRequest<PayLinkCreateResponse>(
    apiBase,
    token,
    "POST",
    "/v1/links",
    body,
    { "Idempotency-Key": idempotencyKey },
  );
}

export function listLinks(
  apiBase: string,
  token: string,
  query = "",
): Promise<PayLinkListResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<PayLinkListResponse>(apiBase, token, "GET", `/v1/links${qs}`);
}

export function getLinkDetail(
  apiBase: string,
  token: string,
  linkId: string,
): Promise<PayLinkDetail> {
  return meSessionRequest<PayLinkDetail>(
    apiBase,
    token,
    "GET",
    `/v1/links/${encodeURIComponent(linkId)}`,
  );
}

export function revokeLink(
  apiBase: string,
  token: string,
  linkId: string,
): Promise<PayLinkRevokeResponse> {
  return meSessionRequest<PayLinkRevokeResponse>(
    apiBase,
    token,
    "DELETE",
    `/v1/links/${encodeURIComponent(linkId)}`,
  );
}

export function listMerchantPayments(
  apiBase: string,
  token: string,
  query = "",
): Promise<MerchantPaymentListResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<MerchantPaymentListResponse>(
    apiBase,
    token,
    "GET",
    `/v1/payments/received${qs}`,
  );
}

export function listSubscribers(
  apiBase: string,
  token: string,
  query = "",
): Promise<SubscriberListResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<SubscriberListResponse>(
    apiBase,
    token,
    "GET",
    `/v1/subscribers${qs}`,
  );
}

export function getMerchantProfile(
  apiBase: string,
  token: string,
): Promise<MerchantProfileResponse | null> {
  return meSessionRequest<MerchantProfileResponse | null>(
    apiBase,
    token,
    "GET",
    "/v1/merchant-profile",
  );
}

export function putMerchantProfile(
  apiBase: string,
  token: string,
  body: MerchantProfileBody,
): Promise<MerchantProfileResponse> {
  return meSessionRequest<MerchantProfileResponse>(
    apiBase,
    token,
    "PUT",
    "/v1/merchant-profile",
    body,
  );
}

export function verifyMerchantDomain(
  apiBase: string,
  token: string,
): Promise<MerchantProfileResponse> {
  return meSessionRequest<MerchantProfileResponse>(
    apiBase,
    token,
    "POST",
    "/v1/merchant-profile/verify-domain",
  );
}

/** POST /v1/links/{id}/initiate — x402 envelope (HTTP 402 on success). */
export async function initiateLinkPayment(
  apiBase: string,
  linkId: string,
): Promise<PayLinkInitiateResponse> {
  const res = await fetch(
    `${apiBase}/v1/links/${encodeURIComponent(linkId)}/initiate`,
    { method: "POST", headers: { "User-Agent": USER_AGENT } },
  );
  if (res.status === 402 || res.ok) {
    return (await res.json()) as PayLinkInitiateResponse;
  }
  throw new Error(await errorMessage(res));
}

/** POST /v1/links/{id}/claim — record the on-chain tx against the link. */
export async function claimLinkPayment(
  apiBase: string,
  linkId: string,
  txHash: string,
): Promise<PayLinkClaimResponse> {
  const res = await fetch(
    `${apiBase}/v1/links/${encodeURIComponent(linkId)}/claim`,
    {
      method: "POST",
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hash: txHash }),
    },
  );
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as PayLinkClaimResponse;
}
