import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { XenarchConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

const CONFIG_DIR = join(homedir(), ".xenarch");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const WALLET_FILE = join(CONFIG_DIR, "wallet.json");

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export interface LoadConfigResult {
  config: XenarchConfig;
  walletCreated?: { address: string };
}

export async function loadConfig(): Promise<LoadConfigResult> {
  let config: Partial<XenarchConfig> = {};

  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    config = JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // The CLI (`xenarch agent ...`) writes snake_case keys to the same
  // ~/.xenarch/config.json. Adopt its SIWE session + API base so the MCP
  // control-plane tools ride the CLI's owner session against the same host.
  const rawCfg = config as Record<string, unknown>;
  if (!config.sessionToken && typeof rawCfg.session_token === "string") {
    config.sessionToken = rawCfg.session_token;
  }
  if (
    !config.sessionExpiresAt &&
    typeof rawCfg.session_expires_at === "string"
  ) {
    config.sessionExpiresAt = rawCfg.session_expires_at;
  }
  if (!config.apiBase && typeof rawCfg.api_base === "string") {
    config.apiBase = rawCfg.api_base;
  }

  // The CLI stores the signing key nested under `wallet.private_key` for a
  // local wallet. Adopt it so the MCP signs pay-links with the wallet its
  // SIWE session belongs to — otherwise we fall through to generating a fresh
  // throwaway key below and the platform rejects create with a signature
  // mismatch (recovered != session wallet). A `walletconnect` wallet has no
  // local key, so it's intentionally skipped. XENARCH_PRIVATE_KEY still
  // overrides below for agents that bring their own key.
  if (
    !config.privateKey &&
    rawCfg.wallet &&
    typeof rawCfg.wallet === "object"
  ) {
    const wallet = rawCfg.wallet as Record<string, unknown>;
    if (wallet.type === "local" && typeof wallet.private_key === "string") {
      config.privateKey = wallet.private_key;
    }
  }

  if (!config.privateKey) {
    try {
      const raw = await readFile(WALLET_FILE, "utf-8");
      const wallet = JSON.parse(raw);
      config.privateKey = wallet.privateKey ?? wallet.private_key;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  if (process.env.XENARCH_PRIVATE_KEY) {
    config.privateKey = process.env.XENARCH_PRIVATE_KEY;
  }
  if (process.env.XENARCH_RPC_URL) {
    config.rpcUrl = process.env.XENARCH_RPC_URL;
  }
  if (process.env.XENARCH_API_BASE) {
    config.apiBase = process.env.XENARCH_API_BASE;
  }
  if (process.env.XENARCH_NETWORK) {
    config.network = process.env.XENARCH_NETWORK as "base" | "base-sepolia";
  }
  if (process.env.XENARCH_MAX_PAYMENT_USD) {
    config.maxPaymentUsd = parseFloat(process.env.XENARCH_MAX_PAYMENT_USD);
  }
  if (process.env.XENARCH_SESSION_TOKEN) {
    config.sessionToken = process.env.XENARCH_SESSION_TOKEN;
  }

  let walletCreated: { address: string } | undefined;

  if (!config.privateKey) {
    const { address, privateKey } = await generateWallet();
    config.privateKey = privateKey;
    walletCreated = { address };
  }

  return {
    config: {
      ...DEFAULT_CONFIG,
      ...config,
      privateKey: config.privateKey,
    } as XenarchConfig,
    walletCreated,
  };
}

/**
 * Generate a new wallet and save it to ~/.xenarch/wallet.json.
 * Returns the address. Private key never leaves the local machine.
 */
export async function generateWallet(): Promise<{
  address: string;
  privateKey: string;
}> {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  await ensureConfigDir();
  await writeFile(
    WALLET_FILE,
    JSON.stringify({ privateKey, address: account.address }, null, 2),
    { mode: 0o600 },
  );
  await chmod(WALLET_FILE, 0o600);
  return { address: account.address, privateKey };
}

/**
 * Get the wallet address derived from the configured private key.
 * Replaces the old `createSigner()` ethers helper — payment signing is
 * now handled inside `payAndFetch` via viem + x402-fetch.
 */
export function getWalletAddress(config: XenarchConfig): string {
  return privateKeyToAccount(config.privateKey as `0x${string}`).address;
}

/**
 * Persist a SIWE session to ~/.xenarch/config.json (snake_case, so the
 * Xenarch CLI reads the same session). Merges into the existing config —
 * preserves the wallet/privateKey and every other key. XEN-411.
 */
export async function saveSession(
  sessionToken: string,
  sessionExpiresAt: string,
): Promise<void> {
  await ensureConfigDir();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  raw.session_token = sessionToken;
  raw.session_expires_at = sessionExpiresAt;
  await writeFile(CONFIG_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  await chmod(CONFIG_FILE, 0o600);
}
