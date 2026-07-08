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
import * as subs from "./tools/subscribers.js";
import * as collect from "./tools/collect.js";
import * as linksX from "./tools/links-extra.js";
import * as hooks from "./tools/webhooks.js";
import * as agentX from "./tools/agent-extra.js";
import * as sites from "./tools/sites.js";
import * as account from "./tools/account.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "xenarch",
    version: "1.3.1",
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
    "Reset today's daily-spend counter back to the full daily cap (recovery from accidental mid-day exhaustion). Restores full spending headroom — requires confirm: true.",
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
    "Update the merchant profile (issuer name, site, email, address, tax id, brand color, logo, payout rhythm). Only the fields you pass change; the rest are preserved (whole-state upsert). Rewrites customer-facing identity — requires confirm: true.",
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
  // --- Subscribers: lifecycle + collections (XEN-517) ------------------------
  registerAgentTool(
    "xenarch_get_subscriber",
    "Get one subscriber's full detail (plan, cadence, renewal dates, payer, permit/metered state) by subscription id. Read-only.",
    subs.getSubscriberSchema,
    { title: "Get Subscriber", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    subs.getSubscriberTool,
  );
  registerAgentTool(
    "xenarch_get_subscriber_charges",
    "Read a metered subscriber's immutable charge ledger (booked + settled charges, totals, outstanding). Read-only, cursor over charge_seq.",
    subs.getSubscriberChargesSchema,
    { title: "Get Subscriber Charges", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    subs.getSubscriberCharges,
  );
  registerAgentTool(
    "xenarch_get_subscriber_rollup",
    "Subscriber KPIs: active count, MRR (USDC), 30-day churn. Read-only.",
    subs.getSubscriberRollupSchema,
    { title: "Subscriber Rollup", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    subs.getSubscriberRollup,
  );
  registerAgentTool(
    "xenarch_cancel_subscriber",
    "Cancel a subscription (merchant-initiated; reminder-mode only, 409 otherwise). Permanent. Requires confirm: true.",
    subs.cancelSubscriberSchema,
    { title: "Cancel Subscriber", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    subs.cancelSubscriber,
  );
  registerAgentTool(
    "xenarch_suspend_subscriber",
    "Suspend a subscription: collection attempts and dunning stop. Any mode, idempotent, no on-chain effect. Requires confirm: true.",
    subs.suspendSubscriberSchema,
    { title: "Suspend Subscriber", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    subs.suspendSubscriberTool,
  );
  registerAgentTool(
    "xenarch_mint_manage_link",
    "Mint a short-lived manage URL + token for a subscriber (hosted manage page). Anyone holding it can manage that subscription until expiry. Requires confirm: true.",
    subs.mintManageLinkSchema,
    { title: "Mint Manage Link", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    subs.mintManageLinkTool,
  );
  registerAgentTool(
    "xenarch_set_period_cap",
    "Set/raise a metered-per-period subscriber's budget (new_cap_usdc). Mints the manage token behind the scenes. Requires confirm: true.",
    subs.setPeriodCapSchema,
    { title: "Set Period Cap", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    subs.setPeriodCapTool,
  );
  registerAgentTool(
    "xenarch_list_permit_collectable",
    "List permit subscriptions with a cycle due now (the collectable bag): amount, owner→spender transferFrom params, permit status. Read-only.",
    subs.listPermitCollectableSchema,
    { title: "Permit Collectable", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    subs.listPermitCollectableTool,
  );
  registerAgentTool(
    "xenarch_list_metered_collectable",
    "List metered subscriptions with booked charges awaiting on-chain settlement (the collectable bag). Read-only.",
    subs.listMeteredCollectableSchema,
    { title: "Metered Collectable", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    subs.listMeteredCollectableTool,
  );
  registerAgentTool(
    "xenarch_fire_permit_digest",
    "Dev/test: drop the throttle and immediately re-send the collectable digest email for your wallet. Requires confirm: true.",
    subs.firePermitDigestSchema,
    { title: "Fire Permit Digest", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    subs.firePermitDigestTool,
  );

  // --- On-chain collection (XEN-517) — LOCAL-KEY wallets only ----------------
  registerAgentTool(
    "xenarch_permit_submit",
    "Broadcast the buyer's signed USDC.permit on-chain to set the allowance (moves NO funds; wallet pays gas). Needs the LOCAL seller wallet key + Base ETH. Broadcasting requires confirm: true. Pass tx_hash alone to record an already-broadcast permit (recovery, record-only, no confirm needed).",
    collect.permitSubmitSchema,
    { title: "Submit Permit On-Chain", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    collect.permitSubmitTool,
  );
  registerAgentTool(
    "xenarch_permit_collect",
    "Collect one due permit cycle: preflights allowance/balance/simulation, broadcasts USDC.transferFrom from the LOCAL seller wallet (must be the permit spender, needs Base ETH gas), then books it. MOVES REAL MONEY — requires confirm: true PLUS expected_amount_usdc pinned from the needs_confirmation payload. If it reports transferred-but-not-booked, use xenarch_record_collect; NEVER re-run this tool for the same cycle.",
    collect.permitCollectSchema,
    { title: "Collect Permit Cycle", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    collect.permitCollect,
  );
  registerAgentTool(
    "xenarch_metered_collect",
    "Settle a metered subscriber's booked charges on-chain: preflight, broadcast USDC.transferFrom from the LOCAL seller wallet, book. MOVES REAL MONEY — requires confirm: true PLUS expected_amount_usdc pinned from the needs_confirmation payload. If transferred-but-not-booked, use xenarch_record_collect; NEVER re-run this tool for the same charges.",
    collect.meteredCollectSchema,
    { title: "Collect Metered Charges", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    collect.meteredCollect,
  );
  registerAgentTool(
    "xenarch_record_collect",
    "Recovery: book an ALREADY-broadcast transferFrom by tx hash. Never transfers — the backend dedups on tx_hash, so it is always safe to re-run.",
    collect.recordCollectSchema,
    { title: "Record Collect Tx", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    collect.recordCollect,
  );

  // --- Pay-link detail surface, groups, orders (XEN-517) ---------------------
  registerAgentTool(
    "xenarch_edit_link",
    "Replace a pay-link's metadata object (whole-state; null clears). Requires confirm: true.",
    linksX.editLinkSchema,
    { title: "Edit Pay-Link Metadata", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    linksX.editLink,
  );
  registerAgentTool(
    "xenarch_get_link_events",
    "List a pay-link's event stream (views, payments, webhook fires…) with type filter + cursor. Read-only.",
    linksX.getLinkEventsSchema,
    { title: "Get Link Events", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.getLinkEvents,
  );
  registerAgentTool(
    "xenarch_get_links_rollup",
    "Merchant pay-link KPIs: paid 24h/total, month-to-date revenue, views, conversion. Read-only.",
    linksX.getLinksRollupSchema,
    { title: "Links Rollup", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.getLinksRollupTool,
  );
  registerAgentTool(
    "xenarch_get_links_summary",
    "Revenue / paid-count / link-count summary for a period (24h, 7d, 30d, all). Read-only.",
    linksX.getLinksSummarySchema,
    { title: "Links Summary", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.getLinksSummaryTool,
  );
  registerAgentTool(
    "xenarch_list_groups",
    "List pay-link groups (name, accent, members). Read-only.",
    linksX.listGroupsSchema,
    { title: "List Groups", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.listGroupsTool,
  );
  registerAgentTool(
    "xenarch_create_group",
    "Create a pay-link group. Requires confirm: true.",
    linksX.createGroupSchema,
    { title: "Create Group", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    linksX.createGroupTool,
  );
  registerAgentTool(
    "xenarch_update_group",
    "Rename / re-accent / re-position a pay-link group. Requires confirm: true.",
    linksX.updateGroupSchema,
    { title: "Update Group", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.updateGroupTool,
  );
  registerAgentTool(
    "xenarch_delete_group",
    "Delete a pay-link group (member links become ungrouped). Requires confirm: true.",
    linksX.deleteGroupSchema,
    { title: "Delete Group", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    linksX.deleteGroupTool,
  );
  registerAgentTool(
    "xenarch_assign_link_group",
    "Move a pay-link into a group (or null to ungroup). Requires confirm: true.",
    linksX.assignLinkGroupSchema,
    { title: "Assign Link Group", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.assignLinkGroupTool,
  );
  registerAgentTool(
    "xenarch_list_orders",
    "List paid orders across pay-links (buyer, shipping, status, tracking) with filters + cursor. Read-only.",
    linksX.listOrdersSchema,
    { title: "List Orders", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.listOrdersTool,
  );
  registerAgentTool(
    "xenarch_ship_order",
    "Mark an order shipped with a tracking number — emails the buyer. Requires confirm: true.",
    linksX.shipOrderSchema,
    { title: "Ship Order", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.shipOrderTool,
  );
  registerAgentTool(
    "xenarch_export_orders",
    "Export orders as CSV text (same filters as list). Read-only.",
    linksX.exportOrdersSchema,
    { title: "Export Orders CSV", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    linksX.exportOrdersTool,
  );

  // --- Pay-link webhooks (XEN-517) --------------------------------------------
  registerAgentTool(
    "xenarch_get_link_webhook",
    "Read a pay-link's webhook config (URL, event types, enabled). Read-only.",
    hooks.getLinkWebhookSchema,
    { title: "Get Link Webhook", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    hooks.getLinkWebhookTool,
  );
  registerAgentTool(
    "xenarch_set_link_webhook",
    "Set a pay-link's webhook URL / event types / enabled. Requires confirm: true.",
    hooks.setLinkWebhookSchema,
    { title: "Set Link Webhook", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    hooks.setLinkWebhookTool,
  );
  registerAgentTool(
    "xenarch_rotate_link_webhook_secret",
    "Rotate a pay-link's webhook signing secret (old secret stops verifying). Requires confirm: true.",
    hooks.rotateLinkWebhookSecretSchema,
    { title: "Rotate Link Webhook Secret", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    hooks.rotateLinkWebhookSecretTool,
  );
  registerAgentTool(
    "xenarch_test_link_webhook",
    "Send a test event to a pay-link's webhook URL. Requires confirm: true.",
    hooks.testLinkWebhookSchema,
    { title: "Test Link Webhook", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    hooks.testLinkWebhookTool,
  );
  registerAgentTool(
    "xenarch_get_link_webhook_deliveries",
    "List a pay-link's recent webhook delivery attempts (status, latency, errors). Read-only.",
    hooks.getLinkWebhookDeliveriesSchema,
    { title: "Link Webhook Deliveries", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    hooks.getLinkWebhookDeliveriesTool,
  );
  registerAgentTool(
    "xenarch_retry_link_webhook_delivery",
    "Re-send one failed pay-link webhook delivery. Requires confirm: true.",
    hooks.retryLinkWebhookDeliverySchema,
    { title: "Retry Link Webhook Delivery", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    hooks.retryLinkWebhookDeliveryTool,
  );

  // --- Agent webhooks + remaining agent surface (XEN-517) ----------------------
  registerAgentTool(
    "xenarch_get_agent_webhook",
    "Read the agent's webhook config (URL, event types, enabled). Read-only.",
    hooks.getAgentWebhookSchema,
    { title: "Get Agent Webhook", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    hooks.getAgentWebhookTool,
  );
  registerAgentTool(
    "xenarch_set_agent_webhook",
    "Set the agent's webhook URL / event types / enabled. Requires confirm: true.",
    hooks.setAgentWebhookSchema,
    { title: "Set Agent Webhook", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    hooks.setAgentWebhookTool,
  );
  registerAgentTool(
    "xenarch_rotate_agent_webhook_secret",
    "Rotate the agent webhook's signing secret. Requires confirm: true.",
    hooks.rotateAgentWebhookSecretSchema,
    { title: "Rotate Agent Webhook Secret", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    hooks.rotateAgentWebhookSecretTool,
  );
  registerAgentTool(
    "xenarch_test_agent_webhook",
    "Send a test event to the agent's webhook URL. Requires confirm: true.",
    hooks.testAgentWebhookSchema,
    { title: "Test Agent Webhook", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    hooks.testAgentWebhookTool,
  );
  registerAgentTool(
    "xenarch_get_agent_webhook_deliveries",
    "List the agent webhook's recent delivery attempts. Read-only.",
    hooks.getAgentWebhookDeliveriesSchema,
    { title: "Agent Webhook Deliveries", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    hooks.getAgentWebhookDeliveriesTool,
  );
  registerAgentTool(
    "xenarch_retry_agent_webhook_delivery",
    "Re-send one failed agent webhook delivery. Requires confirm: true.",
    hooks.retryAgentWebhookDeliverySchema,
    { title: "Retry Agent Webhook Delivery", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    hooks.retryAgentWebhookDeliveryTool,
  );
  registerAgentTool(
    "xenarch_update_agent_profile",
    "Update the agent's display profile (display_name, label; null clears). Requires confirm: true.",
    agentX.updateAgentProfileSchema,
    { title: "Update Agent Profile", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    agentX.updateAgentProfile,
  );
  registerAgentTool(
    "xenarch_get_receipt",
    "Get one payment receipt by id (from xenarch_agent_get_receipts). Read-only.",
    agentX.getReceiptSchema,
    { title: "Get Receipt", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    agentX.getReceipt,
  );

  // --- Sites & gating + bots (XEN-517) — publisher surface ---------------------
  registerAgentTool(
    "xenarch_list_sites",
    "List the signed-in identity's sites (domain, price, gating, integration). Empty if the identity isn't a publisher yet. Read-only.",
    sites.listSitesSchema,
    { title: "List Sites", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.listSitesTool,
  );
  registerAgentTool(
    "xenarch_add_site",
    "Create a site (issues its site token; domain optional — the integration backfills it). Needs a verified account email. Requires confirm: true.",
    sites.addSiteSchema,
    { title: "Add Site", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    sites.addSite,
  );
  registerAgentTool(
    "xenarch_get_site",
    "Full site detail: gating config, pricing rules, token hash, integration. Read-only.",
    sites.getSiteSchema,
    { title: "Get Site", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.getSiteTool,
  );
  registerAgentTool(
    "xenarch_delete_site",
    "Permanently delete a site — its token stops working. Requires confirm: true.",
    sites.deleteSiteSchema,
    { title: "Delete Site", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    sites.deleteSiteTool,
  );
  registerAgentTool(
    "xenarch_set_site_gating",
    "Replace a site's gating config (master switch + category map, whole-state). Changes which bot traffic is charged/blocked. Requires confirm: true.",
    sites.setSiteGatingSchema,
    { title: "Set Site Gating", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    sites.setSiteGating,
  );
  registerAgentTool(
    "xenarch_set_site_pricing",
    "Replace a site's pricing (default price/scope + per-path rules, whole-state). Requires confirm: true.",
    sites.setSitePricingSchema,
    { title: "Set Site Pricing", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    sites.setSitePricing,
  );
  registerAgentTool(
    "xenarch_rotate_site_token",
    "Rotate a site's token — the integration must be updated or gating stops. Requires confirm: true.",
    sites.rotateSiteTokenSchema,
    { title: "Rotate Site Token", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    sites.rotateSiteTokenTool,
  );
  registerAgentTool(
    "xenarch_get_site_stats",
    "Site earnings stats: gates, paid count, revenue, top pages, top agents. Read-only.",
    sites.getSiteStatsSchema,
    { title: "Site Stats", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.getSiteStatsTool,
  );
  registerAgentTool(
    "xenarch_get_site_activity",
    "Site transaction feed (paid / blocked / withdrawals) with period + status filters, paginated. Read-only.",
    sites.getSiteActivitySchema,
    { title: "Site Activity", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.getSiteActivity,
  );
  registerAgentTool(
    "xenarch_get_site_categories",
    "Per-bot-category earnings breakdown for a site. Read-only.",
    sites.getSiteCategoriesSchema,
    { title: "Site Category Breakdown", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.getSiteCategories,
  );
  registerAgentTool(
    "xenarch_get_publisher_gating",
    "Read the publisher-level gating defaults (category map + per-bot overrides). Read-only.",
    sites.getPublisherGatingSchema,
    { title: "Get Publisher Gating", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.getPublisherGatingTool,
  );
  registerAgentTool(
    "xenarch_set_publisher_gating",
    "Replace the publisher-level gating defaults — affects every site set to follow them. Requires confirm: true.",
    sites.setPublisherGatingSchema,
    { title: "Set Publisher Gating", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    sites.setPublisherGatingTool,
  );
  registerAgentTool(
    "xenarch_create_site_claim",
    "Mint a short-lived claim token so a plugin/worker/SDK can bootstrap its site token without copy-paste. Requires confirm: true.",
    sites.createSiteClaimSchema,
    { title: "Create Site Claim", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    sites.createSiteClaimTool,
  );
  registerAgentTool(
    "xenarch_bot_catalog",
    "The full bot signature catalog (name, category, company). Public, no auth. Read-only.",
    sites.botCatalogSchema,
    { title: "Bot Catalog", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.botCatalog,
  );
  registerAgentTool(
    "xenarch_bot_activity",
    "Aggregated cross-site bot activity for the publisher (hits, sites seen, last seen per signature). Read-only.",
    sites.botActivitySchema,
    { title: "Bot Activity", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    sites.botActivity,
  );

  // --- Account & identity + earnings (XEN-517) ----------------------------------
  registerAgentTool(
    "xenarch_list_wallets",
    "List the account's linked wallets (owner/default flags, labels, eligibility). Read-only.",
    account.listWalletsSchema,
    { title: "List Wallets", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    account.listWalletsTool,
  );
  registerAgentTool(
    "xenarch_link_wallet",
    "Link the agent's LOCAL wallet to your account as a co-wallet (key-held SIWE — signs with the local key). Requires confirm: true.",
    account.linkWalletSchema,
    { title: "Link Wallet", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    account.linkWalletTool,
  );
  registerAgentTool(
    "xenarch_unlink_wallet",
    "Unlink a wallet from the account — it loses sign-in access. Requires confirm: true.",
    account.unlinkWalletSchema,
    { title: "Unlink Wallet", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    account.unlinkWalletTool,
  );
  registerAgentTool(
    "xenarch_set_wallet_label",
    "Set/clear a linked wallet's nickname. Requires confirm: true.",
    account.setWalletLabelSchema,
    { title: "Set Wallet Label", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    account.setWalletLabelTool,
  );
  registerAgentTool(
    "xenarch_transfer_owner",
    "Transfer account OWNERSHIP to another linked wallet. Hard to reverse. Requires confirm: true.",
    account.transferOwnerSchema,
    { title: "Transfer Ownership", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    account.transferOwnerTool,
  );
  registerAgentTool(
    "xenarch_list_merchant_keys",
    "List the merchant's xm_live_ API keys (never returns plaintext). Read-only.",
    account.listMerchantKeysSchema,
    { title: "List Merchant Keys", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    account.listMerchantKeysTool,
  );
  registerAgentTool(
    "xenarch_create_merchant_key",
    "Issue a new xm_live_ merchant API key (plaintext returned once). Requires confirm: true.",
    account.createMerchantKeySchema,
    { title: "Create Merchant Key", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    account.createMerchantKeyTool,
  );
  registerAgentTool(
    "xenarch_rotate_merchant_key",
    "Rotate a merchant API key — invalidates the old secret, returns a new one once. Requires confirm: true.",
    account.rotateMerchantKeySchema,
    { title: "Rotate Merchant Key", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    account.rotateMerchantKeyTool,
  );
  registerAgentTool(
    "xenarch_revoke_merchant_key",
    "Permanently revoke a merchant API key. Requires confirm: true.",
    account.revokeMerchantKeySchema,
    { title: "Revoke Merchant Key", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    account.revokeMerchantKeyTool,
  );
  registerAgentTool(
    "xenarch_create_invite",
    "Mint a co-owner join link (viewer / operator / full_co_owner). Anyone redeeming it joins your account. Requires confirm: true.",
    account.createInviteSchema,
    { title: "Create Invite", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    account.createInviteTool,
  );
  registerAgentTool(
    "xenarch_list_invites",
    "List outstanding (unredeemed) invites. Read-only.",
    account.listInvitesSchema,
    { title: "List Invites", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    account.listInvitesTool,
  );
  registerAgentTool(
    "xenarch_revoke_invite",
    "Revoke a live invite before it's redeemed. Requires confirm: true.",
    account.revokeInviteSchema,
    { title: "Revoke Invite", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    account.revokeInviteTool,
  );
  registerAgentTool(
    "xenarch_preview_invite",
    "Preview a join link: which account it joins, role, expiry. Anonymous. Read-only.",
    account.previewInviteSchema,
    { title: "Preview Invite", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    account.previewInviteTool,
  );
  registerAgentTool(
    "xenarch_redeem_invite",
    "Join another Xenarch account by invite token — the agent's LOCAL wallet signs SIWE and attaches to the inviter's identity. Requires confirm: true.",
    account.redeemInviteSchema,
    { title: "Redeem Invite", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    account.redeemInviteTool,
  );
  registerAgentTool(
    "xenarch_set_account_email",
    "Set the account email and send it a verification code (finish with xenarch_verify_account_email). Requires confirm: true.",
    account.setAccountEmailSchema,
    { title: "Set Account Email", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    account.setAccountEmail,
  );
  registerAgentTool(
    "xenarch_verify_account_email",
    "Verify the account email with the emailed code.",
    account.verifyAccountEmailSchema,
    { title: "Verify Account Email", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    account.verifyAccountEmail,
  );
  registerAgentTool(
    "xenarch_upload_asset",
    "Upload an image (URL or base64, max 5 MB) to Xenarch's public CDN — for logos/branding. Returns the cdn.xenarch.dev URL. Requires confirm: true.",
    account.uploadAssetSchema,
    { title: "Upload Asset", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    account.uploadAssetTool,
  );
  registerAgentTool(
    "xenarch_get_earnings_summary",
    "Earnings summary: today / this month / all-time (USD + payment counts). Read-only.",
    account.getEarningsSummarySchema,
    { title: "Earnings Summary", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    account.getEarningsSummaryTool,
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
