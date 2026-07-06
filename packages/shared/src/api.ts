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
  MeAgentUpdateBody,
  AgentReceiptItem,
  AgentWebhookConfig,
  AgentWebhookConfigBody,
  AgentWebhookSecretResult,
  AgentWebhookDeliveryItem,
  AgentWebhookDeliveriesResponse,
  SubscriberDetail,
  SubscriberChargesResponse,
  SubscriberCancelResponse,
  ManageLinkResponse,
  SubscribersRollup,
  PeriodCapResult,
  CollectableResponse,
  CollectRecordResult,
  PermitSubmitResult,
  FireDigestResult,
  PayLinkEventsResponse,
  PayLinkRollup,
  PayLinkSummary,
  PayLinkMetadataBody,
  LinkGroupAssignResult,
  Group,
  GroupCreateBody,
  GroupUpdateBody,
  GroupListResponse,
  OrderListResponse,
  Order,
  ShipOrderBody,
  WebhookConfig,
  WebhookConfigBody,
  WebhookSecretResult,
  WebhookDeliveryItem,
  WebhookDeliveriesResponse,
  MeSiteListItem,
  MeSiteCreateBody,
  MeSiteCreateResponse,
  SiteDetail,
  SitePricingBody,
  SitePricingResult,
  SiteGatingBody,
  SiteGatingResult,
  RotateTokenResult,
  SiteTransactionsResponse,
  CategoryBreakdownResponse,
  SiteStatsResponse,
  PublisherGating,
  PublisherGatingBody,
  SiteClaimBody,
  SiteClaimResult,
  BotCatalogResponse,
  BotActivityResponse,
  SiweNonceResponse,
  MeWalletsListResponse,
  LinkVerifyResponse,
  OwnerTransferResult,
  MerchantApiKeySummary,
  MerchantApiKeyIssued,
  InviteCreateBody,
  InviteCreateResult,
  InvitesListResponse,
  InvitePreviewResponse,
  InviteRedeemResponse,
  OnboardingEmailResult,
  OnboardingEmailVerifyResult,
  AssetUploadResponse,
  EarningsSummary,
} from "./types.js";
import { SESSION_COOKIE_NAME } from "./types.js";

const USER_AGENT = "xenarch-mcp/1.2.0";

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

// --- Agent profile, single receipt, webhooks (XEN-517) ---------------------

export function updateMeAgent(
  apiBase: string,
  token: string,
  body: MeAgentUpdateBody,
): Promise<MeAgentProfile> {
  return meAgentRequest<MeAgentProfile>(apiBase, token, "PUT", "", body);
}

export function getMeAgentReceipt(
  apiBase: string,
  token: string,
  receiptId: string,
): Promise<AgentReceiptItem> {
  return meAgentRequest<AgentReceiptItem>(
    apiBase,
    token,
    "GET",
    `/receipts/${encodeURIComponent(receiptId)}`,
  );
}

export function getAgentWebhook(
  apiBase: string,
  token: string,
): Promise<AgentWebhookConfig> {
  return meAgentRequest<AgentWebhookConfig>(apiBase, token, "GET", "/webhooks");
}

export function putAgentWebhook(
  apiBase: string,
  token: string,
  body: AgentWebhookConfigBody,
): Promise<AgentWebhookConfig> {
  return meAgentRequest<AgentWebhookConfig>(apiBase, token, "PUT", "/webhooks", body);
}

export function rotateAgentWebhookSecret(
  apiBase: string,
  token: string,
): Promise<AgentWebhookSecretResult> {
  return meAgentRequest<AgentWebhookSecretResult>(
    apiBase,
    token,
    "POST",
    "/webhooks/rotate-secret",
  );
}

export function testAgentWebhook(
  apiBase: string,
  token: string,
): Promise<AgentWebhookDeliveryItem> {
  return meAgentRequest<AgentWebhookDeliveryItem>(
    apiBase,
    token,
    "POST",
    "/webhooks/test",
  );
}

