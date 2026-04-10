import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
