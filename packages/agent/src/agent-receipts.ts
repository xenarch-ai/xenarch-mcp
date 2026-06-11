// Agent control plane receipt reporting (XEN-372 — Phase 2 of XEN-370).
//
// After every settled payment, the `xenarch_pay` MCP tool POSTs to
// /v1/agent/receipts with the operator's xa_live_* token
// (XENARCH_API_TOKEN) so the dashboard's receipts feed reflects MCP
// activity within seconds.
//
// Same shape as the CLI implementation (xenarch-sdks/cli/src/lib/
// agent-receipts.ts) but in-memory only — MCP servers are typically
// short-lived process trees driven by Claude Desktop / Cursor / Cline,
// so a JSONL backing file is more overhead than value. A failed POST
// drops the receipt; the next pay's drain pass will pick up anything
// queued in-memory for this session.

const ENV_TOKEN = "XENARCH_API_TOKEN";
const QUEUE_CAP = 100;
const REPORT_TIMEOUT_MS = 5000;

export interface ReceiptPayload {
  url: string;
  amount_usd: string;
  source: "cli" | "mcp" | "sdk" | "custom";
  status: "paid" | "pending" | "failed";
  paid_at: string;
  tx_hash?: string | null;
  facilitator?: string | null;
  wallet_address?: string | null;
  // XEN-373: chain-of-custody token from POST /v1/agent/preflight,
  // optional for Phase-2 backwards compat.
  auth_token?: string | null;
}

const queue: ReceiptPayload[] = [];

async function tryPost(
  apiBase: string,
  token: string,
  payload: ReceiptPayload,
): Promise<{ ok: boolean; terminal: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPORT_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/agent/receipts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": token,
        "User-Agent": "xenarch-mcp-agent",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, terminal: true };
    if (res.status >= 400 && res.status < 500) {
      return { ok: false, terminal: true };
    }
    return { ok: false, terminal: false };
  } catch {
    return { ok: false, terminal: false };
  } finally {
    clearTimeout(timer);
  }
}

async function drain(apiBase: string, token: string): Promise<void> {
  while (queue.length > 0) {
    const result = await tryPost(apiBase, token, queue[0]);
    if (result.ok || result.terminal) {
      queue.shift();
      continue;
    }
    // Transient failure — stop draining; pick up next pay.
    return;
  }
}

/**
 * Report a settled receipt to the agent control plane.
 *
 * - No `XENARCH_API_TOKEN` set → no-op (Phase-1 backwards compat).
 * - Network/5xx failures → queued for next call (memory-only).
 * - 4xx → dropped (bad token or malformed body).
 *
 * Never throws.
 */
export async function reportReceipt(
  apiBase: string,
  payload: ReceiptPayload,
): Promise<void> {
  const token = process.env[ENV_TOKEN];
  if (!token) return;
  try {
    queue.push(payload);
    while (queue.length > QUEUE_CAP) queue.shift();
    await drain(apiBase, token);
  } catch {
    // Never propagate receipt errors into the pay flow.
  }
}

/**
 * Log "control plane connected as ..." on startup so the operator
 * sees in the MCP server logs that their token took effect. Called
 * once from `index.ts`; safe to call multiple times (idempotent log).
 */
export function logControlPlaneStatus(): void {
  const token = process.env[ENV_TOKEN];
  if (token) {
    // Last 4 chars of the token (post-prefix) — enough to disambiguate
    // installs in logs without exposing the secret.
    const suffix = token.slice(-4);
    console.error(
      `[xenarch] agent control plane: connected (token …${suffix})`,
    );
  } else {
    console.error(
      "[xenarch] agent control plane: disabled (no XENARCH_API_TOKEN). " +
        "Payments work, but with no managed spend caps, scope rules, kill switch, or " +
        "payment history. Get them free — sign in with your wallet at " +
        "https://dash.xenarch.dev (just a signature, nothing moves), then run " +
        "`xenarch agent login`.",
    );
  }
}
