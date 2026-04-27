# Xenarch Launch Guide

> This file is used by mcp.so and other MCP registries that auto-fill submission forms from a repository's `LAUNCHGUIDE.md`. Keep copy in sync with `Information/distribution/seo-kw-strategy.md` in the root xenarch repo.

## Name

Xenarch

## Tagline

Non-custodial x402 MCP server for AI agent payments

## Short description

x402 MCP server that lets AI agents pay for HTTP 402–gated content and APIs with USDC micropayments on Base L2. Non-custodial. 0% fee. Works with Claude, Cursor, LangChain, and CrewAI.

## Full description

Xenarch is a non-custodial, facilitator-agnostic x402 MCP server. It lets AI agents — Claude, Cursor, LangChain, CrewAI, or any MCP client — resolve HTTP 402 ("Payment Required") responses automatically by signing USDC micropayments on Base L2 (up to $1 per call). Publishers get paid directly on-chain — the agent transfers USDC straight to the publisher wallet through any x402 facilitator chosen from the gate's ranked list. 0% fee, no intermediary contract. Unlike Cloudflare Pay-Per-Crawl, Xenarch works on any host and is fully non-custodial. HTTP 402 has been reserved in the HTTP spec since 1997 — x402 is the open protocol that finally uses it.

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

- `xenarch_check_gate` — Check if a URL or domain has an x402 payment gate. Returns price, accepted payment requirements, and ranked facilitator list.
- `xenarch_pay` — Pay an x402-gated URL with USDC on Base, signed via EIP-3009 transferWithAuthorization, submitted through a chosen facilitator. Returns the on-chain tx hash and the gated content.
- `xenarch_get_history` — List past payments by this wallet.

## Environment variables

- `XENARCH_PRIVATE_KEY` — wallet private key (optional; auto-generates on first run)
- `XENARCH_RPC_URL` — Base RPC endpoint (default `https://mainnet.base.org`)
- `XENARCH_API_BASE` — Xenarch platform API (default `https://xenarch.dev`)
- `XENARCH_NETWORK` — `base` or `base-sepolia` (default `base`)
- `XENARCH_MAX_PAYMENT_USD` — max USD per call to auto-approve without prompting

## Maintainers

- mihneadevries (GitHub) — Mihnea de Vries
- A-Xen (GitHub) — Andrey Khayrullaev
