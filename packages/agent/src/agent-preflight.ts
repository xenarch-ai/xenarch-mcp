// Agent control plane preflight check (XEN-373 — Phase 3 of XEN-370).
//
// Same shape as the CLI implementation (xenarch-sdks/cli/src/lib/
// agent-preflight.ts). Unlike receipts (best-effort, fire-and-forget),
// preflight BLOCKS the pay flow. When XENARCH_API_TOKEN is set, the
// MCP `xenarch_pay` tool calls POST /v1/agent/preflight before
// settlement. On deny we return a refusal message to the LLM caller as
// tool content (not a thrown error), so models surface the operator's
// dashboard URL cleanly instead of choking on an exception.
//
// Fail-closed: token configured + control plane unreachable → refuse.
// No token → bypass (Phase-1 backwards compat).

const ENV_TOKEN = "XENARCH_API_TOKEN";
const PREFLIGHT_TIMEOUT_MS = 5000;

export interface PreflightMatchedRule {
  id?: string | null;
  pattern: string;
  mode: "allow" | "deny";
  label?: string | null;
}

export interface PreflightAllow {
  ok: true;
  auth_token: string;
  expires_in: number;
}

export interface PreflightDeny {
  ok: false;
  reason: string;
  matched_rule?: PreflightMatchedRule | null;
}

export interface PreflightUnreachable {
  ok: false;
  reason: "control_plane_unreachable";
  detail: string;
}

export interface PreflightBypassed {
  ok: true;
  auth_token: null;
  expires_in: 0;
  bypassed: true;
}

export type PreflightResult =
  | PreflightAllow
  | PreflightDeny
  | PreflightUnreachable
  | PreflightBypassed;

export function formatDenyMessage(result: PreflightDeny): string {
  if (result.reason === "paused") {
    return [
      "Refused by Xenarch control plane: agent is paused.",
      "Toggle the kill switch off at https://dash.xenarch.dev/agent/scope",
    ].join(" ");
  }
  if (result.reason === "scope" && result.matched_rule) {
    const pattern = result.matched_rule.pattern;
    const label = result.matched_rule.label
      ? ` ("${result.matched_rule.label}")`
      : "";
    return [
      `Refused by Xenarch control plane: scope rule '${pattern}'${label} matched this URL.`,
      "Edit rules at https://dash.xenarch.dev/agent/scope",
    ].join(" ");
  }
  return `Refused by Xenarch control plane: ${result.reason}`;
}

export async function checkPreflight(
  apiBase: string,
  url: string,
  amountUsd: string,
): Promise<PreflightResult> {
  const token = process.env[ENV_TOKEN];
  if (!token) {
    return { ok: true, auth_token: null, expires_in: 0, bypassed: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}/v1/agent/preflight`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Token": token,
        "User-Agent": "xenarch-mcp-agent",
      },
      body: JSON.stringify({ url, amount_usd: amountUsd }),
      signal: controller.signal,
    });
    if (res.status === 401) {
      return {
        ok: false,
        reason: "control_plane_unreachable",
        detail:
          "Token rejected (revoked or invalid). Re-issue at https://dash.xenarch.dev/agent/settings",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "control_plane_unreachable",
        detail: `Platform returned HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as PreflightResult;
    return body;
  } catch (err) {
    const kind = (err as Error).name || "NetworkError";
    return {
      ok: false,
      reason: "control_plane_unreachable",
      detail: `${kind} reaching control plane`,
    };
  } finally {
    clearTimeout(timer);
  }
}
