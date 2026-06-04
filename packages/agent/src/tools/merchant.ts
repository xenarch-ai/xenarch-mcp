// Merchant-ops MCP tools (XEN-414/415) — the "get paid" half of bilingual
// axis #2, mapped to tools. SIWE-owner-authed via the session the CLI's
// `xenarch agent login` writes to ~/.xenarch/config.json (config.sessionToken).
//
// create_link is validate-first: the agent calls with mode:"validate" to learn
// which fields are missing (prompt text included so it can ask the user), then
// re-calls mode:"create" with confirm:true to sign + persist. Signing uses the
// local agent key (config.privateKey); the platform verifies that signer equals
// the SIWE session wallet, so create only succeeds when the session belongs to
// the local wallet.

import { z } from "zod";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  getLinkSchema,
  validateLink,
  createLink,
  listLinks,
  getLinkDetail,
  revokeLink,
  listMerchantPayments,
  listSubscribers,
  getMerchantProfile,
  putMerchantProfile,
  verifyMerchantDomain,
  signPayLink,
  stringifyNumbers,
  type XenarchConfig,
  type PayLinkSchemaResponse,
  type LitValue,
  type PayLinkLit,
  type MerchantProfileBody,
  type MerchantProfileResponse,
} from "@xenarch/core";

// --- shared helpers --------------------------------------------------------

function requireSession(config: XenarchConfig): string {
  const token = config.sessionToken;
  if (!token) {
    throw new Error(
      "Not signed in. Run `xenarch agent login` in the Xenarch CLI (it writes " +
        "the SIWE session to ~/.xenarch/config.json), or set XENARCH_SESSION_TOKEN.",
    );
  }
  if (config.sessionExpiresAt && Date.parse(config.sessionExpiresAt) < Date.now()) {
    throw new Error("Session expired. Run `xenarch agent login` to refresh.");
  }
  return token;
}

function needsConfirmation(action: string, detail: string) {
  return {
    needs_confirmation: true,
    action,
    message: `${detail} Re-invoke this tool with confirm: true to proceed.`,
  };
}

const BUNDLED_SCHEMA: PayLinkSchemaResponse = {
  version: "bundled-fallback",
  currency: { default: "USDC", supported: ["USDC"] },
  network: { default: "base", supported: ["base"] },
  max_amount_usd: "1.00",
  fields: [
    { field: "to", group: "A", type: "address", required: true, state: "lit", prompt: "Recipient wallet", advanced: false, enum: null, default: null, auto_fill: "wallet", help: null },
    { field: "amount", group: "A", type: "amount", required: true, state: "lit", prompt: "Amount in USDC (max 1.00) or 'open'", advanced: false, enum: null, default: null, auto_fill: null, help: null },
    { field: "currency", group: "A", type: "enum", required: true, state: "lit", prompt: "Currency", advanced: false, enum: ["USDC"], default: "USDC", auto_fill: "USDC", help: null },
    { field: "network", group: "A", type: "enum", required: true, state: "lit", prompt: "Network", advanced: false, enum: ["base"], default: "base", auto_fill: "base", help: null },
    { field: "kind", group: "B", type: "enum", required: true, state: "lit", prompt: "Pay-link kind", advanced: false, enum: ["invoice", "subscription", "donation"], default: "invoice", auto_fill: null, help: null },
    { field: "product_name", group: "D", type: "string", required: false, state: "lit", prompt: "Product / line label", advanced: false, enum: null, default: null, auto_fill: null, help: null },
  ],
};

function buildParams(
  fields: Record<string, unknown>,
  schema: PayLinkSchemaResponse,
  walletAddress: string,
): Record<string, LitValue> {
  const params: Record<string, LitValue> = {};
  for (const f of schema.fields) {
    let v: unknown = fields[f.field];
    if ((v === undefined || v === "") && f.auto_fill) {
      v = f.auto_fill === "wallet" ? walletAddress : f.auto_fill;
    }
    if (v !== undefined && v !== "") {
      params[f.field] = {
        state: "lit",
        value: f.field === "to" ? getAddress(String(v)) : stringifyNumbers(v),
      };
    }
  }
  // Numbers coerced to strings so the templateHash matches the server's.
  for (const [k, v] of Object.entries(fields)) {
    if (!(k in params) && v !== undefined && v !== "") {
      params[k] = { state: "lit", value: stringifyNumbers(v) };
    }
  }
  return params;
}

function extractLit(params: Record<string, LitValue>): PayLinkLit {
  const get = (k: string): string => {
    const e = params[k];
    if (!e) throw new Error(`internal: missing lit field ${k} after validation`);
    return String(e.value);
  };
  return {
    to: get("to"),
    amount: get("amount"),
    currency: get("currency"),
    network: get("network"),
    kind: get("kind"),
  };
}

