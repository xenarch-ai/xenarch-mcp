# xenarch-mcp

[![npm](https://img.shields.io/npm/v/@xenarch/agent-mcp)](https://www.npmjs.com/package/@xenarch/agent-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP servers for the Xenarch payment network. Lets AI agents discover and pay for services via USDC micropayments on Base.

## How It Works

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

## Agent MCP Server

Three tools for AI agents:

| Tool | Description |
|------|-------------|
| `xenarch_check_gate` | Check if a URL/domain has a payment gate. Returns pricing and payment details. |
| `xenarch_pay` | Pay for gated content. Executes USDC payment on Base via the splitter contract. |
| `xenarch_get_history` | View past payments made by this wallet. |

### Example Responses

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

Or add to Claude Desktop / any MCP client:

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

## Environment Variables

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

## License

MIT
