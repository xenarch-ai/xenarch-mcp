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
