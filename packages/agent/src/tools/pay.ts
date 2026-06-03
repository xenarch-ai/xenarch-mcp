import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import {
  fetchGate,
  fetchGateByDomain,
  payAndFetch,
  verifyPayment,
  getWalletAddress,
} from "@xenarch/core";
import type { GateResponse, XenarchConfig } from "@xenarch/core";
import { reportReceipt } from "../agent-receipts.js";
import { checkPreflight, formatDenyMessage } from "../agent-preflight.js";

export const paySchema = z.object({
  url: z
    .string()
    .describe(
      "The URL or domain to pay for. Must have an active x402 payment gate. Payment settles in USDC on Base L2, agent wallet to seller wallet direct. The agent wallet only ever holds USDC; no ETH or other gas coin needed.",
    ),
});

export type PayInput = z.infer<typeof paySchema>;

export async function pay(input: PayInput, config: XenarchConfig) {
  const { url } = input;
  const walletAddress = getWalletAddress(config);

  // Resolve a target URL we can actually GET. For bare domains, look up the
  // canonical resource URL on the platform; for full URLs, hit them directly.
  let gate: GateResponse;
  let resourceUrl: string;
  if (!url.startsWith("http")) {
    const found = await fetchGateByDomain(config.apiBase, url);
    if (!found) {
      throw new Error(`No Xenarch gate found for domain: ${url}`);
    }
    gate = found;
    const firstResource = gate.accepts[0]?.resource;
    if (!firstResource) {
      throw new Error(
        `Gate ${gate.gate_id} has no accepts[].resource — cannot determine URL to fetch.`,
      );
    }
    resourceUrl = firstResource;
  } else {
    const result = await fetchGate(url);
    if (!result.gated || !result.gate) {
      throw new Error(`No Xenarch gate found at: ${url}`);
    }
    gate = result.gate;
    resourceUrl = url;
  }

  // XEN-373: control-plane preflight runs before settlement when
  // XENARCH_API_TOKEN is configured. Returning the deny reason as tool
  // content (not a thrown error) lets the LLM caller surface it cleanly.
  const accepted = gate.accepts[0];
  const baseUnitsForPreflight = accepted?.maxAmountRequired
    ? Number(accepted.maxAmountRequired)
    : 0;
  const amountUsdForPreflight = (baseUnitsForPreflight / 1_000_000).toFixed(4);
  const preflight = await checkPreflight(
    config.apiBase,
    resourceUrl,
    amountUsdForPreflight,
  );
  let preflightAuthToken: string | null = null;
  if (!preflight.ok) {
    const message =
      "detail" in preflight
        ? `Refused by Xenarch control plane: ${preflight.detail}`
        : formatDenyMessage(preflight);
    return {
      success: false,
      refused: true,
      reason: preflight.reason,
      matched_rule:
        "matched_rule" in preflight ? preflight.matched_rule : null,
      message,
      url: resourceUrl,
      gate_id: gate.gate_id,
    };
  }
  if (!("bypassed" in preflight)) {
    preflightAuthToken = preflight.auth_token;
  }

  // Sign the EIP-3009 USDC transfer authorization, submit the payment, and
  // re-fetch the resource. Returns the response body as text so the caller
  // can use it.
  //
  // XEN-385: if settle/replay throws AFTER the platform's preflight already
  // DECR'd the cap counter, POST a status='failed' receipt with the
  // auth_token so the platform refunds the cap charge (JTI one-shot is
  // enforced server-side). Without this, every MCP settle failure
  // permanently consumes the operator's daily cap even though no payment
  // landed on chain.
  let response: Response;
  let result: { txHash: string; facilitator: string };
  try {
    ({ response, result } = await payAndFetch(resourceUrl, config, gate));
  } catch (err) {
    if (preflightAuthToken) {
      try {
        await reportReceipt(config.apiBase, {
          url: resourceUrl,
          amount_usd: amountUsdForPreflight,
          source: "mcp",
          status: "failed",
          paid_at: new Date().toISOString(),
          tx_hash: null,
          facilitator: null,
          wallet_address: walletAddress,
          auth_token: preflightAuthToken,
        });
      } catch {
        // Best-effort. Don't mask the real settle error with a receipt-POST error.
      }
    }
    throw err;
  }
  const contentType = response.headers.get("content-type") ?? "";
  const rawBody = contentType.includes("application/json")
    ? JSON.stringify(await response.json())
    : await response.text();

  // Token-safe content (XEN-412): a paid resource is often a full webpage or
  // dataset (tens of KB). Returning it whole as the tool result blows the MCP
  // token limit and floods the caller's context. Persist the full body to a
  // file and return only bounded metadata + a readable preview — the agent
  // gets the content (read the file for the rest) without detonating context.
  const contentLength = rawBody.length;
  const PREVIEW_CHARS = 2000;
  let contentFile: string | null = null;
  try {
    const dir = join(homedir(), ".xenarch", "paid");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const ext = contentType.includes("json")
      ? "json"
      : contentType.includes("html")
        ? "html"
        : "txt";
    // gate_id is a platform-issued UUID, but it lands in a filesystem path —
    // strip anything but [A-Za-z0-9_-] so a malformed id can't traverse out.
    const safeId = gate.gate_id.replace(/[^a-zA-Z0-9_-]/g, "_");
    contentFile = join(dir, `${safeId}.${ext}`);
    await writeFile(contentFile, rawBody, { mode: 0o600 });
  } catch {
    // Best-effort. If we can't persist it, the preview still carries content.
    contentFile = null;
  }
  // For HTML, strip tags so the preview is readable text, not <head> boilerplate.
  let previewSource = rawBody;
  if (contentType.includes("html")) {
    previewSource = rawBody
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const contentTruncated = previewSource.length > PREVIEW_CHARS;
  const contentPreview = contentTruncated
    ? previewSource.slice(0, PREVIEW_CHARS) + "…"
    : previewSource;

  // Best-effort platform-side verification using the on-chain tx_hash.
  // Platform looks up the USDC Transfer event each call (stateless).
  let verified = null;
  if (result.txHash) {
    try {
      verified = await verifyPayment(config.apiBase, gate.gate_id, result.txHash);
    } catch {
      // Verification is advisory — don't fail the user request if the
      // platform is unreachable; the on-chain payment itself is canonical.
    }
  }

  // Agent control plane (XEN-372): fire-and-forget receipt report.
  // No-op without XENARCH_API_TOKEN. Never blocks the pay flow.
  // XEN-373: forward the preflight auth_token so the platform marks the
  // receipt chain-verified.
  if (result.txHash) {
    await reportReceipt(config.apiBase, {
      url: resourceUrl,
      amount_usd: amountUsdForPreflight,
      source: "mcp",
      status: "paid",
      paid_at: new Date().toISOString(),
      tx_hash: result.txHash,
      facilitator: result.facilitator,
      wallet_address: walletAddress,
      auth_token: preflightAuthToken,
    });
  }

  return {
    success: true,
    gate_id: gate.gate_id,
    tx_hash: result.txHash,
    facilitator: result.facilitator,
    seller_wallet: gate.seller_wallet,
    url: resourceUrl,
    wallet: walletAddress,
    content_type: contentType || null,
    content_length: contentLength,
    content_truncated: contentTruncated,
    content_preview: contentPreview,
    content_file: contentFile,
    verified,
  };
}
