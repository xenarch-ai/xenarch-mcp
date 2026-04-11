import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";
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

  let configCache: XenarchConfig | null = null;

  async function getConfig(): Promise<XenarchConfig> {
    if (!configCache) {
      configCache = await loadConfig();
    }
    return configCache;
  }

  server.tool(
    "xenarch_check_gate",
    "Check if a URL or domain has a Xenarch payment gate. Returns pricing, payment instructions, and gate details.",
    checkGateSchema.shape,
    { title: "Check Payment Gate", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await checkGate(input, config);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
    "Pay for gated content or a service via Xenarch. Executes a USDC micropayment on Base through the splitter contract. Returns a transaction hash and access token.",
    paySchema.shape,
    { title: "Pay for Content", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await pay(input, config);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
    "View your Xenarch payment history. Shows past micropayments made by this wallet, optionally filtered by domain.",
    getHistorySchema.shape,
    { title: "View Payment History", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await getHistory(input, config);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
