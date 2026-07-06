// Webhook MCP tools (XEN-517): per-pay-link webhooks (/v1/links/{id}/webhook*)
// and the agent-level webhook (/v1/me/agent/webhooks*). SIWE-session-authed.
// Note the two surfaces return different shapes (agent rotate returns
// `secret`, link rotate returns `webhook_secret`).

import { z } from "zod";
import {
  getLinkWebhook,
  putLinkWebhook,
  rotateLinkWebhookSecret,
  testLinkWebhook,
  listLinkWebhookDeliveries,
  retryLinkWebhookDelivery,
  getAgentWebhook,
  putAgentWebhook,
  rotateAgentWebhookSecret,
  testAgentWebhook,
  listAgentWebhookDeliveries,
  retryAgentWebhookDelivery,
} from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

// --- pay-link webhooks ---------------------------------------------------------

export const getLinkWebhookSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
});
export type GetLinkWebhookInput = z.infer<typeof getLinkWebhookSchema>;
export async function getLinkWebhookTool(input: GetLinkWebhookInput, config: XenarchConfig) {
  return getLinkWebhook(config.apiBase, requireSession(config), input.link_id);
}

export const setLinkWebhookSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  url: z.string().url().describe("HTTPS endpoint to deliver events to."),
  event_types: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Event types to deliver; null/omitted = all available types."),
  enabled: z
    .boolean()
    .describe(
      "Whether deliveries are active. REQUIRED — this is a whole-state PUT; read the current config first to preserve the existing enabled state.",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: changes where payment events are sent."),
});
export type SetLinkWebhookInput = z.infer<typeof setLinkWebhookSchema>;
export async function setLinkWebhookTool(input: SetLinkWebhookInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "set_link_webhook",
      `This points pay-link ${input.link_id}'s webhook at ${input.url} (enabled: ${input.enabled}) — payment events will be delivered there.`,
    );
  }
  return putLinkWebhook(config.apiBase, token, input.link_id, {
    url: input.url,
    event_types: input.event_types ?? null,
    enabled: input.enabled,
  });
}

export const rotateLinkWebhookSecretSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: invalidates the current signing secret."),
});
export type RotateLinkWebhookSecretInput = z.infer<typeof rotateLinkWebhookSecretSchema>;
export async function rotateLinkWebhookSecretTool(
  input: RotateLinkWebhookSecretInput,
  config: XenarchConfig,
) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "rotate_link_webhook_secret",
      `This rotates the webhook signing secret of pay-link ${input.link_id} — the receiver must switch to the new secret or signature checks fail.`,
    );
  }
  return rotateLinkWebhookSecret(config.apiBase, token, input.link_id);
}

export const testLinkWebhookSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: fires a real test delivery at the configured URL."),
});
export type TestLinkWebhookInput = z.infer<typeof testLinkWebhookSchema>;
export async function testLinkWebhookTool(input: TestLinkWebhookInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "test_link_webhook",
      `This sends a test event to pay-link ${input.link_id}'s configured webhook URL.`,
    );
  }
  return testLinkWebhook(config.apiBase, token, input.link_id);
}

export const getLinkWebhookDeliveriesSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  limit: z.number().int().min(1).max(200).optional().describe("Rows (default 50)."),
});
export type GetLinkWebhookDeliveriesInput = z.infer<typeof getLinkWebhookDeliveriesSchema>;
export async function getLinkWebhookDeliveriesTool(
  input: GetLinkWebhookDeliveriesInput,
  config: XenarchConfig,
) {
  const qs = new URLSearchParams();
  if (input.limit) qs.set("limit", String(input.limit));
  return listLinkWebhookDeliveries(
    config.apiBase,
    requireSession(config),
    input.link_id,
    qs.toString(),
  );
}

export const retryLinkWebhookDeliverySchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  delivery_id: z.string().min(1).describe("The delivery id to retry."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: re-sends the event to the webhook URL."),
});
export type RetryLinkWebhookDeliveryInput = z.infer<typeof retryLinkWebhookDeliverySchema>;
export async function retryLinkWebhookDeliveryTool(
  input: RetryLinkWebhookDeliveryInput,
  config: XenarchConfig,
) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "retry_link_webhook_delivery",
      `This re-sends delivery ${input.delivery_id} of pay-link ${input.link_id} to the configured webhook URL.`,
    );
  }
  return retryLinkWebhookDelivery(config.apiBase, token, input.link_id, input.delivery_id);
}

// --- agent webhooks --------------------------------------------------------------

export const getAgentWebhookSchema = z.object({});
export type GetAgentWebhookInput = z.infer<typeof getAgentWebhookSchema>;
export async function getAgentWebhookTool(_input: GetAgentWebhookInput, config: XenarchConfig) {
  return getAgentWebhook(config.apiBase, requireSession(config));
}

export const setAgentWebhookSchema = z.object({
  url: z.string().url().describe("HTTPS endpoint to deliver agent events to."),
  event_types: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Event types to deliver; null/omitted = all available types."),
  enabled: z
    .boolean()
    .describe(
      "Whether deliveries are active. REQUIRED — this is a whole-state PUT; read the current config first to preserve the existing enabled state.",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: changes where the agent's events are sent."),
});
export type SetAgentWebhookInput = z.infer<typeof setAgentWebhookSchema>;
export async function setAgentWebhookTool(input: SetAgentWebhookInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "set_agent_webhook",
      `This points the agent's webhook at ${input.url} (enabled: ${input.enabled}) — spend/receipt events will be delivered there.`,
    );
  }
  return putAgentWebhook(config.apiBase, token, {
    url: input.url,
    event_types: input.event_types ?? null,
    enabled: input.enabled,
  });
}

export const rotateAgentWebhookSecretSchema = z.object({
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: invalidates the current signing secret."),
});
export type RotateAgentWebhookSecretInput = z.infer<typeof rotateAgentWebhookSecretSchema>;
export async function rotateAgentWebhookSecretTool(
  input: RotateAgentWebhookSecretInput,
  config: XenarchConfig,
) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "rotate_agent_webhook_secret",
      "This rotates the agent webhook's signing secret — the receiver must switch to the new secret or signature checks fail.",
    );
  }
  return rotateAgentWebhookSecret(config.apiBase, token);
}

export const testAgentWebhookSchema = z.object({
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: fires a real test delivery at the configured URL."),
});
export type TestAgentWebhookInput = z.infer<typeof testAgentWebhookSchema>;
export async function testAgentWebhookTool(input: TestAgentWebhookInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "test_agent_webhook",
      "This sends a test event to the agent's configured webhook URL.",
    );
  }
  return testAgentWebhook(config.apiBase, token);
}

export const getAgentWebhookDeliveriesSchema = z.object({
  limit: z.number().int().min(1).max(200).optional().describe("Rows (default 50)."),
});
export type GetAgentWebhookDeliveriesInput = z.infer<typeof getAgentWebhookDeliveriesSchema>;
export async function getAgentWebhookDeliveriesTool(
  input: GetAgentWebhookDeliveriesInput,
  config: XenarchConfig,
) {
  const qs = new URLSearchParams();
  if (input.limit) qs.set("limit", String(input.limit));
  return listAgentWebhookDeliveries(config.apiBase, requireSession(config), qs.toString());
}

export const retryAgentWebhookDeliverySchema = z.object({
  delivery_id: z.string().min(1).describe("The delivery id to retry."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: re-sends the event to the webhook URL."),
});
export type RetryAgentWebhookDeliveryInput = z.infer<typeof retryAgentWebhookDeliverySchema>;
export async function retryAgentWebhookDeliveryTool(
  input: RetryAgentWebhookDeliveryInput,
  config: XenarchConfig,
) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "retry_agent_webhook_delivery",
      `This re-sends agent webhook delivery ${input.delivery_id} to the configured URL.`,
    );
  }
  return retryAgentWebhookDelivery(config.apiBase, token, input.delivery_id);
}