export function listAgentWebhookDeliveries(
  apiBase: string,
  token: string,
  query = "",
): Promise<AgentWebhookDeliveriesResponse> {
  const qs = query ? `?${query}` : "";
  return meAgentRequest<AgentWebhookDeliveriesResponse>(
    apiBase,
    token,
    "GET",
    `/webhooks/deliveries${qs}`,
  );
}

export function retryAgentWebhookDelivery(
  apiBase: string,
  token: string,
  deliveryId: string,
): Promise<AgentWebhookDeliveryItem> {
  return meAgentRequest<AgentWebhookDeliveryItem>(
    apiBase,
    token,
    "POST",
    `/webhooks/deliveries/${encodeURIComponent(deliveryId)}/retry`,
  );
}

/**
 * Like {@link meSessionRequest} but returns the raw response body as text —
 * for endpoints that emit non-JSON (e.g. GET /v1/orders/export.csv).
 */
export async function meSessionRequestText(
  apiBase: string,
  sessionToken: string,
  method: string,
  path: string,
): Promise<string> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
  });
  if (res.status === 401) {
    throw new SessionExpiredError(await errorMessage(res));
  }
  if (!res.ok) {
    throw new Error(await errorMessage(res));
  }
  return await res.text();
}

// --- Subscribers: lifecycle + collections (XEN-517) ------------------------

export function getSubscriber(
  apiBase: string,
  token: string,
  subscriptionId: string,
): Promise<SubscriberDetail> {
  return meSessionRequest<SubscriberDetail>(
    apiBase,
    token,
    "GET",
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}`,
  );
}

export function listSubscriberCharges(
  apiBase: string,
  token: string,
  subscriptionId: string,
  query = "",
): Promise<SubscriberChargesResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<SubscriberChargesResponse>(
    apiBase,
    token,
    "GET",
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/charges${qs}`,
  );
}

export function getSubscribersRollup(
  apiBase: string,
  token: string,
): Promise<SubscribersRollup> {
  return meSessionRequest<SubscribersRollup>(
    apiBase,
    token,
    "GET",
    "/v1/subscribers/rollup",
  );
}

/** POST /v1/subscribers/{id}/merchant-cancel — reminder-mode only (409 else). */
export function merchantCancelSubscriber(
  apiBase: string,
  token: string,
  subscriptionId: string,
): Promise<SubscriberCancelResponse> {
  return meSessionRequest<SubscriberCancelResponse>(
    apiBase,
    token,
    "POST",
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/merchant-cancel`,
  );
}

/** POST /v1/subscribers/{id}/suspend — any mode; stops dunning, no on-chain. */
export function suspendSubscriber(
  apiBase: string,
  token: string,
  subscriptionId: string,
): Promise<SubscriberCancelResponse> {
  return meSessionRequest<SubscriberCancelResponse>(
    apiBase,
    token,
    "POST",
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/suspend`,
  );
}

/** POST /v1/subscribers/{id}/manage-link — mint a short-lived manage URL. */
export function mintManageLink(
  apiBase: string,
  token: string,
  subscriptionId: string,
  ttlSeconds?: number,
): Promise<ManageLinkResponse> {
  return meSessionRequest<ManageLinkResponse>(
    apiBase,
    token,
    "POST",
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/manage-link`,
    ttlSeconds !== undefined ? { ttl_seconds: ttlSeconds } : {},
  );
}

/**
 * POST /v1/subscribers/{id}/period-cap — set/raise the buyer's per-period
 * budget. Manage-token gated (not SIWE): mint a manage token via
 * {@link mintManageLink} first, then pass it here. Metered-per-period only.
 */
export function setPeriodCap(
  apiBase: string,
  token: string,
  subscriptionId: string,
  manageToken: string,
  newCapUsdc: string,
): Promise<PeriodCapResult> {
  return meSessionRequest<PeriodCapResult>(
    apiBase,
    token,
    "POST",
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/period-cap?token=${encodeURIComponent(manageToken)}`,
    { new_cap_usdc: newCapUsdc },
  );
}

