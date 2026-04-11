#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";
import { randomUUID } from "node:crypto";
import express from "express";

// Smithery sandbox support — allows capability scanning without real credentials
export function createSandboxServer() {
  return createServer();
}

const isHttpMode =
  process.argv.includes("--http") || process.env.TRANSPORT === "http";

async function main() {
  if (isHttpMode) {
    await startHttpServer();
  } else {
    await startStdioServer();
  }
}

async function startStdioServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttpServer() {
  const app = express();
  app.use(express.json());

  // Session management: each client gets its own server + transport
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Handle POST requests (initialize + subsequent JSON-RPC calls)
  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — route to its transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId && !transports.has(sessionId)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // No session ID — must be an initialize request
    if (!isInitializeRequest(req.body)) {
      res
        .status(400)
        .json({ error: "First request must be an initialize request" });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
    };

    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Handle GET requests (SSE streaming)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // Handle DELETE requests (session termination)
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing session ID" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  const port = parseInt(process.env.PORT || "3000", 10);
  app.listen(port, "0.0.0.0", () => {
    console.log(`Xenarch MCP server (HTTP) listening on port ${port}`);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    for (const transport of transports.values()) {
      await transport.close();
    }
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
