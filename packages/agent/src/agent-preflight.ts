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
// XEN-480: no token → ALSO refuse (an unlinked agent has no caps/scope,
// so the official client must not pay uncapped).

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
  // XEN-374 cap context — present on cap denies.
  remaining_today?: string | null;
  remaining_month?: string | null;
  resets_today_at?: string | null;
  resets_month_at?: string | null;
  cap_per_tx?: string | null;
  cap_daily?: string | null;
  cap_monthly?: string | null;
}

export interface PreflightUnreachable {
  ok: false;
  // "not_connected" (XEN-480: no XENARCH_API_TOKEN → fail-closed, the agent
  // isn't linked so it has no caps/scope) or "control_plane_unreachable"
  // (token set but the platform didn't answer — also fail-closed).
  reason: "control_plane_unreachable" | "not_connected";
  detail: string;
}

export type PreflightResult =
  | PreflightAllow
  | PreflightDeny
  | PreflightUnreachable;

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
  if (result.reason === "per_tx_cap") {
    const cap = result.cap_per_tx ?? "?";
    return [
      `Refused by Xenarch control plane: per-transaction cap exceeded (max $${cap}).`,
      "Raise the cap at https://dash.xenarch.dev/agent/caps",
    ].join(" ");
  }
  if (result.reason === "daily_cap") {
    const cap = result.cap_daily ?? "?";
    const spent = result.cap_daily && result.remaining_today
      ? subtractMoney(result.cap_daily, result.remaining_today)
      : null;
    const resetsIn = humanResetIn(result.resets_today_at);
    const spentTxt = spent !== null ? `$${spent} spent of $${cap}` : `cap $${cap}`;
    const resetTxt = resetsIn ? ` Resets in ${resetsIn}.` : "";
    return [
      `Refused by Xenarch control plane: daily cap exceeded (${spentTxt}).${resetTxt}`,
      "Edit cap at https://dash.xenarch.dev/agent/caps",
    ].join(" ");
  }
  if (result.reason === "monthly_cap") {
    const cap = result.cap_monthly ?? "?";
    const spent = result.cap_monthly && result.remaining_month
      ? subtractMoney(result.cap_monthly, result.remaining_month)
      : null;
    const resetsIn = humanResetIn(result.resets_month_at);
    const spentTxt = spent !== null ? `$${spent} spent of $${cap}` : `cap $${cap}`;
    const resetTxt = resetsIn ? ` Resets in ${resetsIn}.` : "";
    return [
      `Refused by Xenarch control plane: monthly cap exceeded (${spentTxt}).${resetTxt}`,
      "Edit cap at https://dash.xenarch.dev/agent/caps",
    ].join(" ");
  }
  return `Refused by Xenarch control plane: ${result.reason}`;
}

function humanResetIn(isoTimestamp: string | null | undefined): string | null {
  if (!isoTimestamp) return null;
  // Defensive: ECMAScript Date.parse on a tz-naive ISO string is
  // implementation-defined. Force UTC if the platform ever drops the
  // tz suffix.
  const stamp = /[Zz]|[+\-]\d{2}:?\d{2}$/.test(isoTimestamp)
    ? isoTimestamp
    : isoTimestamp + "Z";
  const target = Date.parse(stamp);
  if (!Number.isFinite(target)) return null;
  const ms = target - Date.now();
  if (ms <= 0) return null;
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function subtractMoney(a: string, b: string): string | null {
  const an = Number.parseFloat(a);
  const bn = Number.parseFloat(b);
  if (!Number.isFinite(an) || !Number.isFinite(bn)) return null;
  const diff = an - bn;
  if (diff < 0) return "0.00";
  return diff.toFixed(2);
}

export async function checkPreflight(
  apiBase: string,
  url: string,
  amountUsd: string,
): Promise<PreflightResult> {
  const token = process.env[ENV_TOKEN];
  if (!token) {
    // XEN-480: fail-closed. An unlinked agent has no caps/scope, so the
    // MCP server refuses to pay rather than settling uncapped.
    return {
      ok: false,
      reason: "not_connected",
      detail:
        "Not connected to the Xenarch control plane — set XENARCH_API_TOKEN (run `xenarch agent login`) so payments are capped.",
    };
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