export function listPermitCollectable(
  apiBase: string,
  token: string,
  query = "",
): Promise<CollectableResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<CollectableResponse>(
    apiBase,
    token,
    "GET",
    `/v1/subscribers/permit/collectable${qs}`,
  );
}

export function listMeteredCollectable(
  apiBase: string,
  token: string,
  query = "",
): Promise<CollectableResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<CollectableResponse>(
    apiBase,
    token,
    "GET",
    `/v1/subscribers/metered/collectable${qs}`,
  );
}

/** POST /v1/subscribers/permit/fire-digest — re-fire the collectable digest. */
export function firePermitDigest(
  apiBase: string,
  token: string,
): Promise<FireDigestResult> {
  return meSessionRequest<FireDigestResult>(
    apiBase,
    token,
    "POST",
    "/v1/subscribers/permit/fire-digest",
  );
}

/**
 * POST /v1/subscribers/{id}/permit/submit — record the on-chain USDC.permit
 * submission tx. Idempotent on (subscription_id, tx_hash); audit-trail only.
 */
export function submitPermit(
  apiBase: string,
  token: string,
  subscriptionId: string,
  txHash: string,
): Promise<PermitSubmitResult> {
  return meSessionRequest<PermitSubmitResult>(
    apiBase,
    token,
    "POST",
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/permit/submit`,
    { tx_hash: txHash },
  );
}

/**
 * Thrown on HTTP **202** "awaiting confirmations": the tx is mined but not at
 * the server's required confirmation depth, so NOTHING is booked and the
 * caller MUST keep polling the same tx (XEN-574). A 2xx that is not success.
 */
export class ClaimAwaitingConfirmationsError extends Error {
  constructor() {
    super("claim awaiting confirmations");
    this.name = "ClaimAwaitingConfirmationsError";
  }
}

/**
 * Record the merchant's on-chain USDC.transferFrom so the platform books the
 * permit cycle / settles metered charges. Cannot go through meSessionRequest
 * because a 202 (mined but below the required confirmation depth) must NOT be
 * treated as success — it means "keep polling the same tx". 402 = a real
 * on-chain revert, 409 = not collectable, 503 = transient RPC.
 */
async function recordCollect(
  apiBase: string,
  token: string,
  path: string,
  txHash: string,
): Promise<CollectRecordResult> {
  const res = await fetch(`${apiBase}${path}`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tx_hash: txHash }),
  });
  if (res.status === 401) throw new SessionExpiredError(await errorMessage(res));
  if (res.status === 202) throw new ClaimAwaitingConfirmationsError();
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as CollectRecordResult;
}

export function collectPermit(
  apiBase: string,
  token: string,
  subscriptionId: string,
  txHash: string,
): Promise<CollectRecordResult> {
  return recordCollect(
    apiBase,
    token,
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/permit/collect`,
    txHash,
  );
}

export function collectMetered(
  apiBase: string,
  token: string,
  subscriptionId: string,
  txHash: string,
): Promise<CollectRecordResult> {
  return recordCollect(
    apiBase,
    token,
    `/v1/subscribers/${encodeURIComponent(subscriptionId)}/metered/collect`,
    txHash,
  );
}

// --- Pay-link detail surface, groups, orders, webhooks (XEN-517, SIWE) ------

export function updateLinkMetadata(
  apiBase: string,
  token: string,
  linkId: string,
  body: PayLinkMetadataBody,
): Promise<PayLinkDetail> {
  return meSessionRequest<PayLinkDetail>(
    apiBase,
    token,
    "PATCH",
    `/v1/links/${encodeURIComponent(linkId)}/metadata`,
    body,
  );
}

export function listLinkEvents(
  apiBase: string,
  token: string,
  linkId: string,
  query = "",
): Promise<PayLinkEventsResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<PayLinkEventsResponse>(
    apiBase,
    token,
    "GET",
    `/v1/links/${encodeURIComponent(linkId)}/events${qs}`,
  );
}

export function getLinksRollup(
  apiBase: string,
  token: string,
): Promise<PayLinkRollup> {
  return meSessionRequest<PayLinkRollup>(apiBase, token, "GET", "/v1/links/rollup");
}

