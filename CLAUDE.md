# xenarch-mcp

MCP (Model Context Protocol) servers for Xenarch. Lets AI agents discover and pay for content, and lets publishers manage their pricing.

## Structure

Monorepo with three packages:

```
packages/
  agent/       — MCP server for AI agents (discover content, make payments)
  publisher/   — MCP server for publishers (manage pricing, view earnings)
  shared/      — Shared types and utilities
```

## Stack

- TypeScript, @modelcontextprotocol/sdk
- Package manager: npm (workspaces)

## Commands

- Build: `npm run build`
- Test: `npm test`
- Publish agent: `npm publish --workspace packages/agent`
- Publish publisher: `npm publish --workspace packages/publisher`

## Design Principle

These are thin API clients to the xenarch.bot backend. No business logic lives here — just MCP tool definitions that call the platform API.

## Workflow

See root `../CLAUDE.md` for branching, PR, and commit conventions.

## Architecture

See `../Information/design/mcp-servers.md` for MCP server design.
