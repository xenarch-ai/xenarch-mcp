# Xenarch — x402 MCP server for AI agent payments

[![npm](https://img.shields.io/npm/v/@xenarch/agent-mcp)](https://www.npmjs.com/package/@xenarch/agent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Xenarch is a non-custodial x402 MCP server. AI agents — Claude, Cursor, LangChain, CrewAI — pay for HTTP 402—gated APIs and content with USDC micropayments on Base L2. No API keys, no subscriptions, no credit card on file. The agent wallet never needs ETH; USDC is the only token it ever holds. Payments settle on-chain: agent wallet → publisher wallet, direct. 0% Xenarch fee — there's no Xenarch contract in the money flow.

## What makes Xenarch different

| | Cloudflare Pay-Per-Crawl | Stripe | TollBit | Vercel `x402-mcp` | Other x402 MCP servers | **Xenarch** |
|---|---|---|---|---|---|---|
| Works on any host | × (Cloudflare only) | ✓ | × (enterprise) | Vercel-first | ✓ | ✓ |
| Non-custodial | × | × | × | platform-routed | varies | ✓ direct USDC transfer |
| Agent needs ETH | n/a | n/a | n/a | varies | varies | ✓ never |
| Fee | platform rate | 2.9% + $0.30 | platform rate | platform rate | varies | **0%, structurally** |
| Open standard | proprietary | proprietary | proprietary | x402 | x402 | x402 + pay.json (authored by Xenarch) |
| Publisher monetization | ✓ (Cloudflare-gated) | ✓ (any stack) | ✓ (enterprise only) | × | × | ✓ (any stack) |

## How it works

```
1. Discover    xenarch_check_gate("example.com")
               → { gated: true, accepts: [...] }

2. Pay         xenarch_pay("example.com")
               → x402-fetch signs an EIP-3009 USDC transferWithAuthorization
               → Settlement goes on-chain
               → Re-fetches the resource with proof of payment
               → { tx_hash, content }
```

No API keys. No signup. The agent wallet only ever needs USDC — no ETH, no gas coin of any kind. Xenarch never holds funds and there is no Xenarch contract between the agent and the publisher.

## MCP tools

29 tools across three groups. Group 1 (discovery & payments) works with just a
wallet. Groups 2 and 3 (control plane + merchant) manage your Xenarch account and
need a SIWE session — run `xenarch agent login` once (see [Account tools auth](#account-tools-auth)).

### 1. Discovery & payments — agent wallet only

| Tool | Description |
|------|-------------|
| `xenarch_check_gate` | Check if a URL/domain has an x402 payment gate. Returns the accepted payment requirements — price, asset, network, seller wallet. |
| `xenarch_pay` | Pay for an x402-gated URL. Signs an EIP-3009 USDC transfer, settles on-chain, returns the tx hash and the gated content. |
| `xenarch_pay_link` | Pay a Xenarch pay-link by id (`pay.xenarch.com/l/<id>`): fetches the envelope, settles USDC on Base, confirms with the link. |
| `xenarch_get_history` | View past payments made by this wallet (totals, per-domain, pagination). |

### 2. Agent control plane — manage your spending agent (SIWE session)

Caps, scope, kill-switch, and API keys for the operator's agent. Privileged
(loosening) operations require `confirm: true`; tightening is free.

| Tool | Description |
|------|-------------|
| `xenarch_agent_login` | Browser-wallet sign-in to the control plane. Returns a link; open it, approve, call again to finish. The 7-day session powers every other `xenarch_agent_*` tool. |
| `xenarch_agent_status` | Agent profile (name, paused state) + spend summary for a period. Read-only. |
| `xenarch_agent_get_caps` | Read spending caps (per-tx, daily, monthly) + remaining headroom. Read-only. |
| `xenarch_agent_set_caps` | Set caps in USD (`none` disables an axis). Raising/removing a cap needs `confirm: true`; tightening is free. |
| `xenarch_agent_reset_day_cap` | Reset today's daily-spend counter to the full daily cap. |
| `xenarch_agent_get_scope` | Read scope: default posture (allow/deny) + the rule list. Read-only. |
| `xenarch_agent_add_scope_rule` | Add an allow/deny rule. `deny` tightens (free); `allow` loosens (needs `confirm`). |
| `xenarch_agent_remove_scope_rule` | Remove a rule by id/prefix. Removing a `deny` loosens scope (needs `confirm`). |
| `xenarch_agent_set_default_scope` | Set the posture for unmatched URLs. `deny` tightens; `allow` loosens (needs `confirm`). |
| `xenarch_agent_pause` | Kill switch — block all of the agent's payments immediately. No confirm. |
| `xenarch_agent_resume` | Lift the pause (needs `confirm`). |
| `xenarch_agent_list_keys` | List the agent's `xa_live_` API keys (id, label, last-used, revoked). Never returns plaintext. Read-only. |
| `xenarch_agent_create_key` | Issue a new `xa_live_` key (plaintext returned once). Needs `confirm`. |
| `xenarch_agent_rotate_key` | Rotate a key by id/prefix — invalidates the old secret, returns a new one once. Needs `confirm`. |
| `xenarch_agent_revoke_key` | Permanently revoke a key by id/prefix. Needs `confirm`. |
| `xenarch_agent_get_receipts` | List the agent's payment receipts with filters (period, status, source, domain). Read-only. |

### 3. Merchant — get paid (SIWE session)

Create and manage pay-links, see payments and subscribers, set the merchant
profile. Same SIWE session as the control plane.

| Tool | Description |
|------|-------------|
| `xenarch_create_link` | Create a pay-link. VALIDATE-FIRST: `mode:'validate'` reports missing fields; then `mode:'create'` + `confirm:true` signs + creates. Amount is USDC (max 1.00). |
| `xenarch_list_links` | List the merchant's pay-links (newest first), cursor-paginated. Read-only. |
| `xenarch_get_link` | Get one pay-link's detail (status, params, stats) by id. Read-only. |
| `xenarch_revoke_link` | Revoke a pay-link by id so it can no longer be paid. Needs `confirm`. |
| `xenarch_list_payments` | List payments received across the merchant's links (newest first), cursor-paginated. Read-only. |
| `xenarch_list_subscribers` | List subscribers across subscription links, with filters (link_id, status, mode). Read-only. |
| `xenarch_get_merchant_profile` | Get the merchant profile (issuer identity, domain-verification status). Read-only. |
| `xenarch_update_merchant_profile` | Update the merchant profile (name, site, email, address, tax id, brand color, logo, payout rhythm). Whole-state upsert. |
| `xenarch_verify_domain` | Verify the merchant's domain via its `_xenarch.<site>` DNS TXT record. Set the site first via `xenarch_update_merchant_profile`. |

<a id="account-tools-auth"></a>
### Account tools auth

- **Payments** (group 1) need a funded wallet (`XENARCH_PRIVATE_KEY`) **and** a control-plane link (`XENARCH_API_TOKEN`) — the official MCP refuses to pay without the token (XEN-480: an unlinked agent has no caps). A local per-call cap (`XENARCH_MAX_PAYMENT_USD`, default $1) applies on top of the managed per-tx / daily / monthly caps.
- **Control plane + merchant** (groups 2–3) need a SIWE session. Run `xenarch agent login` once — it writes a 7-day `session_token` to `~/.xenarch/config.json`, which the MCP server reads automatically. Re-run when it expires, or call `xenarch_agent_login` directly from your client.
- Set **`XENARCH_API_TOKEN`** (an `xa_live_` agent key) so `xenarch_pay` is enforced against your **managed** caps/scope and every MCP payment shows up in the dashboard receipts feed. The dashboard is free — sign in with your wallet at [dash.xenarch.dev](https://dash.xenarch.dev) (just a signature, nothing moves) for per-tx / daily / monthly caps, scope rules, a kill switch, and full history. **Without the token, `xenarch_pay` refuses to pay (fail-closed)** so an unlinked agent can't settle uncapped. Note: the dashboard sign-in wallet is your *identity* — separate from the agent's local spending wallet.

### Example responses

<details>
<summary><code>xenarch_check_gate</code></summary>

```json
{
  "gated": true,
  "gate_id": "7f3a1b2c-9d4e-4a8b-b6f1-2c3d4e5f6a7b",
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "3000",
      "resource": "https://example.com/article",
      "payTo": "0xabc123...publisher_wallet",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxTimeoutSeconds": 60
    }
  ],
  "seller_wallet": "0xabc123...publisher_wallet",
  "network": "base",
  "asset": "USDC"
}
```

</details>

<details>
<summary><code>xenarch_pay</code></summary>

```json
{
  "success": true,
  "gate_id": "7f3a1b2c-9d4e-4a8b-b6f1-2c3d4e5f6a7b",
  "tx_hash": "0xdef456...abc789",
  "seller_wallet": "0xabc123...publisher_wallet",
  "url": "https://example.com/article",
  "wallet": "0x123...your_wallet",
  "content": "...gated content here..."
}
```

</details>

<details>
<summary><code>xenarch_get_history</code></summary>

```json
{
  "payments": [
    {
      "domain": "example.com",
      "amount_usd": "0.003",
      "tx_hash": "0xdef456...abc789",
      "paid_at": "2026-04-10T14:35:00Z"
    }
  ],
  "total_spent_usd": "0.003000",
  "count": 1,
  "wallet": "0x123...your_wallet"
}
```

</details>

## HTTP 402 — the unused status code that x402 finally activates

HTTP 402 Payment Required is a status code reserved in the HTTP spec since 1997 for machine-to-machine payment. It went unused for decades because there was no open protocol for how a client should pay a 402 response.

x402 is that protocol: a server returns HTTP 402 with a signed price and payment details, the client signs a USDC micropayment on Base L2, and retries the request with proof of payment. Xenarch's MCP server automates both halves for AI agents — it reads the 402 challenge, signs the payment via `x402-fetch`, and replays the request, returning the on-chain tx hash plus the gated content.

Learn more: the [x402 spec](https://www.x402.org/) defines the payment handshake; [pay.json](https://xenarch.com) (authored by Xenarch) is the companion open standard for machine-readable pricing served at `/.well-known/pay.json` — think robots.txt for payments.

## API monetization with HTTP 402

Xenarch is an API monetization primitive built on the HTTP 402 spec. Unlike API gateway monetization platforms (Apigee, Kong, AWS API Gateway) that require subscriptions, dashboards, and API keys, Xenarch lets any API charge per request with no account creation and no key provisioning — the caller pays USDC on Base L2, the API verifies the on-chain transaction, access is granted.

For publishers, this means:
- No integration with Stripe/card processors
- No subscription plans, pricing tiers, or quota dashboards
- No custodial balance held by a platform
- Per-request pricing that works for human users, bots, and AI agents uniformly
- API monetization that settles on-chain in real time

The Python SDK includes a one-decorator FastAPI middleware; see `xenarch-sdks/python` for publisher integration.

## Setup

1. Configure your wallet:

```bash
mkdir -p ~/.xenarch
cat > ~/.xenarch/wallet.json << 'EOF'
{
  "privateKey": "0xYOUR_PRIVATE_KEY"
}
EOF
chmod 600 ~/.xenarch/wallet.json
```

2. Add to Claude Code:

```bash
claude mcp add xenarch -- npx @xenarch/agent-mcp
```

Or add the same JSON to any MCP client's config file:

- **Claude Desktop** — `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) / `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor** — `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project)
- **Cline** (VS Code) — the MCP Servers panel → "Configure MCP Servers", or `cline_mcp_settings.json`

```json
{
  "mcpServers": {
    "xenarch": {
      "command": "npx",
      "args": ["@xenarch/agent-mcp"],
      "env": {
        "XENARCH_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
        "XENARCH_API_TOKEN": "xa_live_…optional, enforces caps/scope"
      }
    }
  }
}
```

3. Fund the wallet with USDC on Base. That's it — no ETH, no other token needed.

4. (Optional) To use the control-plane + merchant tools, run `xenarch agent login` once to create a SIWE session.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XENARCH_PRIVATE_KEY` | — | Wallet private key (overrides config file) |
| `XENARCH_API_TOKEN` | — | **Required.** Agent `xa_live_` key. Enforces `xenarch_pay` against your caps/scope and feeds the dashboard receipts. Without it, `xenarch_pay` refuses to pay (fail-closed). |
| `XENARCH_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `XENARCH_API_BASE` | `https://xenarch.dev` | Xenarch platform API |
| `XENARCH_NETWORK` | `base` | Network (`base` or `base-sepolia`) |
| `XENARCH_MAX_PAYMENT_USD` | `1.00` | Local per-call payment cap (USDC). The only spending ceiling in standalone mode — `xenarch_pay` refuses any single payment above it. Set `0` to remove the cap. For managed per-tx / daily / monthly caps, connect `XENARCH_API_TOKEN`. |

The control-plane + merchant tools don't use an env var for auth — they read the
SIWE `session_token` that `xenarch agent login` writes to `~/.xenarch/config.json`.

## Examples

See [xenarch-examples](https://github.com/xenarch-ai/xenarch-examples) for working integration examples — Python agents, LangChain, CrewAI, Claude Desktop setup, and publisher middleware.

## Development

```bash
npm install
npm run build
```

## Structure

```
packages/
  shared/    — Payment logic, types, config (reused across servers)
  agent/     — MCP server for AI agents
```

## FAQ

**How does Claude pay for APIs with Xenarch?**
Install the Xenarch MCP server (`claude mcp add xenarch -- npx @xenarch/agent-mcp`), give it a wallet, and Claude resolves any HTTP 402 response automatically with a USDC micropayment on Base L2.

**Does Xenarch work with Cursor, LangChain, or CrewAI?**
Yes. Xenarch exposes an MCP server that any MCP-compatible client can use — Claude Code, Claude Desktop, Cursor, Cline, LangChain, CrewAI, and any other client that speaks Model Context Protocol.

**Is FastAPI supported for publishers?**
Yes, via the Python SDK (`pip install xenarch[fastapi]`) — a one-decorator middleware returns HTTP 402 with the price and verifies the on-chain payment. See `xenarch-sdks/python`.

**Is Xenarch custodial?**
No. Payments settle on-chain as a direct USDC transfer from the agent wallet to the publisher wallet. Funds never touch Xenarch infrastructure and there is no Xenarch contract in the money flow.

**Does the agent need ETH for gas?**
No. USDC is the only token the agent wallet ever needs. Fund it with USDC and you're done — no ETH, no other gas coin.

**What's the fee?**
0%, structurally. Xenarch never sits in the money flow — there's no Xenarch contract that could charge a fee.

**What's the maximum payment per call?**
$1 USD.

**What is x402?**
x402 is an open protocol for HTTP 402 Payment Required. A server returns 402 with a price, the client signs a USDC micropayment on Base L2 (or other supported chain), and retries the request with proof of payment.

**What is HTTP 402?**
HTTP 402 Payment Required is a status code reserved in the HTTP spec since 1997 for machine-to-machine payment. x402 is the open protocol that finally uses it.

**How does Xenarch compare to Cloudflare Pay-Per-Crawl?**
Cloudflare Pay-Per-Crawl only works for sites behind Cloudflare and is custodial. Xenarch works on any host and is non-custodial — publishers are paid directly on-chain.

**How does Xenarch compare to TollBit?**
TollBit is enterprise-licensing focused. Xenarch is self-serve, non-custodial, and works for the long tail of publishers and any AI agent without enterprise contracts.

## Links

- Website: https://xenarch.com
- npm: https://www.npmjs.com/package/@xenarch/agent-mcp
- PyPI: https://pypi.org/project/xenarch/
- Smithery: https://smithery.ai/servers/xenarch/xenarch-mcp
- GitHub: https://github.com/xenarch-ai/xenarch-mcp

## License

MIT
