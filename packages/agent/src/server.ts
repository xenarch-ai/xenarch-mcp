import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "@xenarch/core";
import type { XenarchConfig, LoadConfigResult } from "@xenarch/core";
import { checkGateSchema, checkGate } from "./tools/check-gate.js";
import { paySchema, pay } from "./tools/pay.js";
import { getHistorySchema, getHistory } from "./tools/get-history.js";
import { walletStatusSchema, walletStatus } from "./tools/wallet-status.js";
import * as cp from "./tools/control-plane.js";
import * as login from "./tools/login.js";
import * as merchant from "./tools/merchant.js";
import * as payLink from "./tools/pay-link.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "xenarch",
    version: "1.0.0",
  });

  server.resource(
    "pricing-info",
    "xenarch://pricing",
    {
      description:
        "How Xenarch micropayments work: pricing model, supported networks, and payment flow.",
    },
    async () => ({
      contents: [
        {
          uri: "xenarch://pricing",
          text: JSON.stringify(
            {
              description:
                "Non-custodial x402 MCP server. AI agents pay HTTP 402–gated APIs with USDC on Base L2, settled agent-to-publisher direct on-chain. 0% Xenarch fee — no Xenarch contract in the money flow. The agent wallet only ever holds USDC; no ETH or other gas coin needed. A local per-call cap (default $1, set XENARCH_MAX_PAYMENT_USD to change; 0 disables) guards standalone use; connect XENARCH_API_TOKEN for managed per-tx/daily/monthly caps.",
              supported_networks: ["base", "base-sepolia"],
              supported_assets: ["USDC"],
              protocol: "x402",
              default_max_payment_usd: 1.0,
              flow: [
                "1. Agent calls xenarch_check_gate to discover if a URL has an x402 payment gate",
                "2. Gate returns price, accepted payment requirements, seller wallet, network and asset",
                "3. Agent calls xenarch_pay — it signs an EIP-3009 USDC transferWithAuthorization, settles on-chain, and re-fetches the gated content",
                "4. Tool returns the on-chain tx_hash plus the gated content",
              ],
            },
            null,
            2,
          ),
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
            text: `I want to access the content at ${url}. Please:\n1. First check if it has an x402 payment gate using xenarch_check_gate\n2. If gated, show me the price and ask for confirmation\n3. Once confirmed, pay using xenarch_pay\n4. Return the content and tx_hash`,
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
    const notice =
      `A new Xenarch wallet was just created: ${addr}\n` +
      `It has no funds yet. To make payments, the user needs to send USDC to this address on Base. USDC is the only token required — no ETH or other gas coin needed.\n` +
      `Wallet saved to ~/.xenarch/wallet.json\n` +
      `IMPORTANT: Tell the user about this new wallet and that they need to fund it with USDC before payments will work.`;
    configResult.walletCreated = undefined;
    return notice;
  }

  function withWalletNotice(
    content: Array<{ type: "text"; text: string }>,
  ): Array<{ type: "text"; text: string }> {
    const notice = consumeWalletNotice();
    if (!notice) return content;
    return [{ type: "text" as const, text: notice }, ...content];
  }

  server.tool(
    "xenarch_check_gate",
    "Check if a URL or domain has an x402 payment gate. Returns gate status, accepted payment requirements (price, asset, network), and the seller wallet. Use this before paying to confirm pricing, when a URL returns HTTP 402 Payment Required, or when a user asks whether content is paywalled.",
    checkGateSchema.shape,
    {
      title: "Check Payment Gate",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await checkGate(input, config);
        return {
          content: withWalletNotice([
            { type: "text", text: JSON.stringify(result, null, 2) },
          ]),
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
    "Pay an x402-gated URL with USDC on Base L2 and return the gated content. Signs an EIP-3009 transferWithAuthorization, settles on-chain, then re-fetches the resource with proof of payment. Returns the on-chain tx_hash, seller wallet, and the response body. Settles directly to the seller wallet — no Xenarch contract in the money flow, no custodial balance. The agent wallet only ever holds USDC; no ETH or other gas coin is required. Use after xenarch_check_gate confirms a gate exists, or when the user asks to pay for or unlock gated content.",
    paySchema.shape,
    {
      title: "Pay for Content",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await pay(input, config);
        return {
          content: withWalletNotice([
            { type: "text", text: JSON.stringify(result, null, 2) },
          ]),
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
    "xenarch_wallet_status",
    "Show the agent's local payment wallet: its address, USDC balance on Base, and whether it's funded. Use this to find the address the user needs to top up with USDC, or to check the balance before paying. This is the wallet that signs payments — separate from the wallet used to sign in to the dashboard.",
    walletStatusSchema.shape,
    {
      title: "Wallet Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await walletStatus(input, config);
        return {
          content: withWalletNotice([
            { type: "text", text: JSON.stringify(result, null, 2) },
          ]),
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading wallet status: ${error instanceof Error ? error.message : String(error)}`,
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
    {
      title: "View Payment History",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (input) => {
      try {
        const config = await getConfig();
        const result = await getHistory(input, config);
        return {
          content: withWalletNotice([
            { type: "text", text: JSON.stringify(result, null, 2) },
          ]),
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

  // --- Agent control plane (XEN-409) ---------------------------------------
  // Manage the operator's agent: caps, scope, pause, API keys, receipts.
  // SIWE-owner-authed via the session the CLI's `xenarch agent login` wrote
  // to ~/.xenarch/config.json. Privileged ops require `confirm: true`; without
  // it the tool returns a `needs_confirmation` payload (the Tier-2 gate).
  function registerAgentTool(
    name: string,
    description: string,
    schema: z.AnyZodObject,
    hints: {
      title: string;
      readOnlyHint: boolean;
      destructiveHint: boolean;
      idempotentHint: boolean;
      openWorldHint: boolean;
    },
    handler: (input: any, config: XenarchConfig) => Promise<unknown>,
  ): void {
    server.tool(name, description, schema.shape, hints, async (input: any) => {
      try {
        const config = await getConfig();
        const result = await handler(input, config);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  registerAgentTool(
    "xenarch_agent_login",
    "Sign in to the agent control plane using your browser wallet — no CLI needed. First call returns a link; open it, sign in with your wallet on the dashboard, and approve. Call this tool again to finish — the 7-day session is then used by every other xenarch_agent_* tool. Use this when a control-plane tool reports you're not signed in.",
    login.agentLoginSchema,
    { title: "Agent Login", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    login.agentLogin,
  );
  registerAgentTool(
    "xenarch_agent_status",
    "Show the operator's agent profile (name, paused state) and spend summary for a period. Read-only. Needs a SIWE session from `xenarch agent login`.",
    cp.agentStatusSchema,
    { title: "Agent Status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    cp.agentStatus,
  );
  registerAgentTool(
    "xenarch_agent_get_caps",
    "Read the agent's spending caps (per-transaction, daily, monthly) and remaining headroom. Read-only.",
    cp.agentGetCapsSchema,
    { title: "Get Spend Caps", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    cp.agentGetCaps,
  );
  registerAgentTool(
    "xenarch_agent_set_caps",
    "Set spending caps. Pass per_tx/daily/monthly in USD ('none' disables an axis); omit an axis to leave it unchanged. RAISING or REMOVING a cap requires confirm: true (returns needs_confirmation otherwise). Tightening is free.",
    cp.agentSetCapsSchema,
    { title: "Set Spend Caps", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    cp.agentSetCaps,
  );
  registerAgentTool(
    "xenarch_agent_reset_day_cap",
    "Reset today's daily-spend counter back to the full daily cap (recovery from accidental mid-day exhaustion).",
    cp.agentResetDayCapSchema,
    { title: "Reset Daily Counter", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    cp.agentResetDayCap,
  );
  registerAgentTool(
    "xenarch_agent_get_scope",
    "Read the agent's scope: default posture (allow/deny) and the allow/deny rule list. Read-only.",
    cp.agentGetScopeSchema,
    { title: "Get Scope Rules", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    cp.agentGetScope,
  );
  registerAgentTool(
    "xenarch_agent_add_scope_rule",
    "Add an allow/deny scope rule. A 'deny' rule tightens (free); an 'allow' rule loosens and requires confirm: true.",
    cp.agentAddScopeRuleSchema,
    { title: "Add Scope Rule", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    cp.agentAddScopeRule,
  );
  registerAgentTool(
    "xenarch_agent_remove_scope_rule",
    "Remove a scope rule by id (full UUID or unambiguous prefix). Removing a DENY rule loosens scope and requires confirm: true.",
    cp.agentRemoveScopeRuleSchema,
    { title: "Remove Scope Rule", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    cp.agentRemoveScopeRule,
  );
  registerAgentTool(
    "xenarch_agent_set_default_scope",
    "Set the default scope posture for unmatched URLs. 'deny' tightens (free); 'allow' loosens and requires confirm: true.",
    cp.agentSetDefaultScopeSchema,
    { title: "Set Default Scope", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    cp.agentSetDefaultScope,
  );
  registerAgentTool(
    "xenarch_agent_pause",
    "Kill switch: pause the agent so all of its payments are blocked immediately. Tightening, so no confirm needed.",
    cp.agentPauseSchema,
    { title: "Pause Agent", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    cp.agentPause,
  );
  registerAgentTool(
    "xenarch_agent_resume",
    "Lift the pause so the agent can spend again (subject to caps + scope). Requires confirm: true.",
    cp.agentResumeSchema,
    { title: "Resume Agent", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    cp.agentResume,
  );
  registerAgentTool(
    "xenarch_agent_list_keys",
    "List the agent's xa_live_ API keys (id, label, last-used, revoked state). Never returns plaintext. Read-only.",
    cp.agentListKeysSchema,
    { title: "List API Keys", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    cp.agentListKeys,
  );
  registerAgentTool(
    "xenarch_agent_create_key",
    "Issue a new xa_live_ API key (plaintext returned once). Issues a live spending credential — requires confirm: true.",
    cp.agentCreateKeySchema,
    { title: "Create API Key", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    cp.agentCreateKey,
  );
  registerAgentTool(
    "xenarch_agent_rotate_key",
    "Rotate an API key by id (full UUID or prefix) — invalidates the old secret, returns a new one once. Requires confirm: true.",
    cp.agentRotateKeySchema,
    { title: "Rotate API Key", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    cp.agentRotateKey,
  );
  registerAgentTool(
    "xenarch_agent_revoke_key",
    "Permanently revoke an API key by id (full UUID or prefix). Requires confirm: true.",
    cp.agentRevokeKeySchema,
    { title: "Revoke API Key", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    cp.agentRevokeKey,
  );
  registerAgentTool(
    "xenarch_agent_get_receipts",
    "List the agent's payment receipts with filters (period, status, source, domain) and pagination. Read-only.",
    cp.agentGetReceiptsSchema,
    { title: "Get Receipts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    cp.agentGetReceipts,
  );

  // --- Merchant ops (XEN-414/415) — the "get paid" side. SIWE-authed via the
  // same session as the control plane. create_link is validate-first; signing
  // and revoke are gated by confirm: true.
  registerAgentTool(
    "xenarch_list_links",
    "List the merchant's pay-links (newest first), with cursor pagination. Read-only. Needs a SIWE session from `xenarch agent login`.",
    merchant.xenarchListLinksSchema,
    { title: "List Pay-Links", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    merchant.xenarchListLinks,
  );
  registerAgentTool(
    "xenarch_get_link",
    "Get one pay-link's detail (status, params, stats) by id. Read-only.",
    merchant.xenarchGetLinkSchema,
    { title: "Get Pay-Link", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    merchant.xenarchGetLink,
  );
  registerAgentTool(
    "xenarch_create_link",
    "Create a pay-link. VALIDATE-FIRST: call with mode:'validate' (default) to learn which fields are missing (each missing field includes a prompt to ask the user); once valid, call again with mode:'create' and confirm:true to sign + create. Signs with the agent's local key — the signer must equal the SIWE session wallet. Amount is USDC (max 1.00).",
    merchant.xenarchCreateLinkSchema,
    { title: "Create Pay-Link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    merchant.xenarchCreateLink,
  );
  registerAgentTool(
    "xenarch_revoke_link",
    "Revoke a pay-link by id so it can no longer be paid. Requires confirm: true (returns needs_confirmation otherwise).",
    merchant.xenarchRevokeLinkSchema,
    { title: "Revoke Pay-Link", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    merchant.xenarchRevokeLink,
  );
  registerAgentTool(
    "xenarch_list_payments",
    "List payments RECEIVED across the merchant's pay-links (newest first), with cursor pagination. Read-only.",
    merchant.xenarchListPaymentsSchema,
    { title: "List Received Payments", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    merchant.xenarchListPayments,
  );
  registerAgentTool(
    "xenarch_list_subscribers",
    "List subscribers across the merchant's subscription pay-links, with optional filters (link_id, status, mode). Read-only.",
    merchant.xenarchListSubscribersSchema,
    { title: "List Subscribers", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    merchant.xenarchListSubscribers,
  );
  registerAgentTool(
    "xenarch_get_merchant_profile",
    "Get the merchant profile (issuer identity, domain verification status). Read-only. Returns null if none is set yet.",
    merchant.xenarchGetMerchantProfileSchema,
    { title: "Get Merchant Profile", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    merchant.xenarchGetMerchantProfile,
  );
  registerAgentTool(
    "xenarch_update_merchant_profile",
    "Update the merchant profile (issuer name, site, email, address, tax id, brand color, logo, payout rhythm). Only the fields you pass change; the rest are preserved (whole-state upsert).",
    merchant.xenarchUpdateMerchantProfileSchema,
    { title: "Update Merchant Profile", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    merchant.xenarchUpdateMerchantProfile,
  );
  registerAgentTool(
    "xenarch_verify_domain",
    "Verify the merchant's domain via its DNS TXT record at _xenarch.<merchant_site> (XEN-394). Set merchant_site first via xenarch_update_merchant_profile.",
    merchant.xenarchVerifyDomainSchema,
    { title: "Verify Domain", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    merchant.xenarchVerifyDomain,
  );
  registerAgentTool(
    "xenarch_pay_link",
    "Pay a Xenarch pay-link by id (wrapped x402): fetches the link's payment envelope, settles EIP-3009 USDC on Base, and confirms the payment with the link. Use this for pay.xenarch.com/l/<id> links; use xenarch_pay for arbitrary x402-gated URLs. Pays from the agent wallet (USDC only, no gas needed).",
    payLink.xenarchPayLinkSchema,
    { title: "Pay a Pay-Link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    payLink.xenarchPayLink,
  );

  return server;
}
