# xenarch-mcp

MCP servers for the Xenarch payment network. Lets AI agents discover and pay for services via USDC micropayments on Base.

## Agent MCP Server

Three tools for AI agents:

| Tool | Description |
|------|-------------|
| `xenarch_check_gate` | Check if a URL/domain has a payment gate. Returns pricing and payment details. |
| `xenarch_pay` | Pay for gated content. Executes USDC payment on Base via the splitter contract. |
| `xenarch_get_history` | View past payments made by this wallet. |

### Setup

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

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `XENARCH_PRIVATE_KEY` | — | Wallet private key (overrides config file) |
| `XENARCH_RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `XENARCH_API_BASE` | `https://api.xenarch.dev` | Xenarch platform API |
| `XENARCH_NETWORK` | `base` | Network (`base` or `base-sepolia`) |
| `XENARCH_AUTO_APPROVE_MAX` | — | Max USD to auto-approve without prompting |

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
