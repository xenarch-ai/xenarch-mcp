// Remaining agent control-plane MCP tools (XEN-517): profile update + single
// receipt read. SIWE-session-authed like control-plane.ts.

import { z } from "zod";
import { updateMeAgent, getMeAgentReceipt } from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

export const updateAgentProfileSchema = z.object({
  display_name: z
    .string()
    .nullable()
    .optional()
    .describe("Agent display name; null clears it. Omit to leave unchanged."),
  label: z
    .string()
    .nullable()
    .optional()
    .describe("Short label/tag; null clears it. Omit to leave unchanged."),
  confirm: z.boolean().default(false).describe("Required true to update the profile."),
});
export type UpdateAgentProfileInput = z.infer<typeof updateAgentProfileSchema>;
export async function updateAgentProfile(input: UpdateAgentProfileInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (input.display_name === undefined && input.label === undefined) {
    throw new Error("Nothing to update: pass display_name and/or label.");
  }
  if (!input.confirm) {
    return needsConfirmation(
      "update_agent_profile",
      "This updates the agent's display profile (name/label).",
    );
  }
  const body: Record<string, unknown> = {};
  if (input.display_name !== undefined) body.display_name = input.display_name;
  if (input.label !== undefined) body.label = input.label;
  return updateMeAgent(config.apiBase, token, body);
}

export const getReceiptSchema = z.object({
  receipt_id: z.string().min(1).describe("The receipt id (from xenarch_agent_get_receipts)."),
});
export type GetReceiptInput = z.infer<typeof getReceiptSchema>;
export async function getReceipt(input: GetReceiptInput, config: XenarchConfig) {
  return getMeAgentReceipt(config.apiBase, requireSession(config), input.receipt_id);
}
