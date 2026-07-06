// Types for the Xenarch payment infrastructure (post-XEN-179 platform contract).
//
// Payments route through any x402 facilitator from a ranked list emitted by
// the platform, settling generic USDC `Transfer(from=payer, to=seller_wallet,
// value)` events on Base. Non-custodial, no intermediary contract.

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const MOCK_USDC_SEPOLIA =
  "0xc5aDdd66Da733101A5468857Aa3C6689Af9d1DDc";

// --- API Types (match xenarch-platform/app/schemas/gates.py) ---

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description?: string;
  mimeType?: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface FacilitatorOption {
  name: string;
  url: string;
  priority: number;
  spec_version: "v1" | "v2";
}

export interface GateResponse {
  gate_id: string;
  x402Version: number;
  accepts: PaymentRequirements[];
  facilitators: FacilitatorOption[];
  seller_wallet: string;
  network: string;
  asset: string;
  expires?: string;
}

export interface VerifiedPaymentResponse {
  gate_id: string;
  status: string;
  tx_hash: string;
  amount_usd: string;
  verified_at: string;
}

export interface PaymentResult {
  txHash: string;
  blockNumber?: number;
  facilitator: string;
}

// --- Config ---

export interface XenarchConfig {
  privateKey: string;
  rpcUrl: string;
  apiBase: string;
  network: "base" | "base-sepolia";
  maxPaymentUsd?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
  // SIWE owner session for the agent control plane (/me/agent/*). Reused
  // from the CLI's `xenarch agent login`, which writes `session_token` to
  // ~/.xenarch/config.json. The MCP can't do interactive WalletConnect
  // signing, so it rides the CLI's session. Optional: only the control-plane
  // tools need it; pay/check tools use the agent wallet.
  sessionToken?: string;
  sessionExpiresAt?: string;
}

export const DEFAULT_CONFIG: Omit<XenarchConfig, "privateKey"> = {
  rpcUrl: "https://mainnet.base.org",
  apiBase: "https://xenarch.dev",
  network: "base",
  // Default per-call payment ceiling for standalone (no-token) use. The $1
  // figure is positioning, not protocol — payment amounts are otherwise
  // unbounded, so an unconfigured agent could drain its wallet in one call to
  // a hostile gate. This local cap is the only ceiling without a token.
  // Override with XENARCH_MAX_PAYMENT_USD; set it to 0 to remove the cap.
  // Managed per-tx / daily / monthly caps live in the dashboard (opt-in via
  // XENARCH_API_TOKEN).
  maxPaymentUsd: 1.0,
};

// --- Agent control plane (SIWE: /v1/me/agent/*) ---
// Mirrors xenarch-platform/app/schemas/agents.py and the CLI client.
// USD amounts are JSON strings (Decimal); treat as strings, never float-math.

export const SESSION_COOKIE_NAME = "xen_session";

