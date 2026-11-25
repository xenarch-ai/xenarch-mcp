// Network MCP tools (XEN-718): which networks and stablecoins pay links take.
//
// Signed pay-link params settle in USDC on Base. A link's owner can also take
// USDC on Ethereum, BNB Chain and Monad and USDT on Ethereum, BNB Chain, Monad
// (USDT0) and Tron, per link, unsigned (PUT /v1/links/{id}/networks). Buyers
// then pick the coin and network on the hosted page. Agent x402 payments
// (xenarch_pay / xenarch_pay_link) stay USDC on Base by design (EIP-3009).

import { z } from "zod";
import {
  listNetworks,
  getLinkNetworks,
  putLinkNetworks,
  scanWallet,
  getWalletAddress,
} from "@xenarch/core";
import type { AcceptedNetworks, XenarchConfig } from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

// --- registry (public) -------------------------------------------------------

export const listNetworksSchema = z.object({});
export type ListNetworksInput = z.infer<typeof listNetworksSchema>;
export async function listNetworksTool(_input: ListNetworksInput, config: XenarchConfig) {
  return listNetworks(config.apiBase);
}

// --- per-link setting (owner) ------------------------------------------------

export const getLinkNetworksSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
});
export type GetLinkNetworksInput = z.infer<typeof getLinkNetworksSchema>;
export async function getLinkNetworksTool(input: GetLinkNetworksInput, config: XenarchConfig) {
  return getLinkNetworks(config.apiBase, requireSession(config), input.link_id);
}

const networkChoice = z.object({
  tokens: z
    .array(z.enum(["USDC", "USDT"]))
    .describe("Coins to take on this network. An empty list turns the network off."),
  pay_to: z
    .string()
    .optional()
    .describe("Tron only: the T-address that receives USDT on Tron. EVM networks pay the link's own wallet."),
});

export const setLinkNetworksSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  networks: z
    .record(networkChoice)
    .describe(
      "WHOLE-STATE replace of the link's networks beyond Base USDC, keyed by network " +
        "(ethereum, bnb, monad, tron; see xenarch_list_networks). Example: " +
        '{"ethereum": {"tokens": ["USDC", "USDT"]}, "tron": {"tokens": ["USDT"], "pay_to": "T..."}}. ' +
        "{} goes back to Base USDC only. Base USDC is always on and can't be turned off. " +
        "Read the current setting with xenarch_get_link_networks first so you don't drop a network.",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: changes which coins and networks buyers can pay this link with."),
});
export type SetLinkNetworksInput = z.infer<typeof setLinkNetworksSchema>;

function describeChoice(networks: AcceptedNetworks): string {
  const parts = Object.entries(networks)
    .filter(([, v]) => v.tokens.length > 0)
    .map(([k, v]) => `${v.tokens.join("+")} on ${k}${v.pay_to ? ` (to ${v.pay_to})` : ""}`);
  return parts.length ? `USDC on base, ${parts.join(", ")}` : "USDC on base only";
}

export async function setLinkNetworksTool(input: SetLinkNetworksInput, config: XenarchConfig) {
  const token = requireSession(config);
  const networks = input.networks as AcceptedNetworks;
  if (!input.confirm) {
    return needsConfirmation(
      "set_link_networks",
      `This sets pay-link ${input.link_id} to take: ${describeChoice(networks)}. ` +
        "It replaces the link's whole network setting; open checkouts keep working.",
    );
  }
  try {
    return await putLinkNetworks(config.apiBase, token, input.link_id, networks);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/smart contract/i.test(msg)) {
      // The platform's 409: the link's signed `to` is a contract (a smart
      // wallet) on that EVM network. A smart wallet usually doesn't exist at
      // the same address on another chain, so payments there could be lost.
      throw new Error(
        `${msg} The link's receiving wallet is a smart-contract wallet on that network, and a ` +
          "smart wallet usually doesn't exist at the same address on another chain, so the " +
          "platform refuses it to keep payments from being lost. Create the link from a regular " +
          "(key-held) wallet to take that network, or leave it off.",
      );
    }
    throw err;
  }
}

// --- wallet scan (public) ----------------------------------------------------

export const scanWalletSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id whose networks to check."),
  address: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional()
    .describe("EVM wallet to scan. Omit to scan this agent's own wallet."),
});
export type ScanWalletInput = z.infer<typeof scanWalletSchema>;
export async function scanWalletTool(input: ScanWalletInput, config: XenarchConfig) {
  const address = input.address ?? getWalletAddress(config);
  return scanWallet(config.apiBase, input.link_id, address);
}
