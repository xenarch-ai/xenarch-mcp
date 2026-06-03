// Agent control-plane tools (XEN-409) — MCP parity with the `xenarch agent`
// CLI commands. Manage caps, scope, pause, API keys, and receipts for the
// operator's agent.
//
// Auth: the control plane (/v1/me/agent/*) is SIWE-owner-authed via the
// `xen_session` cookie. The MCP can't do interactive WalletConnect signing,
// so it reuses the session the CLI's `xenarch agent login` writes to
// ~/.xenarch/config.json (config.sessionToken), or XENARCH_SESSION_TOKEN.
//
// Tier-2 gate: privileged ops (raising/removing a cap, loosening scope, key
// lifecycle, resume) require `confirm: true`. Without it, the handler returns
// a `needs_confirmation` payload describing the change instead of performing
// it — so the human sees and approves the mutation. Tightening + reads are free.

import { z } from "zod";
import {
  getMeAgent,
  getAgentSummary,
  getAgentCaps,
  putAgentCaps,
  resetAgentDayCap,
  getAgentScope,
  putAgentScope,
  setAgentPause,
  listAgentKeys,
  createAgentKey,
  rotateAgentKey,
  revokeAgentKey,
  listAgentReceipts,
} from "@xenarch/core";
import type {
  XenarchConfig,
  AgentCaps,
  AgentCapsPut,
  ScopeMode,
  ScopeRuleInput,
} from "@xenarch/core";

// --- shared helpers --------------------------------------------------------

function requireSession(config: XenarchConfig): string {
  const token = config.sessionToken;
  if (!token) {
    throw new Error(
      "Not signed in to the agent control plane. Run `xenarch agent login` " +
        "in the Xenarch CLI (it writes the SIWE session to " +
        "~/.xenarch/config.json), or set XENARCH_SESSION_TOKEN.",
    );
  }
  if (
    config.sessionExpiresAt &&
    Date.parse(config.sessionExpiresAt) < Date.now()
  ) {
    throw new Error(
      "Agent control-plane session expired. Run `xenarch agent login` to refresh.",
    );
  }
  return token;
}

