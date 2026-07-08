# Xenarch — non-custodial x402 MCP server for AI agent payments

Xenarch is a non-custodial x402 MCP server that gives any AI agent a wallet and lets it resolve HTTP 402 ("Payment Required") responses automatically. When a site, API, or tool returns HTTP 402 with an x402 challenge, the agent signs a USDC payment on Base L2 and retries — no API keys, no subscriptions, no credit card on file. A local per-call cap (`XENARCH_MAX_PAYMENT_USD`, default $1) guards standalone spending. The agent wallet only ever needs USDC — no ETH, no gas coin of any kind.

## What makes Xenarch different

| | Cloudflare Pay-Per-Crawl | Stripe | TollBit | Xenarch |
|---|---|---|---|---|
| Works on any host | × (Cloudflare only) | ✓ | × (enterprise) | ✓ |
| Non-custodial | × | × | × | ✓ (agent-to-publisher direct, no Xenarch contract) |
| Agent needs ETH | n/a | n/a | n/a | ✓ never |
| Fee | Platform rate | 2.9% + $0.30 | Platform rate | **0% — no Xenarch contract that *can* charge a fee** |
| Open standard | proprietary | proprietary | proprietary | x402 + pay.json (open) |

## Native in
Claude Code, Claude.ai (via MCP), Cursor, Cline, LangChain, CrewAI, and any MCP-compatible client.

## Why x402
HTTP 402 has been reserved in the HTTP spec since 1997 for exactly this — machine-to-machine payment. x402 is the open protocol that finally uses it: a signed USDC micropayment any server can verify and any agent can produce.

## Why pay.json
pay.json is the open standard for machine-readable pricing, served at `/.well-known/pay.json`. Think robots.txt for payments.

## FAQ
**How does Claude pay for APIs with Xenarch?** Install the Xenarch MCP server, give it a wallet, and Claude resolves any HTTP 402 response automatically with a USDC micropayment on Base L2.

**Is Xenarch custodial?** No. Payments settle on-chain as a direct USDC transfer from the agent's wallet to the publisher's wallet. Funds never touch Xenarch infrastructure — there is no Xenarch contract in the money flow.

**Does the agent need ETH for gas?** No. USDC is the only token the agent wallet ever needs. Fund it with USDC and you're done.

**What's the fee?** 0%. There is no Xenarch contract that *can* charge a fee — the architecture is structurally zero-fee, not a policy promise.

**What's the max payment?** $1 per call.

Learn more: https://xenarch.com

## Install

```bash
npm install @xenarch/agent-mcp
```

Add to Claude Code:

```bash
claude mcp add xenarch -- npx -y @xenarch/agent-mcp
```

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "xenarch": {
      "command": "npx",
      "args": ["-y", "@xenarch/agent-mcp"],
      "env": {
        "XENARCH_PRIVATE_KEY": "0x...",
        "XENARCH_API_TOKEN": "xa_live_..."
      }
    }
  }
}
```

Restart Claude Desktop. Xenarch's 100+ tools become available to the model — paying x402 gates, plus the full merchant, subscriber, and publisher control surface (see "Tools the model sees" below).

### Cursor

Settings → Tools & MCP → New MCP Server. Paste the same JSON shape:

```json
{
  "mcpServers": {
    "xenarch": {
      "command": "npx",
      "args": ["-y", "@xenarch/agent-mcp"],
      "env": {
        "XENARCH_PRIVATE_KEY": "0x...",
        "XENARCH_API_TOKEN": "xa_live_..."
      }
    }
  }
}
```

### Cline (VS Code)

Open the Cline panel → MCP Servers → Add. Same JSON. Cline reloads servers on save.

## Configure

| Variable | Default | Description |
|----------|---------|-------------|
| `XENARCH_PRIVATE_KEY` | — | Wallet private key (overrides config file) |
| `XENARCH_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `XENARCH_API_BASE` | `https://xenarch.dev` | Xenarch platform API |
| `XENARCH_NETWORK` | `base` | Network (`base` or `base-sepolia`) |
| `XENARCH_MAX_PAYMENT_USD` | — | Max USD per call to auto-approve without prompting |
| `XENARCH_API_TOKEN` | — | **Required** `xa_live_*` token from https://dash.xenarch.dev/agent/settings. Every `xenarch_pay` call **preflights** with the platform (caps + scope + kill switch), reports the receipt back, and on settle failure POSTs a `status='failed'` receipt with the auth_token so the platform refunds the cap charge. **Without it, `xenarch_pay` refuses to pay (fail-closed)** — an unlinked agent has no caps, so it must not settle uncapped. |
| `XENARCH_SESSION_TOKEN` | — | SIWE session for the management tools (control plane, merchant, subscribers, sites, account). Usually not set by hand — sign in with the `xenarch_agent_login` tool (browser device flow) or the CLI's `xenarch agent login`; both persist the session to `~/.xenarch/config.json`. |