export function getLinksSummary(
  apiBase: string,
  token: string,
  query = "",
): Promise<PayLinkSummary> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<PayLinkSummary>(
    apiBase,
    token,
    "GET",
    `/v1/links/summary${qs}`,
  );
}

export function assignLinkGroup(
  apiBase: string,
  token: string,
  linkId: string,
  groupId: string | null,
): Promise<LinkGroupAssignResult> {
  return meSessionRequest<LinkGroupAssignResult>(
    apiBase,
    token,
    "PATCH",
    `/v1/links/${encodeURIComponent(linkId)}/group`,
    { group_id: groupId },
  );
}

export function listGroups(
  apiBase: string,
  token: string,
): Promise<GroupListResponse> {
  return meSessionRequest<GroupListResponse>(apiBase, token, "GET", "/v1/groups");
}

export function createGroup(
  apiBase: string,
  token: string,
  body: GroupCreateBody,
): Promise<Group> {
  return meSessionRequest<Group>(apiBase, token, "POST", "/v1/groups", body);
}

export function updateGroup(
  apiBase: string,
  token: string,
  groupId: string,
  body: GroupUpdateBody,
): Promise<Group> {
  return meSessionRequest<Group>(
    apiBase,
    token,
    "PATCH",
    `/v1/groups/${encodeURIComponent(groupId)}`,
    body,
  );
}

export function deleteGroup(
  apiBase: string,
  token: string,
  groupId: string,
): Promise<void> {
  return meSessionRequest<void>(
    apiBase,
    token,
    "DELETE",
    `/v1/groups/${encodeURIComponent(groupId)}`,
  );
}

export function listOrders(
  apiBase: string,
  token: string,
  query = "",
): Promise<OrderListResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<OrderListResponse>(
    apiBase,
    token,
    "GET",
    `/v1/orders${qs}`,
  );
}

export function shipOrder(
  apiBase: string,
  token: string,
  orderId: string,
  body: ShipOrderBody,
): Promise<Order> {
  return meSessionRequest<Order>(
    apiBase,
    token,
    "POST",
    `/v1/orders/${encodeURIComponent(orderId)}/ship`,
    body,
  );
}

export function exportOrdersCsv(
  apiBase: string,
  token: string,
  query = "",
): Promise<string> {
  const qs = query ? `?${query}` : "";
  return meSessionRequestText(
    apiBase,
    token,
    "GET",
    `/v1/orders/export.csv${qs}`,
  );
}

export function getLinkWebhook(
  apiBase: string,
  token: string,
  linkId: string,
): Promise<WebhookConfig> {
  return meSessionRequest<WebhookConfig>(
    apiBase,
    token,
    "GET",
    `/v1/links/${encodeURIComponent(linkId)}/webhook`,
  );
}

export function putLinkWebhook(
  apiBase: string,
  token: string,
  linkId: string,
  body: WebhookConfigBody,
): Promise<WebhookConfig> {
  return meSessionRequest<WebhookConfig>(
    apiBase,
    token,
    "PUT",
    `/v1/links/${encodeURIComponent(linkId)}/webhook`,
    body,
  );
}

export function rotateLinkWebhookSecret(
  apiBase: string,
  token: string,
  linkId: string,
): Promise<WebhookSecretResult> {
  return meSessionRequest<WebhookSecretResult>(
    apiBase,
    token,
    "POST",
    `/v1/links/${encodeURIComponent(linkId)}/webhook/rotate-secret`,
  );
}

export function testLinkWebhook(
  apiBase: string,
  token: string,
  linkId: string,
): Promise<WebhookDeliveryItem> {
  return meSessionRequest<WebhookDeliveryItem>(
    apiBase,
    token,
    "POST",
    `/v1/links/${encodeURIComponent(linkId)}/webhook/test`,
  );
}

export function listLinkWebhookDeliveries(
  apiBase: string,
  token: string,
  linkId: string,
  query = "",
): Promise<WebhookDeliveriesResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<WebhookDeliveriesResponse>(
    apiBase,
    token,
    "GET",
    `/v1/links/${encodeURIComponent(linkId)}/webhook-deliveries${qs}`,
  );
}