function summarize(lit: PayLinkLit): string {
  const amount = lit.amount === "open" ? "pay-what-you-want" : `$${lit.amount}`;
  return `${amount} ${lit.kind} to ${lit.to}`;
}

async function recordIdempotency(entry: Record<string, unknown>): Promise<void> {
  try {
    const dir = join(homedir(), ".xenarch");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    await appendFile(join(dir, "idempotency.jsonl"), line, { mode: 0o600 });
  } catch {
    // best-effort audit log; never fail a create over it
  }
}

// --- list / get ------------------------------------------------------------

export const xenarchListLinksSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25)"),
  starting_after: z.string().optional().describe("Cursor: last link_id of the previous page"),
});
export type XenarchListLinksInput = z.infer<typeof xenarchListLinksSchema>;

export async function xenarchListLinks(input: XenarchListLinksInput, config: XenarchConfig) {
  const token = requireSession(config);
  const qs = new URLSearchParams();
  if (input.limit) qs.set("limit", String(input.limit));
  if (input.starting_after) qs.set("starting_after", input.starting_after);
  return listLinks(config.apiBase, token, qs.toString());
}

export const xenarchGetLinkSchema = z.object({
  link_id: z.string().describe("The pay-link id"),
});
export type XenarchGetLinkInput = z.infer<typeof xenarchGetLinkSchema>;

export async function xenarchGetLink(input: XenarchGetLinkInput, config: XenarchConfig) {
  const token = requireSession(config);
  return getLinkDetail(config.apiBase, token, input.link_id);
}

// --- create (validate-first) ----------------------------------------------

export const xenarchCreateLinkSchema = z.object({
  amount: z.string().optional().describe("Amount in USDC, e.g. '0.99' (max 1.00), or 'open'"),
  kind: z.string().optional().describe("Pay-link kind: invoice, subscription, donation, ticket, bounty, paywall, api_metering, checkout, quick_charge"),
  product_name: z.string().optional().describe("Product / line label"),
  fields: z.record(z.any()).optional().describe("Any additional create-body fields by name (see xenarch_create_link validate output / GET /v1/links/schema)"),
  mode: z.enum(["validate", "create"]).optional().describe("validate (default) returns missing fields; create signs + creates"),
  confirm: z.boolean().optional().describe("Required to actually sign + create in create mode"),
});
export type XenarchCreateLinkInput = z.infer<typeof xenarchCreateLinkSchema>;

export async function xenarchCreateLink(input: XenarchCreateLinkInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!config.privateKey) {
    throw new Error("No signing key configured for this agent.");
  }
  const schema = await getLinkSchema(config.apiBase).catch(() => BUNDLED_SCHEMA);
  const walletAddress = getAddress(privateKeyToAccount(config.privateKey as `0x${string}`).address);

  const fields: Record<string, unknown> = { ...(input.fields ?? {}) };
  if (input.amount !== undefined) fields.amount = input.amount;
  if (input.kind !== undefined) fields.kind = input.kind;
  if (input.product_name !== undefined) fields.product_name = input.product_name;

  const params = buildParams(fields, schema, walletAddress);
  const validation = await validateLink(config.apiBase, token, params);

  const mode = input.mode ?? "validate";
  if (mode === "validate" || !validation.ok) {
    return { mode: "validate", ...validation, params };
  }

  const lit = extractLit(params);
  if (!input.confirm) {
    return needsConfirmation(
      "create_link",
      `This will sign and create a pay-link: ${summarize(lit)}. Signing authorizes the payment terms.`,
    );
  }

  const signed = await signPayLink(config.privateKey, params, lit);
  const idempotencyKey = randomUUID();
  let created;
  try {
    created = await createLink(
      config.apiBase,
      token,
      {
        params,
        nonce: signed.nonce,
        created_at: signed.created_at,
        signed_params: signed.signed_params,
      },
      idempotencyKey,
    );
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/signature does not match|expected signer|signed_params/i.test(msg)) {
      throw new Error(
        `Pay-link signature rejected: this agent's local signing key (${walletAddress}) ` +
          `is not the wallet your SIWE session belongs to. Sign in (xenarch agent login) ` +
          `with the wallet whose private key this agent holds, then retry. (server: ${msg})`,
      );
    }
    throw err;
  }
  await recordIdempotency({ key: idempotencyKey, link_id: created.link_id });
  return created;
}

// --- revoke ----------------------------------------------------------------

export const xenarchRevokeLinkSchema = z.object({
  link_id: z.string().describe("The pay-link id to revoke"),
  confirm: z.boolean().optional().describe("Required to revoke"),
});
export type XenarchRevokeLinkInput = z.infer<typeof xenarchRevokeLinkSchema>;