function needsConfirmation(action: string, detail: string) {
  return {
    needs_confirmation: true,
    action,
    message:
      `${detail} This is a privileged change — re-invoke this tool with ` +
      `confirm: true to proceed.`,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a full UUID or an unambiguous id prefix to a full key id. */
async function resolveKeyId(
  apiBase: string,
  token: string,
  idOrPrefix: string,
): Promise<string> {
  if (UUID_RE.test(idOrPrefix)) return idOrPrefix;
  const keys = await listAgentKeys(apiBase, token);
  const matches = keys.filter((k) => k.id.startsWith(idOrPrefix));
  if (matches.length === 0) {
    throw new Error(`No API key matches id "${idOrPrefix}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous key id "${idOrPrefix}" (matches ${matches.length}); use the full UUID.`,
    );
  }
  return matches[0].id;
}

function parseCapAxis(
  axis: keyof AgentCapsPut,
  raw: string | undefined,
  next: AgentCapsPut,
): void {
  if (raw === undefined) return; // unchanged
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "off" || v === "") {
    next[axis] = null;
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid amount for ${axis}: ${raw}`);
  }
  next[axis] = raw.trim();
}

/** A cap change "loosens" if it removes a cap or raises a numeric one. */
function capsLoosened(before: AgentCaps, after: AgentCapsPut): boolean {
  return (["per_tx_usd", "daily_usd", "monthly_usd"] as const).some((axis) => {
    const b = before[axis];
    const a = after[axis];
    if (b !== null && a === null) return true; // cap removed
    if (b !== null && a !== null && Number(a) > Number(b)) return true; // raised
    return false;
  });
}

// --- status ---------------------------------------------------------------

export const agentStatusSchema = z.object({
  period: z
    .enum(["24h", "7d", "30d", "all"])
    .default("24h")
    .describe("Spend-summary window."),
});
export type AgentStatusInput = z.infer<typeof agentStatusSchema>;

export async function agentStatus(input: AgentStatusInput, config: XenarchConfig) {
  const token = requireSession(config);
  const [profile, summary] = await Promise.all([
    getMeAgent(config.apiBase, token),
    getAgentSummary(config.apiBase, token, input.period),
  ]);
  return { profile, summary };
}

// --- caps -----------------------------------------------------------------

export const agentGetCapsSchema = z.object({});
export type AgentGetCapsInput = z.infer<typeof agentGetCapsSchema>;
export async function agentGetCaps(_input: AgentGetCapsInput, config: XenarchConfig) {
  return getAgentCaps(config.apiBase, requireSession(config));
}

export const agentSetCapsSchema = z.object({
  per_tx: z
    .string()
    .optional()
    .describe("Per-transaction cap in USD, or 'none' to disable. Omit to leave unchanged."),
  daily: z
    .string()
    .optional()
    .describe("Daily cap in USD, or 'none' to disable. Omit to leave unchanged."),
  monthly: z
    .string()
    .optional()
    .describe("Monthly cap in USD, or 'none' to disable. Omit to leave unchanged."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true to RAISE or REMOVE a cap (a loosening change)."),
});
export type AgentSetCapsInput = z.infer<typeof agentSetCapsSchema>;

export async function agentSetCaps(input: AgentSetCapsInput, config: XenarchConfig) {
  const token = requireSession(config);
  const current = await getAgentCaps(config.apiBase, token);
  const next: AgentCapsPut = {
    per_tx_usd: current.per_tx_usd,
    daily_usd: current.daily_usd,
    monthly_usd: current.monthly_usd,
  };
  parseCapAxis("per_tx_usd", input.per_tx, next);
  parseCapAxis("daily_usd", input.daily, next);
  parseCapAxis("monthly_usd", input.monthly, next);

  if (capsLoosened(current, next) && !input.confirm) {
    return needsConfirmation(
      "raise_or_remove_cap",
      "You are raising or removing a spending cap, which widens what the agent may spend.",
    );
  }
  return putAgentCaps(config.apiBase, token, next);
}

export const agentResetDayCapSchema = z.object({});
export type AgentResetDayCapInput = z.infer<typeof agentResetDayCapSchema>;
export async function agentResetDayCap(_input: AgentResetDayCapInput, config: XenarchConfig) {
  return resetAgentDayCap(config.apiBase, requireSession(config));
}

// --- scope ----------------------------------------------------------------

export const agentGetScopeSchema = z.object({});
export type AgentGetScopeInput = z.infer<typeof agentGetScopeSchema>;
export async function agentGetScope(_input: AgentGetScopeInput, config: XenarchConfig) {
  return getAgentScope(config.apiBase, requireSession(config));
}

export const agentAddScopeRuleSchema = z.object({
  pattern: z.string().min(1).describe("URL/domain glob the rule matches, e.g. 'api.example.com/*'."),
  mode: z.enum(["allow", "deny"]).describe("'deny' blocks (tightens); 'allow' permits (loosens — needs confirm)."),
  label: z.string().optional().describe("Optional human label for the rule."),
  confirm: z.boolean().default(false).describe("Required true for an 'allow' rule (loosens scope)."),
});
export type AgentAddScopeRuleInput = z.infer<typeof agentAddScopeRuleSchema>;

export async function agentAddScopeRule(input: AgentAddScopeRuleInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (input.mode === "allow" && !input.confirm) {
    return needsConfirmation(
      "add_allow_rule",
      `Adding an allow rule for "${input.pattern}" widens what the agent may pay for.`,
    );
  }
  const scope = await getAgentScope(config.apiBase, token);
  const rules: ScopeRuleInput[] = scope.rules.map((r) => ({
    pattern: r.pattern,
    mode: r.mode,
    label: r.label,
  }));
  rules.push({ pattern: input.pattern, mode: input.mode, label: input.label ?? null });
  return putAgentScope(config.apiBase, token, scope.default_mode, rules);
}

export const agentRemoveScopeRuleSchema = z.object({
  id: z.string().min(1).describe("Scope rule id (full UUID or unambiguous prefix from get_scope)."),
  confirm: z.boolean().default(false).describe("Required true when removing a DENY rule (loosens scope)."),
});
export type AgentRemoveScopeRuleInput = z.infer<typeof agentRemoveScopeRuleSchema>;

export async function agentRemoveScopeRule(input: AgentRemoveScopeRuleInput, config: XenarchConfig) {
  const token = requireSession(config);
  const scope = await getAgentScope(config.apiBase, token);
  const target = scope.rules.find((r) => r.id === input.id || r.id.startsWith(input.id));
  if (!target) throw new Error(`No scope rule matches id "${input.id}".`);
  if (target.mode === "deny" && !input.confirm) {
    return needsConfirmation(
      "remove_deny_rule",
      `Removing deny rule "${target.pattern}" lets the agent pay for it again.`,
    );
  }
  const rules: ScopeRuleInput[] = scope.rules
    .filter((r) => r.id !== target.id)
    .map((r) => ({ pattern: r.pattern, mode: r.mode, label: r.label }));
  return putAgentScope(config.apiBase, token, scope.default_mode, rules);
}

export const agentSetDefaultScopeSchema = z.object({
  mode: z.enum(["allow", "deny"]).describe("Default posture for unmatched URLs. 'allow' loosens — needs confirm."),
  confirm: z.boolean().default(false).describe("Required true to switch the default to 'allow'."),
});
export type AgentSetDefaultScopeInput = z.infer<typeof agentSetDefaultScopeSchema>;

export async function agentSetDefaultScope(input: AgentSetDefaultScopeInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (input.mode === "allow" && !input.confirm) {
    return needsConfirmation(
      "default_allow",
      "Switching to default-allow lets the agent pay for anything not explicitly denied.",
    );
  }
  const scope = await getAgentScope(config.apiBase, token);
  const rules: ScopeRuleInput[] = scope.rules.map((r) => ({
    pattern: r.pattern,
    mode: r.mode,
    label: r.label,
  }));
  return putAgentScope(config.apiBase, token, input.mode as ScopeMode, rules);
}

// --- pause / resume -------------------------------------------------------

export const agentPauseSchema = z.object({});
export type AgentPauseInput = z.infer<typeof agentPauseSchema>;
export async function agentPause(_input: AgentPauseInput, config: XenarchConfig) {
  return setAgentPause(config.apiBase, requireSession(config), true);
}

export const agentResumeSchema = z.object({
  confirm: z.boolean().default(false).describe("Required true: resuming re-enables the agent's spending."),
});
export type AgentResumeInput = z.infer<typeof agentResumeSchema>;
export async function agentResume(input: AgentResumeInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "resume",
      "Resuming lets the agent spend again, subject to its caps and scope.",
    );
  }
  return setAgentPause(config.apiBase, token, false);
}

// --- keys -----------------------------------------------------------------

export const agentListKeysSchema = z.object({});
export type AgentListKeysInput = z.infer<typeof agentListKeysSchema>;
export async function agentListKeys(_input: AgentListKeysInput, config: XenarchConfig) {
  return listAgentKeys(config.apiBase, requireSession(config));
}

export const agentCreateKeySchema = z.object({
  label: z.string().optional().describe("Optional label for the new key."),
  confirm: z.boolean().default(false).describe("Required true: issues a live xa_live_ spending credential."),
});
export type AgentCreateKeyInput = z.infer<typeof agentCreateKeySchema>;
export async function agentCreateKey(input: AgentCreateKeyInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "create_key",
      "Creating an API key issues a new credential that can spend on the agent's behalf.",
    );
  }
  return createAgentKey(config.apiBase, token, input.label ?? null);
}

export const agentRotateKeySchema = z.object({
  key_id: z.string().min(1).describe("Key id (full UUID or unambiguous prefix)."),
  confirm: z.boolean().default(false).describe("Required true: invalidates the key's current secret."),
});
export type AgentRotateKeyInput = z.infer<typeof agentRotateKeySchema>;
export async function agentRotateKey(input: AgentRotateKeyInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation("rotate_key", `Rotating key ${input.key_id} invalidates its current secret.`);
  }
  const id = await resolveKeyId(config.apiBase, token, input.key_id);
  return rotateAgentKey(config.apiBase, token, id);
}

export const agentRevokeKeySchema = z.object({
  key_id: z.string().min(1).describe("Key id (full UUID or unambiguous prefix)."),
  confirm: z.boolean().default(false).describe("Required true: permanently disables the key."),
});
export type AgentRevokeKeyInput = z.infer<typeof agentRevokeKeySchema>;
export async function agentRevokeKey(input: AgentRevokeKeyInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation("revoke_key", `Revoking key ${input.key_id} permanently disables it.`);
  }
  const id = await resolveKeyId(config.apiBase, token, input.key_id);
  await revokeAgentKey(config.apiBase, token, id);
  return { revoked: true, id };
}

// --- receipts -------------------------------------------------------------

export const agentGetReceiptsSchema = z.object({
  period: z.enum(["24h", "7d", "30d", "all"]).default("all").describe("Time window."),
  status: z.enum(["paid", "pending", "failed"]).optional().describe("Filter by status."),
  source: z.enum(["cli", "mcp", "sdk", "custom"]).optional().describe("Filter by source channel."),
  domain: z.string().optional().describe("Filter by domain."),
  page: z.number().int().min(1).default(1).describe("Page number."),
  per_page: z.number().int().min(1).max(100).default(25).describe("Rows per page (max 100)."),
});
export type AgentGetReceiptsInput = z.infer<typeof agentGetReceiptsSchema>;
export async function agentGetReceipts(input: AgentGetReceiptsInput, config: XenarchConfig) {
  const token = requireSession(config);
  const params = new URLSearchParams();
  params.set("period", input.period);
  if (input.status) params.set("status", input.status);
  if (input.source) params.set("source", input.source);
  if (input.domain) params.set("domain", input.domain);
  params.set("page", String(input.page));
  params.set("per_page", String(input.per_page));
  return listAgentReceipts(config.apiBase, token, params.toString());
}
