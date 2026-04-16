# Xenarch — x402 MCP server for AI agent payments

[![npm](https://img.shields.io/npm/v/@xenarch/agent-mcp)](https://www.npmjs.com/package/@xenarch/agent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Xenarch is a non-custodial x402 MCP server that lets AI agents pay for HTTP 402–gated APIs and content with USDC micropayments on Base L2. Claude, Cursor, LangChain, and CrewAI agents resolve HTTP 402 ("Payment Required") responses automatically — no API keys, no subscriptions, no credit card on file. Payments settle on-chain via an immutable splitter contract: 0% fee today, hard-capped at 0.99% forever.

## What makes Xenarch different

| | Cloudflare Pay-Per-Crawl | TollBit | Vercel `x402-mcp` | Other x402 MCP servers | **Xenarch** |
|---|---|---|---|---|---|
| Works on any host | ❌ (Cloudflare only) | ❌ (enterprise) | ⚠️ Vercel-first | ✅ | ✅ |
| Non-custodial | ❌ | ❌ | platform-routed | varies | ✅ on-chain splitter |
| Fee | platform rate | platform rate | platform rate | varies | **0% today, 0.99% hard-capped forever** |
| Open standard | proprietary | proprietary | x402 | x402 | x402 + pay.json (authored by Xenarch) |
| Publisher monetization | ✅ (Cloudflare-gated) | ✅ (enterprise only) | ❌ | ❌ | ✅ (any stack) |

## How it works

```
1. Discover    xenarch_check_gate("example.com")
               → { gated: true, price_usd: "0.003", protocol: "x402" }

2. Pay         xenarch_pay("example.com")
               → USDC sent on Base via splitter contract
               → { access_token: "eyJ...", expires_at: "..." }

3. Access      Re-request the URL with Authorization: Bearer <token>
               → Full content returned
```

No API keys. No signup. The agent pays directly on-chain — Xenarch never holds funds.

## MCP tools

Three tools for AI agents:

| Tool | Description |
|------|-------------|
| `xenarch_check_gate` | Check if a URL/domain has a payment gate. Returns pricing and payment details. |
| `xenarch_pay` | Pay for gated content. Executes USDC payment on Base via the splitter contract. |
| `xenarch_get_history` | View past payments made by this wallet. |

### Example responses

<details>
<summary><code>xenarch_check_gate</code></summary>

```json
{
  "gated": true,
  "gate_id": "7f3a1b2c-9d4e-4a8b-b6f1-2c3d4e5f6a7b",
  "price_usd": "0.003",
  "splitter": "0xC6D3a6B6fcCD6319432CDB72819cf317E88662ae",
  "collector": "0xabc123...publisher_wallet",
  "network": "base",
  "asset": "USDC",
  "protocol": "x402"
}
```

</details>

<details>
<summary><code>xenarch_pay</code></summary>

```json
{
  "success": true,
  "tx_hash": "0xdef456...abc789",
  "block_number": 28451023,
  "amount_usd": "0.003",
  "url": "example.com",
  "access_token": "eyJhbGciOiJIUzI1NiJ9...",
  "expires_at": "2026-04-10T15:05:00Z",
  "wallet": "0x123...your_wallet"
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

x402 is that protocol: a server returns HTTP 402 with a signed price and payment details, the client signs a USDC micropayment on Base L2, and retries the request with proof of payment. Xenarch's MCP server automates both halves for AI agents — it reads the 402 challenge, signs the payment, and replays the request with the resulting Bearer token.

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

Or add to Claude Desktop / Cursor / any MCP client:

```json
{
  "mcpServers": {
    "xenarch": {
      "command": "npx",
      "args": ["@xenarch/agent-mcp"],
      "env": {
        "XENARCH_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY"
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XENARCH_PRIVATE_KEY` | — | Wallet private key (overrides config file) |
| `XENARCH_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `XENARCH_API_BASE` | `https://api.xenarch.dev` | Xenarch platform API |
| `XENARCH_NETWORK` | `base` | Network (`base` or `base-sepolia`) |
| `XENARCH_AUTO_APPROVE_MAX` | — | Max USD to auto-approve without prompting |

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
No. Payments settle on-chain via an immutable splitter contract. Funds never touch Xenarch infrastructure.

**What's the fee?**
0% today. Hard-capped at 0.99% on-chain — the cap cannot be raised.

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
