// Contract constants and types for Xenarch payment infrastructure

// --- Contract Addresses (Base Mainnet) ---

export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export const SPLITTER_ADDRESS_MAINNET =
  "0xC6D3a6B6fcCD6319432CDB72819cf317E88662ae";

// --- Contract Addresses (Base Sepolia) ---

export const SPLITTER_ADDRESS_SEPOLIA =
  "0x7ecfe8f83eab6ba170063d1f1fe7c33695a9ce1d";

export const MOCK_USDC_SEPOLIA =
  "0xc5aDdd66Da733101A5468857Aa3C6689Af9d1DDc";

// --- ABIs ---

export const SPLITTER_ABI = [
  "function split(address collector, uint256 amount) external",
  "event Split(address indexed collector, uint256 gross, uint256 fee, uint256 net)",
] as const;

export const USDC_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
] as const;

// --- API Types ---

export interface GateResponse {
  xenarch: boolean;
  gate_id: string;
  price_usd: string;
  splitter: string;
  collector: string;
  network: string;
  asset: string;
  protocol: string;
  verify_url: string;
  expires: string;
}

export interface GateVerifyResponse {
  access_token: string;
  expires_at: string;
}

export interface PaymentResult {
  txHash: string;
  blockNumber: number;
}

// --- Config ---

export interface XenarchConfig {
  privateKey: string;
  rpcUrl: string;
  apiBase: string;
  network: "base" | "base-sepolia";
  autoApproveMaxUsd?: number;
  allowedDomains?: string[];
  blockedDomains?: string[];
}

export const DEFAULT_CONFIG: Omit<XenarchConfig, "privateKey"> = {
  rpcUrl: "https://mainnet.base.org",
  apiBase: "https://api.xenarch.dev",
  network: "base",
};
