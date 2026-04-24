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
}

export const DEFAULT_CONFIG: Omit<XenarchConfig, "privateKey"> = {
  rpcUrl: "https://mainnet.base.org",
  apiBase: "https://xenarch.dev",
  network: "base",
};
