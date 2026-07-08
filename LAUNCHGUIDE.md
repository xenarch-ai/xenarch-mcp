# Xenarch Launch Guide

> This file is used by mcp.so and other MCP registries that auto-fill submission forms from a repository's `LAUNCHGUIDE.md`. Keep copy in sync with `Information/distribution/seo-kw-strategy.md` in the root xenarch repo.

## Name

Xenarch

## Tagline

Non-custodial x402 MCP server for AI agent payments

## Short description

x402 MCP server that lets AI agents pay for HTTP 402–gated content and APIs with USDC micropayments on Base L2. Non-custodial. 0% fee. Works with Claude, Cursor, LangChain, and CrewAI.

## Full description

Xenarch is a non-custodial x402 MCP server. It lets AI agents — Claude, Cursor, LangChain, CrewAI, or any MCP client — resolve HTTP 402 ("Payment Required") responses automatically by signing USDC micropayments on Base L2 (up to $1 per call). The agent wallet only ever holds USDC — no ETH, no gas coin. Publishers get paid directly on-chain: agent wallet → publisher wallet, direct. 0% Xenarch fee — there's no Xenarch contract in the money flow. Unlike Cloudflare Pay-Per-Crawl, Xenarch works on any host and is fully non-custodial. HTTP 402 has been reserved in the HTTP spec since 1997 — x402 is the open protocol that finally uses it.

Docs & install: https://xenarch.com

## Install

```bash
npx @xenarch/agent-mcp
```

Or add to Claude Code / Cursor / Claude Desktop via MCP config:

```json
{
  "mcpServers": {
    "xenarch": {
      "command": "npx",
      "args": ["@xenarch/agent-mcp"]
    }
  }
}
```

## Tags / categories

mcp, mcp-server, model-context-protocol, x402, http-402, ai-agent-payments, claude, cursor, langchain, crewai, usdc, base, base-l2, non-custodial, pay-per-crawl, cloudflare-alternative, tollbit-alternative, machine-to-machine-payments, pay-json, api-monetization, micropayments, stablecoin-api, xenarch

## Repository

https://github.com/xenarch-ai/xenarch-mcp

## Website

https://xenarch.com

## License

MIT

## Tools exposed

100+ tools (v1.3, ~100% Xenarch dashboard parity). The paying core:

- `xenarch_check_gate` — Check if a URL or domain has an x402 payment gate. Returns price, accepted payment requirements, seller wallet, network, asset.
- `xenarch_pay` — Pay an x402-gated URL with USDC on Base, signed via EIP-3009 transferWithAuthorization, settles on-chain. Returns the on-chain tx hash and the gated content.
- `xenarch_pay_link` — Pay a Xenarch pay-link (wrapped x402).
- `xenarch_wallet_status` / `xenarch_get_history` — wallet address + balance; past payments.

Plus the full management surface (sign in once via the `xenarch_agent_login` browser device flow):

- **Agent control plane** — spend caps, scope rules, pause/resume kill switch, API keys, receipts, webhooks.
- **Merchant pay-links** — create (EIP-712 signed), list/revoke, metadata, events, revenue rollups, groups, orders + shipping, per-link webhooks.
- **Subscribers** — lifecycle, dunning state, metered charge ledger, MRR/churn, manage-links, period caps.
- **On-chain collection** — submit buyer permits and pull due subscription payments (`USDC.permit`/`transferFrom`) from the seller's own wallet.
- **Publisher sites & bots** — sites CRUD, gating + pricing, site tokens, stats, bot catalog + activity.
- **Account** — linked wallets, merchant API keys, co-owner invites, email, asset upload, earnings.

Every mutating tool is confirmation-gated (`needs_confirmation` preview → re-invoke with `confirm: true`); money-moving tools additionally pin the exact amount.

## Environment variables

- `XENARCH_PRIVATE_KEY` — wallet private key (optional; auto-generates on first run)
- `XENARCH_RPC_URL` — Base RPC endpoint (default `https://mainnet.base.org`)
- `XENARCH_API_BASE` — Xenarch platform API (default `https://xenarch.dev`)
- `XENARCH_NETWORK` — `base` or `base-sepolia` (default `base`)
- `XENARCH_MAX_PAYMENT_USD` — max USD per call to auto-approve without prompting
- `XENARCH_API_TOKEN` — `xa_live_*` control-plane token (required for `xenarch_pay`; fail-closed without it)
- `XENARCH_SESSION_TOKEN` — SIWE session for management tools (usually set via `xenarch_agent_login` instead)

## Maintainers

- mihneadevries (GitHub) — Mihnea de Vries
- A-Xen (GitHub) — Andrey Khayrullaev
