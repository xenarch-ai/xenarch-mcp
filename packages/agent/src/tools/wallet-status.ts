import { z } from "zod";
import { createPublicClient, http, formatUnits, erc20Abi, type Hex } from "viem";
import { getWalletAddress, USDC_BASE, MOCK_USDC_SEPOLIA } from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";

// Re-discoverable wallet info. The agent's spending-wallet address is surfaced
// only once at creation (server.ts consumeWalletNotice); this tool lets the
// agent re-read it any time — plus the live USDC balance — so the user can
// find where to top up. Balance is read straight from the USDC contract on the
// configured RPC; a read failure degrades gracefully (balance_error, non-fatal).
export const walletStatusSchema = z.object({});

export type WalletStatusInput = z.infer<typeof walletStatusSchema>;

export async function walletStatus(
  _input: WalletStatusInput,
  config: XenarchConfig,
) {
  const address = getWalletAddress(config) as Hex;
  const usdcAddress = (
    config.network === "base-sepolia" ? MOCK_USDC_SEPOLIA : USDC_BASE
  ) as Hex;

  let usdcBalance: string | null = null;
  let balanceError: string | null = null;
  try {
    const client = createPublicClient({ transport: http(config.rpcUrl) });
    const raw = (await client.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    })) as bigint;
    usdcBalance = formatUnits(raw, 6);
  } catch (err) {
    balanceError = err instanceof Error ? err.message : String(err);
  }

  const funded = usdcBalance != null && parseFloat(usdcBalance) > 0;
  return {
    wallet_address: address,
    network: config.network,
    usdc_balance: usdcBalance,
    funded,
    balance_error: balanceError,
    fund_instructions: `Send USDC to ${address} on Base — USDC only, no ETH or other gas coin needed.`,
    note:
      "This is the agent's local spending wallet (its key lives in " +
      "~/.xenarch/wallet.json and signs every payment). It is SEPARATE from the " +
      "wallet you sign in to the dashboard with — keep here only what you're " +
      "willing to let the agent spend.",
  };
}
