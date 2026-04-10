import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ethers } from "ethers";
import type { XenarchConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

const CONFIG_DIR = join(homedir(), ".xenarch");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const WALLET_FILE = join(CONFIG_DIR, "wallet.json");

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

export async function loadConfig(): Promise<XenarchConfig> {
  let config: Partial<XenarchConfig> = {};

  // Read config file
  try {
    const raw = await readFile(CONFIG_FILE, "utf-8");
    config = JSON.parse(raw);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Read wallet file if no private key in config
  if (!config.privateKey) {
    try {
      const raw = await readFile(WALLET_FILE, "utf-8");
      const wallet = JSON.parse(raw);
      config.privateKey = wallet.privateKey ?? wallet.private_key;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  // Override from environment variables
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
  if (process.env.XENARCH_AUTO_APPROVE_MAX) {
    config.autoApproveMaxUsd = parseFloat(process.env.XENARCH_AUTO_APPROVE_MAX);
  }

  if (!config.privateKey) {
    // Auto-generate wallet on first use
    const { address, privateKey } = await generateWallet();
    config.privateKey = privateKey;
    console.error(
      `Created new Xenarch wallet: ${address}\n` +
        `Saved to: ~/.xenarch/wallet.json\n\n` +
        `Fund this wallet with USDC on Base to start paying.\n` +
        `You also need a small amount of ETH on Base for gas.`,
    );
  }

  return {
    ...DEFAULT_CONFIG,
    ...config,
    privateKey: config.privateKey,
  } as XenarchConfig;
}

/**
 * Generate a new wallet and save it to ~/.xenarch/wallet.json.
 * Returns the address. Private key never leaves the local machine.
 */
export async function generateWallet(): Promise<{
  address: string;
  privateKey: string;
}> {
  const wallet = ethers.Wallet.createRandom();
  await ensureConfigDir();
  await writeFile(
    WALLET_FILE,
    JSON.stringify(
      { privateKey: wallet.privateKey, address: wallet.address },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await chmod(WALLET_FILE, 0o600);
  return { address: wallet.address, privateKey: wallet.privateKey };
}

export function createSigner(config: XenarchConfig): ethers.Wallet {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  return new ethers.Wallet(config.privateKey, provider);
}
