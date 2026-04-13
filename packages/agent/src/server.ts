import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "@xenarch/core";
import type { XenarchConfig, LoadConfigResult } from "@xenarch/core";
import { checkGateSchema, checkGate } from "./tools/check-gate.js";
import { paySchema, pay } from "./tools/pay.js";
import { getHistorySchema, getHistory } from "./tools/get-history.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "xenarch",
    version: "0.1.0",
  });

  server.resource(
    "pricing-info",
    "xenarch://pricing",
    { description: "How Xenarch micropayments work: pricing model, supported networks, and payment flow." },
    async () => ({
      contents: [
        {
          uri: "xenarch://pricing",
          text: JSON.stringify({
            description: "Xenarch routes USDC micropayments (max $1) between AI agents and content/service providers on Base L2.",
            supported_networks: ["base", "base-sepolia"],
            supported_assets: ["USDC"],
            protocol: "x402",
            max_payment_usd: 1.0,
            flow: [
              "1. Agent calls xenarch_check_gate to discover if a URL has a payment gate",
              "2. Gate returns price, splitter contract address, and payment details",
              "3. Agent calls xenarch_pay to execute the USDC payment on-chain",
              "4. Platform verifies the transaction and returns an access token",
              "5. Agent uses the access token to access the gated content",
            ],
          }, null, 2),
          mimeType: "application/json",
        },
      ],
    }),
  );

  server.prompt(
    "pay-for-content",
    "Step-by-step guide for paying to access gated content via Xenarch",
    { url: z.string().describe("The URL to check and pay for") },
    ({ url }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I want to access the content at ${url}. Please:\n1. First check if it has a Xenarch payment gate using xenarch_check_gate\n2. If gated, show me the price and ask for confirmation\n3. Once confirmed, pay using xenarch_pay\n4. Return the access token so I can access the content`,
          },
        },
      ],
    }),
  );

  let configResult: LoadConfigResult | null = null;

  async function getConfig(): Promise<XenarchConfig> {
    if (!configResult) {
      configResult = await loadConfig();
    }
    return configResult.config;
  }

  function consumeWalletNotice(): string | null {
    if (!configResult?.walletCreated) return null;
    const addr = configResult.walletCreated.address;
    const notice = `A new Xenarch wallet was just created: ${addr}\n` +
      `It has no funds yet. To make payments, the user needs to send USDC and a small amount of ETH (for gas) to this address on Base.\n` +
      `Wallet saved to ~/.xenarch/wallet.json\n` +
      `IMPORTANT: Tell the user about this new wallet and that they need to fund it before payments will work.`;
    configResult.walletCreated = undefined;
    return notice;
  }

  function withWalletNotice(content: Array<{ type: "text"; text: string }>): Array<{ type: "text"; text: string }> {
    const notice = consumeWalletNotice();
    if (!notice) return content;
    return [{ type: "text" as const, text: notice }, ...content];
  }

  server.tool(
    "xenarch_check_gate",
    "Check if a URL or domain has an x402 payment gate. Returns gate status, price in USD, USDC splitter contract address, collector wallet, network (Base or Base Sepolia), asset, and protocol. Use this before paying to confirm pricing, when a URL returns HTTP 402 Payment Required, or when a user asks whether content is paywalled.",
    checkGateSchema.shape,
    { title: "Check Payment Gate", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await checkGate(input, config);
        return {
          content: withWalletNotice([{ type: "text", text: JSON.stringify(result, null, 2) }]),
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error checking gate: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "xenarch_pay",
    "Execute a USDC micropayment on Base L2 to access x402-gated content or an API. Checks USDC balance first, then sends payment through a verified Xenarch splitter contract, waits for on-chain confirmation, and returns a transaction hash, block number, amount paid, and a time-limited Bearer access token to unlock the resource. Optionally override the gate price with a custom amount. Use this after xenarch_check_gate confirms a gate exists, or when a user asks to pay for or unlock gated content.",
    paySchema.shape,
    { title: "Pay for Content", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await pay(input, config);
        return {
          content: withWalletNotice([{ type: "text", text: JSON.stringify(result, null, 2) }]),
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error executing payment: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    "xenarch_get_history",
    "List past USDC micropayments made by this wallet through Xenarch. Returns transaction hashes, URLs, domains, amounts in USD, timestamps, total spend, and payment count. Optionally filter by domain. Use this to audit spending, check if you already paid for a resource, or track agent expenditure.",
    getHistorySchema.shape,
    { title: "View Payment History", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await getHistory(input, config);
        return {
          content: withWalletNotice([{ type: "text", text: JSON.stringify(result, null, 2) }]),
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting history: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
