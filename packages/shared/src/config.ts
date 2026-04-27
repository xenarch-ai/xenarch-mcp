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