export async function xenarchRevokeLink(input: XenarchRevokeLinkInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "revoke_link",
      `This will revoke pay-link ${input.link_id} — anyone holding the URL can no longer pay it.`,
    );
  }
  return revokeLink(config.apiBase, token, input.link_id);
}

// --- payments / subscribers ------------------------------------------------

export const xenarchListPaymentsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("Page size (default 25)"),
  starting_after: z.string().optional().describe("Cursor: last payment id of the previous page"),
});
export type XenarchListPaymentsInput = z.infer<typeof xenarchListPaymentsSchema>;

export async function xenarchListPayments(input: XenarchListPaymentsInput, config: XenarchConfig) {
  const token = requireSession(config);
  const qs = new URLSearchParams();
  if (input.limit) qs.set("limit", String(input.limit));
  if (input.starting_after) qs.set("starting_after", input.starting_after);
  return listMerchantPayments(config.apiBase, token, qs.toString());
}

export const xenarchListSubscribersSchema = z.object({
  link_id: z.string().optional().describe("Filter by a subscription link"),
  status: z.string().optional().describe("active | cancelled | pending_email_verification | failed | exhausted"),
  mode: z.string().optional().describe("reminder | permit | stream"),
  limit: z.number().int().min(1).max(200).optional().describe("Page size (default 50)"),
  starting_after: z.string().optional().describe("Cursor: last subscription_id of the previous page"),
});
export type XenarchListSubscribersInput = z.infer<typeof xenarchListSubscribersSchema>;

export async function xenarchListSubscribers(input: XenarchListSubscribersInput, config: XenarchConfig) {
  const token = requireSession(config);
  const qs = new URLSearchParams();
  if (input.link_id) qs.set("link_id", input.link_id);
  if (input.status) qs.set("status", input.status);
  if (input.mode) qs.set("mode", input.mode);
  if (input.limit) qs.set("limit", String(input.limit));
  if (input.starting_after) qs.set("starting_after", input.starting_after);
  return listSubscribers(config.apiBase, token, qs.toString());
}

// --- merchant profile ------------------------------------------------------

export const xenarchGetMerchantProfileSchema = z.object({});
export type XenarchGetMerchantProfileInput = z.infer<typeof xenarchGetMerchantProfileSchema>;

export async function xenarchGetMerchantProfile(_input: XenarchGetMerchantProfileInput, config: XenarchConfig) {
  const token = requireSession(config);
  return getMerchantProfile(config.apiBase, token);
}

export const xenarchUpdateMerchantProfileSchema = z.object({
  issuer_name: z.string().optional(),
  merchant_site: z.string().optional().describe("Your domain, e.g. example.com"),
  issuer_email: z.string().optional(),
  issuer_address: z.string().optional(),
  issuer_tax_id: z.string().optional(),
  brand_color: z.string().optional().describe("Accent color, e.g. #5a9fd4"),
  issuer_logo_url: z.string().optional().describe("HTTPS logo URL (must match your domain)"),
  collection_rhythm: z.enum(["daily", "weekly", "monthly", "never"]).optional(),
});
export type XenarchUpdateMerchantProfileInput = z.infer<typeof xenarchUpdateMerchantProfileSchema>;

function writableFields(p: MerchantProfileResponse | null): MerchantProfileBody {
  if (!p) return {};
  return {
    issuer_name: p.issuer_name ?? null,
    issuer_logo_url: p.issuer_logo_url ?? null,
    issuer_address: p.issuer_address ?? null,
    issuer_tax_id: p.issuer_tax_id ?? null,
    issuer_email: p.issuer_email ?? null,
    merchant_site: p.merchant_site ?? null,
    brand_color: p.brand_color ?? null,
    collection_rhythm: p.collection_rhythm ?? null,
  };
}

export async function xenarchUpdateMerchantProfile(input: XenarchUpdateMerchantProfileInput, config: XenarchConfig) {
  const token = requireSession(config);
  // PUT is a whole-state upsert; merge provided fields over current.
  const current = await getMerchantProfile(config.apiBase, token);
  const body = writableFields(current);
  for (const k of Object.keys(input) as (keyof XenarchUpdateMerchantProfileInput)[]) {
    const v = input[k];
    if (v !== undefined) (body as Record<string, unknown>)[k] = v;
  }
  return putMerchantProfile(config.apiBase, token, body);
}

export const xenarchVerifyDomainSchema = z.object({});
export type XenarchVerifyDomainInput = z.infer<typeof xenarchVerifyDomainSchema>;

export async function xenarchVerifyDomain(_input: XenarchVerifyDomainInput, config: XenarchConfig) {
  const token = requireSession(config);
  return verifyMerchantDomain(config.apiBase, token);
}
