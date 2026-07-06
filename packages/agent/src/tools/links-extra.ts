// Pay-link detail surface MCP tools (XEN-517): metadata edit, events,
// rollup/summary KPIs, groups, and orders. SIWE-session-authed.

import { z } from "zod";
import {
  updateLinkMetadata,
  listLinkEvents,
  getLinksRollup,
  getLinksSummary,
  assignLinkGroup,
  listGroups,
  createGroup,
  updateGroup,
  deleteGroup,
  listOrders,
  shipOrder,
  exportOrdersCsv,
} from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

// --- link detail -------------------------------------------------------------

export const editLinkSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  metadata: z
    .record(z.any())
    .nullable()
    .describe("Whole-state metadata object to store on the link; null clears it."),
  confirm: z.boolean().default(false).describe("Required true: replaces the link's metadata."),
});
export type EditLinkInput = z.infer<typeof editLinkSchema>;
export async function editLink(input: EditLinkInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "edit_link",
      `This replaces the metadata of pay-link ${input.link_id} (whole-state: existing metadata is overwritten${input.metadata === null ? ", null clears it" : ""}).`,
    );
  }
  return updateLinkMetadata(config.apiBase, token, input.link_id, {
    metadata: input.metadata,
  });
}

export const getLinkEventsSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  types: z
    .string()
    .optional()
    .describe("Comma-separated event_type filter, e.g. 'paid,view'."),
  after: z.string().optional().describe("Cursor from the previous page."),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)."),
});
export type GetLinkEventsInput = z.infer<typeof getLinkEventsSchema>;
export async function getLinkEvents(input: GetLinkEventsInput, config: XenarchConfig) {
  const qs = new URLSearchParams();
  if (input.types) qs.set("types", input.types);
  if (input.after) qs.set("after", input.after);
  if (input.limit) qs.set("limit", String(input.limit));
  return listLinkEvents(config.apiBase, requireSession(config), input.link_id, qs.toString());
}

export const getLinksRollupSchema = z.object({});
export type GetLinksRollupInput = z.infer<typeof getLinksRollupSchema>;
export async function getLinksRollupTool(_input: GetLinksRollupInput, config: XenarchConfig) {
  return getLinksRollup(config.apiBase, requireSession(config));
}

export const getLinksSummarySchema = z.object({
  period: z.enum(["24h", "7d", "30d", "all"]).optional().describe("Summary window."),
});
export type GetLinksSummaryInput = z.infer<typeof getLinksSummarySchema>;
export async function getLinksSummaryTool(input: GetLinksSummaryInput, config: XenarchConfig) {
  const qs = new URLSearchParams();
  if (input.period) qs.set("period", input.period);
  return getLinksSummary(config.apiBase, requireSession(config), qs.toString());
}

// --- groups --------------------------------------------------------------------

export const listGroupsSchema = z.object({});
export type ListGroupsInput = z.infer<typeof listGroupsSchema>;
export async function listGroupsTool(_input: ListGroupsInput, config: XenarchConfig) {
  return listGroups(config.apiBase, requireSession(config));
}

export const createGroupSchema = z.object({
  name: z.string().min(1).describe("Group name."),
  accent_kind: z.string().optional().describe("Accent color kind (dashboard palette key)."),
  confirm: z.boolean().default(false).describe("Required true to create the group."),
});
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export async function createGroupTool(input: CreateGroupInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation("create_group", `This creates a pay-link group "${input.name}".`);
  }
  return createGroup(config.apiBase, token, {
    name: input.name,
    ...(input.accent_kind ? { accent_kind: input.accent_kind } : {}),
  });
}

export const updateGroupSchema = z.object({
  group_id: z.string().min(1).describe("The group id."),
  name: z.string().optional().describe("New name."),
  accent_kind: z.string().optional().describe("New accent kind."),
  position: z.number().int().optional().describe("New sort position."),
  confirm: z.boolean().default(false).describe("Required true to update the group."),
});
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
export async function updateGroupTool(input: UpdateGroupInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation("update_group", `This updates group ${input.group_id}.`);
  }
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.accent_kind !== undefined) body.accent_kind = input.accent_kind;
  if (input.position !== undefined) body.position = input.position;
  return updateGroup(config.apiBase, token, input.group_id, body);
}

