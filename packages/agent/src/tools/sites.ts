// Sites & gating MCP tools (XEN-517) — the publisher surface. SIWE-session
// routes (/v1/me/sites/*, /v1/me/publisher/*), NOT the legacy pk_-token
// /v1/sites routes. A merchant identity with no publisher row gets an empty
// list / 404s — publisher tools need a publisher-linked identity.

import { z } from "zod";
import {
  listMeSites,
  createMeSite,
  getMeSite,
  deleteMeSite,
  putSitePricing,
  putSiteGating,
  rotateSiteToken,
  getSiteStats,
  getSiteTransactions,
  getSiteCategoryBreakdown,
  getPublisherGating,
  putPublisherGating,
  createSiteClaim,
  getBotActivity,
  getBotCatalog,
} from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

const INTEGRATION_TYPES = ["wp", "joomla", "cf", "sdk", "cli", "custom"] as const;

// --- sites CRUD ---------------------------------------------------------------

export const listSitesSchema = z.object({});
export type ListSitesInput = z.infer<typeof listSitesSchema>;
export async function listSitesTool(_input: ListSitesInput, config: XenarchConfig) {
  return listMeSites(config.apiBase, requireSession(config));
}

export const addSiteSchema = z.object({
  integration_type: z
    .enum(INTEGRATION_TYPES)
    .describe("How the site integrates: wp | joomla | cf | sdk | cli | custom."),
  domain: z
    .string()
    .optional()
    .describe("Site domain, e.g. example.com. Optional — the integration backfills it."),
  confirm: z.boolean().default(false).describe("Required true to create the site."),
});
export type AddSiteInput = z.infer<typeof addSiteSchema>;
export async function addSite(input: AddSiteInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "add_site",
      `This creates a new site${input.domain ? ` for ${input.domain}` : ""} (${input.integration_type}) and issues its site token. Requires a verified account email (412 otherwise).`,
    );
  }
  return createMeSite(config.apiBase, token, {
    integration_type: input.integration_type,
    ...(input.domain ? { domain: input.domain } : {}),
  });
}

export const getSiteSchema = z.object({
  site_id: z.string().uuid().describe("The site id."),
});
export type GetSiteInput = z.infer<typeof getSiteSchema>;
export async function getSiteTool(input: GetSiteInput, config: XenarchConfig) {
  return getMeSite(config.apiBase, requireSession(config), input.site_id);
}

export const deleteSiteSchema = z.object({
  site_id: z.string().uuid().describe("The site id to delete."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: removes the site and stops its gating."),
});
export type DeleteSiteInput = z.infer<typeof deleteSiteSchema>;
export async function deleteSiteTool(input: DeleteSiteInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "delete_site",
      `This permanently deletes site ${input.site_id} — its token stops working and gating/pricing config is lost.`,
    );
  }
  await deleteMeSite(config.apiBase, token, input.site_id);
  return { deleted: true, site_id: input.site_id };
}

// --- gating & pricing ------------------------------------------------------------

export const setSiteGatingSchema = z.object({
  site_id: z.string().uuid().describe("The site id."),
  gating_enabled: z.boolean().describe("Master switch for gating on this site."),
  gated_categories: z
    .record(z.boolean())
    .describe(
      "Full category→gated map (whole-state replace), e.g. {\"AI Search\": true, \"Agents\": false}. Read the current map with xenarch_get_site first.",
    ),
  use_publisher_defaults: z
    .boolean()
    .default(false)
    .describe("true = follow the publisher-level defaults instead of per-site settings."),
  confirm: z.boolean().default(false).describe("Required true: changes who gets charged/blocked."),
});
export type SetSiteGatingInput = z.infer<typeof setSiteGatingSchema>;
export async function setSiteGating(input: SetSiteGatingInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "set_site_gating",
      `This replaces site ${input.site_id}'s gating config (enabled: ${input.gating_enabled}) — it changes which bot traffic is charged or blocked. Whole-state: the category map you pass fully replaces the current one.`,
    );
  }
  return putSiteGating(config.apiBase, token, input.site_id, {
    gating_enabled: input.gating_enabled,
    gated_categories: input.gated_categories,
    use_publisher_defaults: input.use_publisher_defaults,
  });
}

const priceRule = z.object({
  path: z.string().min(1).describe("Path glob, e.g. /premium/*"),
  price_usd: z.string().min(1).describe("Price in USD as a string, e.g. '0.05'."),
  billing_scope: z.enum(["page", "path"]).describe("Charge per page or per path."),
});

export const setSitePricingSchema = z.object({
  site_id: z.string().uuid().describe("The site id."),
  default_price_usd: z.string().min(1).describe("Default per-crawl price in USD, e.g. '0.01'."),
  default_billing_scope: z.enum(["page", "path"]).default("page"),
  rules: z
    .array(priceRule)
    .default([])
    .describe("Per-path price rules (whole-state replace)."),
  confirm: z.boolean().default(false).describe("Required true: changes what bots are charged."),
});
export type SetSitePricingInput = z.infer<typeof setSitePricingSchema>;
export async function setSitePricing(input: SetSitePricingInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "set_site_pricing",
      `This replaces site ${input.site_id}'s pricing: default $${input.default_price_usd}/${input.default_billing_scope} with ${input.rules.length} rule(s). Whole-state: existing rules are replaced.`,
    );
  }
  return putSitePricing(config.apiBase, token, input.site_id, {
    default_price_usd: input.default_price_usd,
    default_billing_scope: input.default_billing_scope,
    rules: input.rules,
  });
}

