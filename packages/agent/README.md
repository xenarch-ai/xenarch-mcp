# Xenarch — non-custodial x402 MCP server for AI agent payments

Xenarch is a non-custodial x402 MCP server that gives any AI agent a wallet and lets it resolve HTTP 402 ("Payment Required") responses automatically. When a site, API, or tool returns HTTP 402 with an x402 challenge, the agent signs a USDC micropayment on Base L2 (up to $1 per call) and retries — no API keys, no subscriptions, no credit card on file. The agent wallet only ever needs USDC — no ETH, no gas coin of any kind.

## What makes Xenarch different

| | Cloudflare Pay-Per-Crawl | TollBit | Xenarch |
|---|---|---|---|
| Works on any host | ✗ (Cloudflare only) | ✗ (enterprise) | ✓ |
| Non-custodial | ✗ | ✗ | ✓ (agent-to-publisher direct, no Xenarch contract) |
| Agent needs ETH | n/a | n/a | ✓ never |
| Fee | Platform rate | Platform rate | **0% — no Xenarch contract that *can* charge a fee** |
| Open standard | proprietary | proprietary | x402 + pay.json (open) |

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

## Configure

| Variable | Default | Description |
|----------|---------|-------------|
| `XENARCH_PRIVATE_KEY` | — | Wallet private key (overrides config file) |
| `XENARCH_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `XENARCH_API_BASE` | `https://xenarch.dev` | Xenarch platform API |
| `XENARCH_NETWORK` | `base` | Network (`base` or `base-sepolia`) |
| `XENARCH_MAX_PAYMENT_USD` | — | Max USD per call to auto-approve without prompting (defaults to 0.1 USDC inside x402-fetch) |

## Links

- Website: https://xenarch.com
- GitHub: https://github.com/xenarch-ai/xenarch-mcp
- server.json (registry entry): https://github.com/xenarch-ai/xenarch-mcp/blob/main/server.json
- Official MCP Registry: https://registry.modelcontextprotocol.io/v0/servers/io.github.xenarch-ai/xenarch-mcp
- Smithery: https://smithery.ai/servers/xenarch/xenarch-mcp
- Glama: https://glama.ai/mcp/servers/xenarch-ai/xenarch-mcp
