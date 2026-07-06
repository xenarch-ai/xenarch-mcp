// Subscriber lifecycle + collections MCP tools (XEN-517) — the read/manage
// half of the subscribers surface. SIWE-session-authed like merchant.ts.
// The on-chain collect tools (broadcasting USDC.permit / transferFrom) live
// in collect.ts — everything here is API-only, no signing.

import { z } from "zod";
import {
  getSubscriber,
  listSubscriberCharges,
  getSubscribersRollup,
  merchantCancelSubscriber,
  suspendSubscriber,
  mintManageLink,
  setPeriodCap,
  listPermitCollectable,
  listMeteredCollectable,
  firePermitDigest,
} from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

// --- reads -------------------------------------------------------------------

export const getSubscriberSchema = z.object({
  subscription_id: z.string().min(1).describe("The subscription id."),
});
export type GetSubscriberInput = z.infer<typeof getSubscriberSchema>;
export async function getSubscriberTool(input: GetSubscriberInput, config: XenarchConfig) {
  return getSubscriber(config.apiBase, requireSession(config), input.subscription_id);
}

export const getSubscriberChargesSchema = z.object({
  subscription_id: z.string().min(1).describe("The subscription id."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 100)."),
  starting_after: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Cursor: last charge_seq of the previous page."),
});
export type GetSubscriberChargesInput = z.infer<typeof getSubscriberChargesSchema>;
export async function getSubscriberCharges(
  input: GetSubscriberChargesInput,
  config: XenarchConfig,
) {
  const qs = new URLSearchParams();
  if (input.limit) qs.set("limit", String(input.limit));
  if (input.starting_after) qs.set("starting_after", String(input.starting_after));
  return listSubscriberCharges(
    config.apiBase,
    requireSession(config),
    input.subscription_id,
    qs.toString(),
  );
}

export const getSubscriberRollupSchema = z.object({});
export type GetSubscriberRollupInput = z.infer<typeof getSubscriberRollupSchema>;
export async function getSubscriberRollup(
  _input: GetSubscriberRollupInput,
  config: XenarchConfig,
) {
  return getSubscribersRollup(config.apiBase, requireSession(config));
}

// --- lifecycle ---------------------------------------------------------------

export const cancelSubscriberSchema = z.object({
  subscription_id: z.string().min(1).describe("The subscription id to cancel."),
  confirm: z.boolean().default(false).describe("Required true: ends the subscription."),
});
export type CancelSubscriberInput = z.infer<typeof cancelSubscriberSchema>;
export async function cancelSubscriber(input: CancelSubscriberInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "cancel_subscriber",
      `This permanently cancels subscription ${input.subscription_id} — the buyer stops being billed and cannot be reinstated by you. Reminder-mode only (409 otherwise).`,
    );
  }
  return merchantCancelSubscriber(config.apiBase, token, input.subscription_id);
}

export const suspendSubscriberSchema = z.object({
  subscription_id: z.string().min(1).describe("The subscription id to suspend."),
  confirm: z.boolean().default(false).describe("Required true: stops billing/dunning."),
});
export type SuspendSubscriberInput = z.infer<typeof suspendSubscriberSchema>;
export async function suspendSubscriberTool(
  input: SuspendSubscriberInput,
  config: XenarchConfig,
) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "suspend_subscriber",
      `This suspends subscription ${input.subscription_id}: collection attempts and dunning stop. Idempotent, no on-chain effect.`,
    );
  }
  return suspendSubscriber(config.apiBase, token, input.subscription_id);
}

export const mintManageLinkSchema = z.object({
  subscription_id: z.string().min(1).describe("The subscription id."),
  ttl_seconds: z
    .number()
    .int()
    .min(60)
    .optional()
    .describe("Link lifetime in seconds (server default if omitted)."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: mints a live manage capability URL."),
});
export type MintManageLinkInput = z.infer<typeof mintManageLinkSchema>;
export async function mintManageLinkTool(input: MintManageLinkInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "mint_manage_link",
      `This mints a short-lived manage URL for subscription ${input.subscription_id} — anyone holding it can view and manage that subscription until it expires.`,
    );
  }
  return mintManageLink(config.apiBase, token, input.subscription_id, input.ttl_seconds);
}

export const setPeriodCapSchema = z.object({
  subscription_id: z.string().min(1).describe("The subscription id (metered-per-period mode)."),
  new_cap_usdc: z
    .string()
    .min(1)
    .describe("New per-period budget in USDC, e.g. '0.50'. Can only be set or raised."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: raises what may be charged per period."),
});
export type SetPeriodCapInput = z.infer<typeof setPeriodCapSchema>;
export async function setPeriodCapTool(input: SetPeriodCapInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "set_period_cap",
      `This sets/raises the per-period budget of subscription ${input.subscription_id} to ${input.new_cap_usdc} USDC — widening what can be charged each period.`,
    );
  }
  // The endpoint is manage-token gated (not SIWE): mint a manage token for
  // this subscription first, then pass it as the ?token= query.
  const manage = await mintManageLink(config.apiBase, token, input.subscription_id);
  return setPeriodCap(
    config.apiBase,
    token,
    input.subscription_id,
    manage.manage_token,
    input.new_cap_usdc,
  );
}

// --- collectable bags + digest -------------------------------------------------

export const listPermitCollectableSchema = z.object({
  link_id: z.string().optional().describe("Filter to one subscription pay-link."),
});
export type ListPermitCollectableInput = z.infer<typeof listPermitCollectableSchema>;
export async function listPermitCollectableTool(
  input: ListPermitCollectableInput,
  config: XenarchConfig,
) {
  const qs = new URLSearchParams();
  if (input.link_id) qs.set("link_id", input.link_id);
  return listPermitCollectable(config.apiBase, requireSession(config), qs.toString());
}

export const listMeteredCollectableSchema = z.object({
  link_id: z.string().optional().describe("Filter to one subscription pay-link."),
});
export type ListMeteredCollectableInput = z.infer<typeof listMeteredCollectableSchema>;
export async function listMeteredCollectableTool(
  input: ListMeteredCollectableInput,
  config: XenarchConfig,
) {
  const qs = new URLSearchParams();
  if (input.link_id) qs.set("link_id", input.link_id);
  return listMeteredCollectable(config.apiBase, requireSession(config), qs.toString());
}

export const firePermitDigestSchema = z.object({
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: sends a real email to the merchant."),
});
export type FirePermitDigestInput = z.infer<typeof firePermitDigestSchema>;
export async function firePermitDigestTool(
  input: FirePermitDigestInput,
  config: XenarchConfig,
) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "fire_permit_digest",
      "This drops the digest throttle and immediately re-sends the collectable digest email for your wallet.",
    );
  }
  return firePermitDigest(config.apiBase, token);
}