## Tools the model sees

**Paying (the core, works standalone):**

| Tool | What it does |
|---|---|
| `xenarch_check_gate` | Probe a URL for an x402 challenge without paying. Returns price + seller + settlement providers. |
| `xenarch_pay` | Pay an x402-gated URL with USDC on Base L2 and return the gated content. Signs EIP-3009 `transferWithAuthorization`, settles via the publisher's chosen settlement provider, replays with the canonical Xenarch headers. |
| `xenarch_pay_link` | Pay a Xenarch pay-link (`pay.xenarch.com/l/<id>`) — the wrapped x402 flow. |
| `xenarch_wallet_status` / `xenarch_get_history` | Wallet address + USDC balance; past payments (filter by domain). |

**Managing (v1.3 — ~100% dashboard parity; sign in once with `xenarch_agent_login`):**

| Group | Tools |
|---|---|
| Agent control plane | status, spend caps get/set/reset, scope rules, pause/resume kill switch, `xa_live_` API keys, receipts, agent webhooks, profile |
| Merchant pay-links | create (validate-first + EIP-712 signing), list/get/revoke, metadata, events, revenue rollups, groups, orders + shipping + CSV export, per-link webhooks |
| Subscribers | list (with dunning state), detail, metered charge ledger, MRR/churn rollup, cancel/suspend, manage-links, period caps, collectable bags, digest |
| On-chain collection | `xenarch_permit_submit`, `xenarch_permit_collect`, `xenarch_metered_collect`, `xenarch_record_collect` — pull due subscription payments via `USDC.permit`/`transferFrom`. Needs the seller wallet's **local key** + a little Base ETH for gas (the one flow that isn't gasless — the merchant broadcasts their own pull). |
| Publisher sites & bots | sites CRUD, gating + pricing rules, site tokens, stats/activity/category breakdowns, publisher-wide gating, bot catalog + activity |
| Account | linked wallets (link/unlink/label/transfer-owner), merchant API keys, co-owner invites, account email, logo upload, earnings summary |

Every mutating tool is gated: it returns a `needs_confirmation` preview first and only acts when re-invoked with `confirm: true` — money-moving tools additionally pin the exact amount. Tool descriptions carry the details.

## What refusals look like

When the control plane refuses (or no `XENARCH_API_TOKEN` is set), `xenarch_pay` returns a structured refusal as tool content (not a thrown error) so the LLM surfaces it cleanly:

```json
{
  "success": false,
  "refused": true,
  "reason": "daily_cap",
  "matched_rule": null,
  "message": "Refused by Xenarch control plane: daily cap exceeded ($1.00 spent of $1.00). Resets in 18h 22m. Edit cap at https://dash.xenarch.dev/agent/caps",
  "url": "https://api.openai.com/v1/chat",
  "gate_id": "..."
}
```

Possible `reason` values: `per_tx_cap`, `daily_cap`, `monthly_cap`, `scope`, `paused`, `control_plane_unreachable`. Each comes with a dashboard deep link in the `message` so the operator knows where to fix it.

If the on-chain settle succeeds but the gate rejects the replay, the server POSTs a `status='failed'` receipt so the platform refunds the cap charge (no permanent budget loss for payments that didn't deliver content).

## Links

- Website: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-mcp
- server.json (registry entry): https://github.com/xenarch-ai/xenarch-mcp/blob/main/server.json
- Official MCP Registry: https://registry.modelcontextprotocol.io/v0/servers/io.github.xenarch-ai/xenarch-mcp
- Smithery: https://smithery.ai/servers/xenarch/xenarch-mcp
- Glama: https://glama.ai/mcp/servers/xenarch-ai/xenarch-mcp