export const rotateSiteTokenSchema = z.object({
  site_id: z.string().uuid().describe("The site id."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: the old site token stops working immediately."),
});
export type RotateSiteTokenInput = z.infer<typeof rotateSiteTokenSchema>;
export async function rotateSiteTokenTool(input: RotateSiteTokenInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "rotate_site_token",
      `This rotates site ${input.site_id}'s token — the integration (plugin/worker/SDK) must be updated with the new token or gating stops.`,
    );
  }
  return rotateSiteToken(config.apiBase, token, input.site_id);
}

// --- site analytics ---------------------------------------------------------------

export const getSiteStatsSchema = z.object({
  site_id: z.string().uuid().describe("The site id."),
  wallet: z
    .string()
    .optional()
    .describe("Narrow revenue/paid to one payout wallet address."),
});
export type GetSiteStatsInput = z.infer<typeof getSiteStatsSchema>;
export async function getSiteStatsTool(input: GetSiteStatsInput, config: XenarchConfig) {
  const qs = new URLSearchParams();
  if (input.wallet) qs.set("wallet", input.wallet);
  return getSiteStats(config.apiBase, requireSession(config), input.site_id, qs.toString());
}

export const getSiteActivitySchema = z.object({
  site_id: z.string().uuid().describe("The site id."),
  period: z.enum(["24h", "7d", "30d", "all"]).optional().describe("Time window (default all)."),
  status: z
    .enum(["paid", "blocked", "withdraw", "all"])
    .optional()
    .describe("Filter by transaction status (default all)."),
  page: z.number().int().min(1).optional().describe("Page number (default 1)."),
  per_page: z.number().int().min(1).max(100).optional().describe("Rows per page (default 25)."),
});
export type GetSiteActivityInput = z.infer<typeof getSiteActivitySchema>;
export async function getSiteActivity(input: GetSiteActivityInput, config: XenarchConfig) {
  const qs = new URLSearchParams();
  if (input.period) qs.set("period", input.period);
  if (input.status) qs.set("status", input.status);
  if (input.page) qs.set("page", String(input.page));
  if (input.per_page) qs.set("per_page", String(input.per_page));
  return getSiteTransactions(config.apiBase, requireSession(config), input.site_id, qs.toString());
}

export const getSiteCategoriesSchema = z.object({
  site_id: z.string().uuid().describe("The site id."),
});
export type GetSiteCategoriesInput = z.infer<typeof getSiteCategoriesSchema>;
export async function getSiteCategories(input: GetSiteCategoriesInput, config: XenarchConfig) {
  return getSiteCategoryBreakdown(config.apiBase, requireSession(config), input.site_id);
}

// --- publisher-level gating ----------------------------------------------------------

export const getPublisherGatingSchema = z.object({});
export type GetPublisherGatingInput = z.infer<typeof getPublisherGatingSchema>;
export async function getPublisherGatingTool(
  _input: GetPublisherGatingInput,
  config: XenarchConfig,
) {
  return getPublisherGating(config.apiBase, requireSession(config));
}

export const setPublisherGatingSchema = z.object({
  gating_enabled: z.boolean().describe("Publisher-wide gating master switch."),
  gated_categories: z
    .record(z.boolean())
    .describe("Full category→gated map (whole-state replace)."),
  bot_overrides: z
    .record(z.string())
    .optional()
    .describe("Per-bot overrides (signature→policy). Omit to keep the current map."),
  confirm: z.boolean().default(false).describe("Required true: changes defaults for ALL sites."),
});
export type SetPublisherGatingInput = z.infer<typeof setPublisherGatingSchema>;
export async function setPublisherGatingTool(
  input: SetPublisherGatingInput,
  config: XenarchConfig,
) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "set_publisher_gating",
      `This replaces the publisher-level gating defaults (enabled: ${input.gating_enabled}) — every site set to "use publisher defaults" follows them.`,
    );
  }
  return putPublisherGating(config.apiBase, token, {
    gating_enabled: input.gating_enabled,
    gated_categories: input.gated_categories,
    ...(input.bot_overrides ? { bot_overrides: input.bot_overrides } : {}),
  });
}

export const createSiteClaimSchema = z.object({
  integration_type: z.enum(INTEGRATION_TYPES).describe("Integration doing the claim."),
  domain: z.string().min(1).describe("Domain the claim is for, e.g. example.com."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: mints a claim token that can bootstrap a site token."),
});
export type CreateSiteClaimInput = z.infer<typeof createSiteClaimSchema>;
export async function createSiteClaimTool(input: CreateSiteClaimInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "create_site_claim",
      `This mints a short-lived claim token for ${input.domain} (${input.integration_type}) — the integration holding it can bootstrap the site's token without dashboard copy-paste.`,
    );
  }
  return createSiteClaim(config.apiBase, token, {
    integration_type: input.integration_type,
    domain: input.domain,
  });
}

// --- bots ---------------------------------------------------------------------------

export const botCatalogSchema = z.object({});
export type BotCatalogInput = z.infer<typeof botCatalogSchema>;
export async function botCatalog(_input: BotCatalogInput, config: XenarchConfig) {
  return getBotCatalog(config.apiBase);
}

export const botActivitySchema = z.object({
  days: z.number().int().min(1).max(365).optional().describe("Look-back window (default 30)."),
  limit: z.number().int().min(1).max(500).optional().describe("Max signatures (default 100)."),
});
export type BotActivityInput = z.infer<typeof botActivitySchema>;
export async function botActivity(input: BotActivityInput, config: XenarchConfig) {
  const qs = new URLSearchParams();
  if (input.days) qs.set("days", String(input.days));
  if (input.limit) qs.set("limit", String(input.limit));
  return getBotActivity(config.apiBase, requireSession(config), qs.toString());
}
