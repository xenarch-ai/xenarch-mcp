// Shared helpers for SIWE-session MCP tools (XEN-517). Same contract as the
// copies in control-plane.ts / merchant.ts — new tool modules import from here.

import type { XenarchConfig } from "@xenarch/core";

export function requireSession(config: XenarchConfig): string {
  const token = config.sessionToken;
  if (!token) {
    throw new Error(
      "Not signed in. Use xenarch_agent_login (browser device flow), or run " +
        "`xenarch agent login` in the Xenarch CLI, or set XENARCH_SESSION_TOKEN.",
    );
  }
  if (config.sessionExpiresAt && Date.parse(config.sessionExpiresAt) < Date.now()) {
    throw new Error("Session expired. Use xenarch_agent_login to refresh.");
  }
  return token;
}

/** The Tier-2 gate payload: describe the mutation instead of performing it. */
export function needsConfirmation(action: string, detail: string) {
  return {
    needs_confirmation: true,
    action,
    message: `${detail} Re-invoke this tool with confirm: true to proceed.`,
  };
}
