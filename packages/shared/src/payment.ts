import { ethers } from "ethers";
import type { GateResponse, PaymentResult } from "./types.js";
import { USDC_ABI, SPLITTER_ABI } from "./types.js";

/**
 * Execute a USDC payment through the Xenarch splitter contract.
 * Flow: check balance → check gas → approve USDC → call split()
 */
export async function executePayment(
  gate: GateResponse,
  signer: ethers.Signer,
  usdcAddress: string,
): Promise<PaymentResult> {
  const address = await signer.getAddress();
  const provider = signer.provider!;

  const usdc = new ethers.Contract(usdcAddress, USDC_ABI, signer);
  const splitter = new ethers.Contract(gate.splitter, SPLITTER_ABI, signer);

  // USDC has 6 decimals
  const amount = ethers.parseUnits(gate.price_usd, 6);

  // 1. Check balance
  const balance = (await usdc.balanceOf(address)) as bigint;
  if (balance < amount) {
    throw new Error(
      `Insufficient USDC. Have ${ethers.formatUnits(balance, 6)}, need ${gate.price_usd}`,
    );
  }

  // 2. Check ETH for gas
  const ethBalance = await provider.getBalance(address);
  if (ethBalance === 0n) {
    throw new Error(
      "No ETH for gas. Send some ETH (Base) to your wallet to cover transaction fees.",
    );
  }

  // 3. Check and set allowance — approve max to avoid repeated approvals
  const allowance = (await usdc.allowance(address, gate.splitter)) as bigint;
  if (allowance < amount) {
    const approveTx = await usdc.approve(gate.splitter, ethers.MaxUint256);
    await approveTx.wait(2);
  }

  // 4. Call split
  const splitTx = await splitter.split(gate.collector, amount);
  const receipt = await splitTx.wait(1);

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
  };
}

/**
 * Verify a payment with the Xenarch platform and get an access token.
 */
export async function verifyPayment(
  verifyUrl: string,
  txHash: string,
): Promise<{ access_token: string; expires_at: string }> {
  const res = await fetch(verifyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx_hash: txHash }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => res.statusText);
    throw new Error(`Payment verification failed: ${msg}`);
  }

  return (await res.json()) as { access_token: string; expires_at: string };
}