export function retryLinkWebhookDelivery(
  apiBase: string,
  token: string,
  linkId: string,
  deliveryId: string,
): Promise<WebhookDeliveryItem> {
  return meSessionRequest<WebhookDeliveryItem>(
    apiBase,
    token,
    "POST",
    `/v1/links/${encodeURIComponent(linkId)}/webhook-deliveries/${encodeURIComponent(deliveryId)}/retry`,
  );
}

// --- Sites & gating (XEN-517, SIWE: /v1/me/sites/*, /v1/me/publisher/*) -----

export function listMeSites(
  apiBase: string,
  token: string,
): Promise<MeSiteListItem[]> {
  return meSessionRequest<MeSiteListItem[]>(apiBase, token, "GET", "/v1/me/sites");
}

export function createMeSite(
  apiBase: string,
  token: string,
  body: MeSiteCreateBody,
): Promise<MeSiteCreateResponse> {
  return meSessionRequest<MeSiteCreateResponse>(
    apiBase,
    token,
    "POST",
    "/v1/me/sites",
    body,
  );
}

export function getMeSite(
  apiBase: string,
  token: string,
  siteId: string,
): Promise<SiteDetail> {
  return meSessionRequest<SiteDetail>(
    apiBase,
    token,
    "GET",
    `/v1/me/sites/${encodeURIComponent(siteId)}`,
  );
}

export function deleteMeSite(
  apiBase: string,
  token: string,
  siteId: string,
): Promise<void> {
  return meSessionRequest<void>(
    apiBase,
    token,
    "DELETE",
    `/v1/me/sites/${encodeURIComponent(siteId)}`,
  );
}

export function putSitePricing(
  apiBase: string,
  token: string,
  siteId: string,
  body: SitePricingBody,
): Promise<SitePricingResult> {
  return meSessionRequest<SitePricingResult>(
    apiBase,
    token,
    "PUT",
    `/v1/me/sites/${encodeURIComponent(siteId)}/pricing`,
    body,
  );
}

export function putSiteGating(
  apiBase: string,
  token: string,
  siteId: string,
  body: SiteGatingBody,
): Promise<SiteGatingResult> {
  return meSessionRequest<SiteGatingResult>(
    apiBase,
    token,
    "PUT",
    `/v1/me/sites/${encodeURIComponent(siteId)}/gating`,
    body,
  );
}

export function rotateSiteToken(
  apiBase: string,
  token: string,
  siteId: string,
): Promise<RotateTokenResult> {
  return meSessionRequest<RotateTokenResult>(
    apiBase,
    token,
    "POST",
    `/v1/me/sites/${encodeURIComponent(siteId)}/rotate-token`,
  );
}

export function getSiteStats(
  apiBase: string,
  token: string,
  siteId: string,
  query = "",
): Promise<SiteStatsResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<SiteStatsResponse>(
    apiBase,
    token,
    "GET",
    `/v1/me/sites/${encodeURIComponent(siteId)}/stats${qs}`,
  );
}

export function getSiteTransactions(
  apiBase: string,
  token: string,
  siteId: string,
  query = "",
): Promise<SiteTransactionsResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<SiteTransactionsResponse>(
    apiBase,
    token,
    "GET",
    `/v1/me/sites/${encodeURIComponent(siteId)}/transactions${qs}`,
  );
}

export function getSiteCategoryBreakdown(
  apiBase: string,
  token: string,
  siteId: string,
): Promise<CategoryBreakdownResponse> {
  return meSessionRequest<CategoryBreakdownResponse>(
    apiBase,
    token,
    "GET",
    `/v1/me/sites/${encodeURIComponent(siteId)}/category-breakdown`,
  );
}

export function getPublisherGating(
  apiBase: string,
  token: string,
): Promise<PublisherGating> {
  return meSessionRequest<PublisherGating>(
    apiBase,
    token,
    "GET",
    "/v1/me/publisher/gating",
  );
}