export const deleteGroupSchema = z.object({
  group_id: z.string().min(1).describe("The group id to delete."),
  confirm: z.boolean().default(false).describe("Required true: deletes the group."),
});
export type DeleteGroupInput = z.infer<typeof deleteGroupSchema>;
export async function deleteGroupTool(input: DeleteGroupInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "delete_group",
      `This deletes group ${input.group_id} (member links become ungrouped; links themselves are untouched).`,
    );
  }
  await deleteGroup(config.apiBase, token, input.group_id);
  return { deleted: true, group_id: input.group_id };
}

export const assignLinkGroupSchema = z.object({
  link_id: z.string().min(1).describe("The pay-link id."),
  group_id: z
    .string()
    .nullable()
    .describe("Target group id, or null to ungroup the link."),
  confirm: z.boolean().default(false).describe("Required true to move the link."),
});
export type AssignLinkGroupInput = z.infer<typeof assignLinkGroupSchema>;
export async function assignLinkGroupTool(input: AssignLinkGroupInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "assign_link_group",
      input.group_id === null
        ? `This removes pay-link ${input.link_id} from its group.`
        : `This moves pay-link ${input.link_id} into group ${input.group_id}.`,
    );
  }
  return assignLinkGroup(config.apiBase, token, input.link_id, input.group_id);
}

// --- orders --------------------------------------------------------------------

export const listOrdersSchema = z.object({
  status: z.string().optional().describe("Filter by order status, e.g. 'paid' | 'shipped'."),
  search: z.string().optional().describe("Free-text search over buyer/product fields."),
  link_id: z.string().optional().describe("Filter to one pay-link."),
  limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25)."),
  starting_after: z.string().optional().describe("Cursor: last order_id of the previous page."),
});
export type ListOrdersInput = z.infer<typeof listOrdersSchema>;
export async function listOrdersTool(input: ListOrdersInput, config: XenarchConfig) {
  const qs = new URLSearchParams();
  if (input.status) qs.set("status", input.status);
  if (input.search) qs.set("search", input.search);
  if (input.link_id) qs.set("link_id", input.link_id);
  if (input.limit) qs.set("limit", String(input.limit));
  if (input.starting_after) qs.set("starting_after", input.starting_after);
  return listOrders(config.apiBase, requireSession(config), qs.toString());
}

export const shipOrderSchema = z.object({
  order_id: z.string().min(1).describe("The order id."),
  tracking: z.string().min(1).describe("Tracking number."),
  carrier: z.string().optional().describe("Carrier name, e.g. 'DHL'."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: marks shipped and emails the buyer the tracking."),
});
export type ShipOrderInput = z.infer<typeof shipOrderSchema>;
export async function shipOrderTool(input: ShipOrderInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "ship_order",
      `This marks order ${input.order_id} shipped with tracking "${input.tracking}" and notifies the buyer.`,
    );
  }
  return shipOrder(config.apiBase, token, input.order_id, {
    tracking: input.tracking,
    ...(input.carrier ? { carrier: input.carrier } : {}),
  });
}

export const exportOrdersSchema = z.object({
  status: z.string().optional().describe("Filter by order status."),
  link_id: z.string().optional().describe("Filter to one pay-link."),
});
export type ExportOrdersInput = z.infer<typeof exportOrdersSchema>;
export async function exportOrdersTool(input: ExportOrdersInput, config: XenarchConfig) {
  const qs = new URLSearchParams();
  if (input.status) qs.set("status", input.status);
  if (input.link_id) qs.set("link_id", input.link_id);
  const csv = await exportOrdersCsv(config.apiBase, requireSession(config), qs.toString());
  return { format: "csv", content: csv };
}