export interface MeAgentProfile {
  id: string;
  display_name: string | null;
  label: string | null;
  paused: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentSummary {
  period: string;
  total_usd: string;
  count: number;
  by_source: Record<string, string>;
}

/** GET /caps + the read returned by PUT /caps. `null` on an axis = disabled. */
export interface AgentCaps {
  per_tx_usd: string | null;
  daily_usd: string | null;
  monthly_usd: string | null;
  remaining_today: string | null;
  remaining_month: string | null;
  resets_today_at: string;
  resets_month_at: string;
  updated_at: string | null;
}

/** PUT /caps body — full replace: an omitted axis disables that cap. */
export interface AgentCapsPut {
  per_tx_usd: string | null;
  daily_usd: string | null;
  monthly_usd: string | null;
}

export interface CapResetResult {
  reset_axis: "day" | "month";
  new_remaining: string | null;
  resets_at: string;
}

export type ScopeMode = "allow" | "deny";

export interface ScopeRuleItem {
  id: string;
  pattern: string;
  mode: ScopeMode;
  label: string | null;
  hit_count: number;
  last_hit_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScopeReadResult {
  default_mode: ScopeMode;
  rules: ScopeRuleItem[];
}

/** PUT /scope body — full replace of the rule set. */
export interface ScopeRuleInput {
  pattern: string;
  mode: ScopeMode;
  label?: string | null;
}

export interface PauseResult {
  paused: boolean;
  updated_at: string;
}

export interface AgentApiKeySummary {
  id: string;
  label: string | null;
  hash_preview: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface AgentApiKeyIssued extends AgentApiKeySummary {
  /** Plaintext `xa_live_*` token — returned exactly once. */
  plaintext: string;
}

export interface AgentReceiptItem {
  id: string;
  url: string;
  domain: string;
  amount_usd: string;
  tx_hash: string | null;
  facilitator: string | null;
  source: string;
  status: string;
  paid_at: string;
  created_at: string;
  chain_verified: boolean;
}

export interface AgentReceiptList {
  receipts: AgentReceiptItem[];
  total: number;
  page: number;
  per_page: number;
}

// --- Device-authorization flow (XEN-411): browser login without the CLI ---

export interface DeviceStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DevicePollResponse {
  status: "pending" | "approved" | "expired";
  interval?: number;
  session_token?: string;
  expires_at?: string;
}

// --- Merchant ops (SIWE: /v1/links, /v1/payments, /v1/subscribers,
//     /v1/merchant-profile). Mirrors the platform schemas. ---

export interface PayLinkSchemaField {
  field: string;
  group: string;
  type: string;
  required: boolean;
  state: string;
  prompt: string;
  advanced: boolean;
  enum: string[] | null;
  default: string | null;
  auto_fill: string | null;
  help: string | null;
}

export interface PayLinkSchemaResponse {
  version: string;
  currency: { default: string; supported: string[] };
  network: { default: string; supported: string[] };
  max_amount_usd: string;
  fields: PayLinkSchemaField[];
}

export interface PayLinkFieldIssue {
  field: string;
  message: string;
  prompt?: string | null;
  group?: string | null;
  type?: string | null;
  enum?: string[] | null;
}

export interface PayLinkValidateResponse {
  ok: boolean;
  missing: PayLinkFieldIssue[];
  errors: PayLinkFieldIssue[];
}

export interface LitValue {
  state: "lit";
  value: unknown;
}

export interface PayLinkCreateBody {
  params: Record<string, unknown>;
  nonce: string;
  created_at: number;
  signed_params: string;
}

export interface PayLinkCreateResponse {
  link_id: string;
  link: string;
  qr_png_url: string | null;
  embed_html: string | null;
  webhook_secret: string;
  signed_params: string;
  created_at: string;
}

export interface PayLinkListItem {
  link_id: string;
  created_at: string;
  expires_at: string | null;
  kind: string;
  status: string;
  paid_and_single_use: boolean;
  paid_count: number;
  amount_usd: string | null;
  cadence: string | null;
}

export interface PayLinkListResponse {
  links: PayLinkListItem[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface PayLinkDetail {
  link_id: string;
  kind: string;
  status: string;
  created_at: string;
  expires_at: string | null;
  link?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PayLinkRevokeResponse {
  revoked: boolean;
  link_id: string;
  revoked_at: string | null;
}

export interface MerchantPaymentItem {
  id: string;
  link_id: string;
  tx_hash: string;
  from_address: string;
  amount_usd: string;
  expected_usd: string;
  status: string;
  subscription_id: string | null;
  cycle: number | null;
  created_at: string;
}

export interface MerchantPaymentListResponse {
  payments: MerchantPaymentItem[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface SubscriberListItem {
  subscription_id: string;
  pay_link_id: string;
  payer_email: string | null;
  payer_wallet: string | null;
  mode: "reminder" | "permit" | "stream";
  status: string;
  email_status: string;
  cycles_paid: number;
  next_renewal_at: string | null;
  last_renewal_at: string | null;
  created_at: string;
  amount_usd: string | null;
  cadence: string | null;
  // XEN-611 dunning surface. `collectable` is the sweep-cached affordability
  // verdict (true/false/null=unchecked); `collection_fail_count` is the
  // consecutive due-cycle failure count (0..5). Together they render
  // "dunning (n/5)" without a second fetch. Additive — older servers omit them.
  collectable?: boolean | null;
  collectable_reason?: string | null;
  collection_fail_count?: number;
}

export interface SubscriberListResponse {
  subscribers: SubscriberListItem[];
  has_more: boolean;
  next_cursor: string | null;
}

/**
 * GET /v1/subscribers/{id} owner detail — permissive; we surface key fields +
 * carry the raw body (same shape strategy as {@link PayLinkDetail}).
 */
export interface SubscriberDetail {
  subscription_id: string;
  link_id: string;
  is_metered: boolean;
  status: string;
  mode: "reminder" | "permit" | "stream";
  issuer_name: string | null;
  plan_name: string | null;
  amount_usdc: string | null;
  currency: string;
  cadence: string | null;
  cadence_label: string | null;
  next_renewal_at: string | null;
  last_renewal_at: string | null;
  cycles_paid: number;
  payer_email: string | null;
  payer_wallet: string | null;
  created_at: string;
  [key: string]: unknown;
}

/** One row of the immutable per-subscriber metered charge ledger (XEN-483). */
export interface SubscriberChargeItem {
  charge_seq: number;
  status: "booked" | "settled" | "void";
  accrued_units_billed: string;
  billable_units: string;
  value_usdc: string;
  value_micro_usdc: number;
  booked_at: string;
  tx_hash: string | null;
  settled_at: string | null;
  block_number: number | null;
  basescan_url: string | null;
}

export interface SubscriberChargesResponse {
  subscription_id: string;
  charges: SubscriberChargeItem[];
  has_more: boolean;
  next_cursor: number | null;
  total_charged_micro: number;
  total_collected_micro: number;
  outstanding_micro: number;
}

/** POST /v1/subscribers/{id}/merchant-cancel + /suspend. */
export interface SubscriberCancelResponse {
  subscription_id: string;
  status: string;
}

/** POST /v1/subscribers/{id}/manage-link — short-lived hosted-manage-page URL. */
export interface ManageLinkResponse {
  manage_url: string;
  manage_token: string;
  expires_at: string;
}

/** GET /v1/subscribers/rollup — subscriber KPIs hero. */
export interface SubscribersRollup {
  active: number;
  mrr_usdc: string;
  churn_30d: number | null;
}

/** POST /v1/subscribers/{id}/period-cap result. */
export interface PeriodCapResult {
  subscription_id: string;
  status: string;
  period_cap_micro: number | null;
  period_cap_usdc: string;
  exceeds_permit_runway: boolean;
  remaining_permit_micro: number;
}

/**
 * GET /v1/subscribers/permit|metered/collectable — the "collectable bag".
 * Read-only: Xenarch never submits the on-chain transferFrom. Rows are
 * permissive (permit vs metered rows differ); we surface the key fields.
 * Permit rows also carry the buyer's stored `permit` (signature, value,
 * nonce, deadline, submitted) so the merchant can broadcast USDC.permit.
 */
export interface CollectableRow {
  subscription_id: string;
  pay_link_id: string;
  payer_email: string | null;
  payer_wallet: string | null;
  to: string;
  transfer_from: { owner: string | null; spender: string | null; value: number };
  permit?: {
    signature: string | null;
    value: number | null;
    nonce: number | null;
    deadline: number | null;
    submitted: boolean;
  };
  [key: string]: unknown;
}

export interface CollectableResponse {
  collectable: CollectableRow[];
  count: number;
  total_micro: number;
}

/**
 * POST /v1/subscribers/{id}/permit|metered/collect result — the booked cycle /
 * settled charges after the merchant's on-chain transferFrom is recorded.
 * Permissive: we surface the key fields and carry the raw body.
 */
export interface CollectRecordResult {
  subscription_id?: string;
  status?: string;
  cycle?: number | null;
  tx_hash?: string;
  value_usdc?: string;
  [key: string]: unknown;
}

/** POST /v1/subscribers/{id}/permit/submit — permit-submission audit record. */
export interface PermitSubmitResult {
  subscription_id: string;
  permit_submitted_tx_hash: string | null;
  permit_submitted_at: string | null;
}

/** POST /v1/subscribers/permit/fire-digest — dev/test digest re-fire. */
export interface FireDigestResult {
  sent: boolean;
  subscribers: number;
  total_micro: number;
}

export interface MerchantProfileBody {
  issuer_name?: string | null;
  issuer_logo_url?: string | null;
  issuer_address?: string | null;
  issuer_tax_id?: string | null;
  issuer_email?: string | null;
  merchant_site?: string | null;
  brand_color?: string | null;
  collection_rhythm?: "daily" | "weekly" | "monthly" | "never" | null;
}

export interface MerchantProfileResponse extends MerchantProfileBody {
  id: string;
  identity_id: string;
  updated_at: string;
  verification_token: string;
  domain_verified_at: string | null;
}

export interface PayLinkInitiateResponse {
  x402Version: number;
  accepts: PaymentRequirements[];
  facilitators: FacilitatorOption[];
  link_id: string;
  network: string;
  asset: string;
  protocol: string;
  expires: string | null;
  error: string | null;
}

export interface PayLinkClaimResponse {
  attempt_id: string;
  tx_hash: string;
  status: "confirmed" | "underpaid" | "overpaid";
  value_usdc: string;
  expected_usdc: string;
  block_number: number;
  paid_and_single_use: boolean;
  created: boolean;
  manage_url: string | null;
}

// --- Pay-link detail surface, groups, orders, webhooks (XEN-517, SIWE) ------

export interface PayLinkEventItem {
  event_type: string;
  payload: Record<string, unknown> | null;
  created_at: string;
}

export interface PayLinkEventsResponse {
  events: PayLinkEventItem[];
  next_cursor: string | null;
}

/** GET /v1/links/rollup — merchant pay-link KPIs. */
export interface PayLinkRollup {
  paid_24h: number;
  paid_total: number;
  mtd_revenue_usdc: string;
  views: number;
  conversion: number | null;
}

/** GET /v1/links/summary?period=… */
export interface PayLinkSummary {
  period: string;
  revenue_usd: string;
  paid_count: number;
  link_count: number;
}

/** PATCH /v1/links/{id}/metadata body (whole-state; null clears). */
export interface PayLinkMetadataBody {
  metadata: Record<string, unknown> | null;
}

/** PATCH /v1/links/{id}/group result. */
export interface LinkGroupAssignResult {
  link_id: string;
  group_id: string | null;
}

export interface Group {
  id: string;
  name: string;
  accent_kind: string;
  position: number;
  created_at: string;
  updated_at: string;
  member_link_ids: string[];
  member_count: number;
}

export interface GroupCreateBody {
  name: string;
  accent_kind?: string;
}

export interface GroupUpdateBody {
  name?: string;
  accent_kind?: string;
  position?: number;
}

export interface GroupListResponse {
  groups: Group[];
}

export interface Order {
  order_id: string;
  link_id: string;
  product_name: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  shipping_address: string | null;
  destination: string | null;
  amount_usd: string;
  status: string;
  tracking: string | null;
  tx_hash: string;
  paid_at: string;
}

export interface OrderListResponse {
  orders: Order[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ShipOrderBody {
  tracking: string;
  carrier?: string;
}

/** GET/PUT /v1/links/{id}/webhook. */
export interface WebhookConfig {
  url: string | null;
  event_types: string[] | null;
  enabled: boolean;
  available_event_types: string[];
}

export interface WebhookConfigBody {
  url: string;
  event_types?: string[] | null;
  enabled: boolean;
}

export interface WebhookSecretResult {
  webhook_secret: string;
}

export interface WebhookDeliveryItem {
  id: string;
  event_type: string;
  attempted_at: string;
  dest_url: string;
  http_status: number | null;
  latency_ms: number;
  retry_count: number;
  error_message: string | null;
  status: string;
}

export interface WebhookDeliveriesResponse {
  deliveries: WebhookDeliveryItem[];
}

// --- Agent profile + webhooks (XEN-517, SIWE: /v1/me/agent/*) ---------------

/** PUT /v1/me/agent body — agent display profile. */
export interface MeAgentUpdateBody {
  display_name?: string | null;
  label?: string | null;
}

/** GET/PUT /v1/me/agent/webhooks. Note: differs from the pay-link shape. */
export interface AgentWebhookConfig {
  configured: boolean;
  url: string | null;
  event_types: string[] | null;
  enabled: boolean;
  available_event_types: string[];
}

export interface AgentWebhookConfigBody {
  url: string;
  event_types?: string[] | null;
  enabled: boolean;
}

/** POST /v1/me/agent/webhooks/rotate-secret — note `secret`, not webhook_secret. */
export interface AgentWebhookSecretResult {
  secret: string;
}

export interface AgentWebhookDeliveryItem {
  id: string;
  event_type: string;
  attempted_at: string;
  dest_url: string;
  http_status: number | null;
  latency_ms: number;
  retry_count: number;
  status: string;
  error_message: string | null;
}

export interface AgentWebhookDeliveriesResponse {
  deliveries: AgentWebhookDeliveryItem[];
}

// --- Sites & gating (XEN-517, SIWE: /v1/me/sites/*, /v1/me/publisher/*) -----
// Money fields (default_price_usd, price_usd, amount_usd) arrive as JSON
// strings (Decimal); gated_categories maps a category name → gated bool.

/** GET /v1/me/sites — one row. `domain` is null for unclaimed Path-B sites. */
export interface MeSiteListItem {
  id: string;
  domain: string | null;
  default_price_usd: string;
  created_at: string;
  integration_type: string | null;
  gating_enabled: boolean;
}

/** POST /v1/me/sites body. */
export interface MeSiteCreateBody {
  integration_type: "wp" | "joomla" | "cf" | "sdk" | "cli" | "custom";
  domain?: string | null;
}

export interface MeSiteCreateResponse {
  id: string;
  site_token: string;
  domain: string | null;
  integration_type: string;
  created_at: string;
}

export interface PriceRuleItem {
  path: string;
  price_usd: string;
  billing_scope: "page" | "path";
}

/** GET /v1/me/sites/{id} — full owner detail (gating + pricing + rules). */
export interface SiteDetail {
  id: string;
  domain: string | null;
  default_price_usd: string;
  default_billing_scope: string;
  integration_type: string | null;
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  site_token_hash: string;
  created_at: string;
  use_publisher_defaults: boolean;
  rules: PriceRuleItem[];
}

/** PUT /v1/me/sites/{id}/pricing body (full replace). */
export interface SitePricingBody {
  default_price_usd: string;
  default_billing_scope: "page" | "path";
  rules: PriceRuleItem[];
}

export interface SitePricingResult {
  rules_applied: number;
}

/** PUT /v1/me/sites/{id}/gating body (full replace). */
export interface SiteGatingBody {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  use_publisher_defaults: boolean;
}

export interface SiteGatingResult {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  use_publisher_defaults: boolean;
}

export interface RotateTokenResult {
  site_token: string;
}

export interface SiteTransactionItem {
  id: string;
  type: string;
  path: string;
  agent_name: string | null;
  amount_usd: string;
  status: string;
  created_at: string;
}

export interface SiteTransactionsResponse {
  transactions: SiteTransactionItem[];
  total: number;
  page: number;
  per_page: number;
}

export interface CategoryBreakdownResponse {
  categories: Array<{ category: string; earned_usd: string }>;
}

/**
 * GET /v1/me/sites/{id}/stats — time-BUCKETED shape (SiteStatsBucketedResponse).
 * Distinct from the legacy pk_-token /v1/sites/{id}/stats shape.
 */
export interface SiteStatsBucket {
  earned_usd: string;
  requests: number;
  paid: number;
}

export interface SiteStatsResponse {
  today: SiteStatsBucket;
  month: SiteStatsBucket;
  all_time: SiteStatsBucket;
}

/** GET/PUT /v1/me/publisher/gating — publisher-level gating defaults. */
export interface PublisherGating {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  bot_overrides: Record<string, string>;
  publisher_id: string;
}

/** PUT body — `bot_overrides` omitted preserves the existing map. */
export interface PublisherGatingBody {
  gating_enabled: boolean;
  gated_categories: Record<string, boolean>;
  bot_overrides?: Record<string, string>;
}

/** POST /v1/me/site-claims body + response. */
export interface SiteClaimBody {
  integration_type: "wp" | "joomla" | "cf" | "sdk" | "cli" | "custom";
  domain: string;
}

export interface SiteClaimResult {
  site_id: string;
  claim_token: string;
  domain: string;
  integration_type: string;
  expires_in: number;
}

// --- Bots (GET /v1/bot-catalog public; /v1/me/publisher/bot-activity SIWE) ---

export interface BotCatalogResponse {
  categories: string[];
  signatures: Array<{ name: string; category: string; company: string }>;
  count: number;
}

export interface BotActivityItem {
  signature: string;
  category: string;
  company: string;
  sites_seen: number;
  hit_count: number;
  last_seen: string;
  first_seen: string;
}

export interface BotActivityResponse {
  activity: BotActivityItem[];
  total_signatures: number;
  window_days: number;
}

// --- Account & identity: wallets, keys, invites, email, earnings (XEN-517) --

export interface SiweNonceResponse {
  nonce: string;
  issued_at: string;
  expires_at: string;
}

/** GET /v1/me/wallets — one linked wallet. */
export interface LinkedWalletItem {
  address: string;
  verified_at: string;
  is_primary: boolean;
  eligible_at: string;
  eligible: boolean;
  is_default: boolean;
  is_owner: boolean;
  label: string | null;
}

export interface MeWalletsListResponse {
  wallets: LinkedWalletItem[];
}

/** POST /v1/me/wallets/link/verify — the newly linked wallet. */
export interface LinkVerifyResponse {
  address: string;
  verified_at: string;
}

export interface OwnerTransferResult {
  owner_wallet: string;
}

/** GET/POST/rotate /v1/me/merchant/keys. */
export interface MerchantApiKeySummary {
  id: string;
  label: string | null;
  hash_preview: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface MerchantApiKeyIssued extends MerchantApiKeySummary {
  /** Plaintext `xm_live_*` token — returned once. */
  plaintext: string;
}

/** POST /v1/me/wallets/invite. */
export interface InviteCreateBody {
  label?: string | null;
  role?: "viewer" | "operator" | "full_co_owner";
}

export interface InviteCreateResult {
  token: string;
  join_url: string;
  expires_at: string;
  label: string | null;
  role: string;
}

export interface InviteItem {
  id: string;
  label: string | null;
  role: string;
  created_by_wallet: string;
  created_at: string;
  expires_at: string;
}

export interface InvitesListResponse {
  invites: InviteItem[];
}

/** GET /v1/invites/{token} — anonymous join-link preview. */
export interface InvitePreviewResponse {
  issuer_name: string | null;
  label: string | null;
  role: string;
  expires_at: string;
}

/** POST /v1/invites/redeem — the wallet that joined. */
export interface InviteRedeemResponse {
  address: string;
  verified_at: string;
}

/** POST /v1/onboarding/email(+/verify). */
export interface OnboardingEmailResult {
  email: string;
  sent: boolean;
}

export interface OnboardingEmailVerifyResult {
  identity_id: string;
  email: string;
  email_verified_at: string;
}

/** POST /v1/assets — public CDN URL of the stored image. */
export interface AssetUploadResponse {
  url: string;
}

/** GET /v1/earnings/summary. */
export interface EarningsBucket {
  earned_usd: string;
  payment_count: number;
}

export interface EarningsSummary {
  today: EarningsBucket;
  month: EarningsBucket;
  all_time: EarningsBucket;
}