export function putPublisherGating(
  apiBase: string,
  token: string,
  body: PublisherGatingBody,
): Promise<PublisherGating> {
  return meSessionRequest<PublisherGating>(
    apiBase,
    token,
    "PUT",
    "/v1/me/publisher/gating",
    body,
  );
}

export function createSiteClaim(
  apiBase: string,
  token: string,
  body: SiteClaimBody,
): Promise<SiteClaimResult> {
  return meSessionRequest<SiteClaimResult>(
    apiBase,
    token,
    "POST",
    "/v1/me/site-claims",
    body,
  );
}

export function getBotActivity(
  apiBase: string,
  token: string,
  query = "",
): Promise<BotActivityResponse> {
  const qs = query ? `?${query}` : "";
  return meSessionRequest<BotActivityResponse>(
    apiBase,
    token,
    "GET",
    `/v1/me/publisher/bot-activity${qs}`,
  );
}

/** GET /v1/bot-catalog — public, no auth. The full bot signature catalog. */
export async function getBotCatalog(
  apiBase: string,
): Promise<BotCatalogResponse> {
  const res = await fetch(`${apiBase}/v1/bot-catalog`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as BotCatalogResponse;
}

// --- Account & identity: wallets, keys, invites, email, earnings (XEN-517) --

export function listWallets(
  apiBase: string,
  token: string,
): Promise<MeWalletsListResponse> {
  return meSessionRequest<MeWalletsListResponse>(apiBase, token, "GET", "/v1/me/wallets");
}

/** POST /v1/me/wallets/link/nonce — session-authed SIWE nonce for linking. */
export function walletLinkNonce(
  apiBase: string,
  token: string,
): Promise<SiweNonceResponse> {
  return meSessionRequest<SiweNonceResponse>(
    apiBase,
    token,
    "POST",
    "/v1/me/wallets/link/nonce",
  );
}

/** POST /v1/me/wallets/link/verify — attach the newly signed wallet. */
export function walletLinkVerify(
  apiBase: string,
  token: string,
  message: string,
  signature: string,
  label?: string | null,
): Promise<LinkVerifyResponse> {
  return meSessionRequest<LinkVerifyResponse>(
    apiBase,
    token,
    "POST",
    "/v1/me/wallets/link/verify",
    { message, signature, ...(label !== undefined ? { label } : {}) },
  );
}

export function unlinkWallet(
  apiBase: string,
  token: string,
  address: string,
): Promise<void> {
  return meSessionRequest<void>(
    apiBase,
    token,
    "DELETE",
    `/v1/me/wallets/${encodeURIComponent(address)}`,
  );
}

export function setWalletLabel(
  apiBase: string,
  token: string,
  address: string,
  label: string | null,
): Promise<void> {
  return meSessionRequest<void>(
    apiBase,
    token,
    "PUT",
    `/v1/me/wallets/${encodeURIComponent(address)}/label`,
    { label },
  );
}

export function transferOwner(
  apiBase: string,
  token: string,
  newOwner: string,
): Promise<OwnerTransferResult> {
  return meSessionRequest<OwnerTransferResult>(
    apiBase,
    token,
    "POST",
    "/v1/me/wallets/owner",
    { new_owner: newOwner },
  );
}

export function createMerchantKey(
  apiBase: string,
  token: string,
  label: string | null,
): Promise<MerchantApiKeyIssued> {
  return meSessionRequest<MerchantApiKeyIssued>(
    apiBase,
    token,
    "POST",
    "/v1/me/merchant/keys",
    { label },
  );
}

export function listMerchantKeys(
  apiBase: string,
  token: string,
): Promise<MerchantApiKeySummary[]> {
  return meSessionRequest<MerchantApiKeySummary[]>(
    apiBase,
    token,
    "GET",
    "/v1/me/merchant/keys",
  );
}

export function rotateMerchantKey(
  apiBase: string,
  token: string,
  keyId: string,
): Promise<MerchantApiKeyIssued> {
  return meSessionRequest<MerchantApiKeyIssued>(
    apiBase,
    token,
    "POST",
    `/v1/me/merchant/keys/${encodeURIComponent(keyId)}/rotate`,
  );
}

export function revokeMerchantKey(
  apiBase: string,
  token: string,
  keyId: string,
): Promise<void> {
  return meSessionRequest<void>(
    apiBase,
    token,
    "DELETE",
    `/v1/me/merchant/keys/${encodeURIComponent(keyId)}`,
  );
}

export function createInvite(
  apiBase: string,
  token: string,
  body: InviteCreateBody,
): Promise<InviteCreateResult> {
  return meSessionRequest<InviteCreateResult>(
    apiBase,
    token,
    "POST",
    "/v1/me/wallets/invite",
    body,
  );
}

export function listInvites(
  apiBase: string,
  token: string,
): Promise<InvitesListResponse> {
  return meSessionRequest<InvitesListResponse>(
    apiBase,
    token,
    "GET",
    "/v1/me/wallets/invites",
  );
}

export function revokeInvite(
  apiBase: string,
  token: string,
  inviteId: string,
): Promise<void> {
  return meSessionRequest<void>(
    apiBase,
    token,
    "DELETE",
    `/v1/me/wallets/invite/${encodeURIComponent(inviteId)}`,
  );
}

/** POST /v1/auth/siwe/nonce — public. Server-issued single-use SIWE nonce. */
export async function siweNonce(apiBase: string): Promise<SiweNonceResponse> {
  const res = await fetch(`${apiBase}/v1/auth/siwe/nonce`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Failed to get SIWE nonce: ${await errorMessage(res)}`);
  }
  return (await res.json()) as SiweNonceResponse;
}

/** GET /v1/invites/{token} — anonymous join-link preview (404 if dead). */
export async function previewInvite(
  apiBase: string,
  inviteToken: string,
): Promise<InvitePreviewResponse> {
  const res = await fetch(
    `${apiBase}/v1/invites/${encodeURIComponent(inviteToken)}`,
    { headers: { "User-Agent": USER_AGENT } },
  );
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as InvitePreviewResponse;
}

/** POST /v1/invites/redeem — anonymous; the invitee's wallet signs SIWE. */
export async function redeemInvite(
  apiBase: string,
  inviteToken: string,
  message: string,
  signature: string,
): Promise<InviteRedeemResponse> {
  const res = await fetch(`${apiBase}/v1/invites/redeem`, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: JSON.stringify({ token: inviteToken, message, signature }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as InviteRedeemResponse;
}

export function setOnboardingEmail(
  apiBase: string,
  token: string,
  email: string,
): Promise<OnboardingEmailResult> {
  return meSessionRequest<OnboardingEmailResult>(
    apiBase,
    token,
    "POST",
    "/v1/onboarding/email",
    { email },
  );
}

export function verifyOnboardingEmail(
  apiBase: string,
  token: string,
  code: string,
): Promise<OnboardingEmailVerifyResult> {
  return meSessionRequest<OnboardingEmailVerifyResult>(
    apiBase,
    token,
    "POST",
    "/v1/onboarding/email/verify",
    { code },
  );
}

/**
 * POST /v1/assets — multipart image upload (SIWE session). Callers hand us
 * raw bytes; MCP tools accept a URL or base64 (no disk paths over MCP).
 */
export async function uploadAsset(
  apiBase: string,
  token: string,
  bytes: Uint8Array,
  filename: string,
  contentType: string,
): Promise<AssetUploadResponse> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes as BlobPart], { type: contentType }),
    filename,
  );
  const res = await fetch(`${apiBase}/v1/assets`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      Cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
    body: form,
  });
  if (res.status === 401) throw new SessionExpiredError(await errorMessage(res));
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as AssetUploadResponse;
}

export function getEarningsSummary(
  apiBase: string,
  token: string,
): Promise<EarningsSummary> {
  return meSessionRequest<EarningsSummary>(
    apiBase,
    token,
    "GET",
    "/v1/earnings/summary",
  );
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
