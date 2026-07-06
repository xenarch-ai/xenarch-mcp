// Account & identity MCP tools (XEN-517): linked wallets, merchant API keys,
// co-owner invites, account email, asset upload, earnings. SIWE-session-authed
// except invite preview/redeem (anonymous) and the key-held signing flows.
//
// Key-held SIWE flows (wallet link, invite redeem) sign an EIP-4361 message
// with the LOCAL key (config.privateKey) — they cannot use a WalletConnect
// wallet, whose key lives on the phone. Stdio transport only.

import { z } from "zod";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  listWallets,
  walletLinkNonce,
  walletLinkVerify,
  unlinkWallet,
  setWalletLabel,
  transferOwner,
  createMerchantKey,
  listMerchantKeys,
  rotateMerchantKey,
  revokeMerchantKey,
  createInvite,
  listInvites,
  revokeInvite,
  previewInvite,
  redeemInvite,
  setOnboardingEmail,
  verifyOnboardingEmail,
  uploadAsset,
  getEarningsSummary,
  buildSiweMessage,
  siweNonce,
} from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a full UUID or an unambiguous id prefix to a merchant key id. */
async function resolveMerchantKeyId(
  apiBase: string,
  token: string,
  idOrPrefix: string,
): Promise<string> {
  if (UUID_RE.test(idOrPrefix)) return idOrPrefix;
  const keys = await listMerchantKeys(apiBase, token);
  const matches = keys.filter((k) => k.id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`No merchant key matches id "${idOrPrefix}".`);
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous key id "${idOrPrefix}" (matches ${matches.length}); use the full UUID.`,
    );
  }
  return matches[0].id;
}

/** Sign an EIP-4361 message with the local key. Fails clearly without one. */
function localAccount(config: XenarchConfig) {
  if (!config.privateKey) {
    throw new Error(
      "This flow signs with a LOCAL wallet key and none is configured. A " +
        "WalletConnect wallet cannot sign here (its key lives on the phone) — " +
        "use the dashboard instead, or provide a local key via XENARCH_PRIVATE_KEY.",
    );
  }
  return privateKeyToAccount(config.privateKey as `0x${string}`);
}

// --- linked wallets ------------------------------------------------------------

export const listWalletsSchema = z.object({});
export type ListWalletsInput = z.infer<typeof listWalletsSchema>;
export async function listWalletsTool(_input: ListWalletsInput, config: XenarchConfig) {
  return listWallets(config.apiBase, requireSession(config));
}

export const linkWalletSchema = z.object({
  label: z.string().optional().describe("Optional nickname for the wallet being linked."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: attaches the LOCAL wallet to your account."),
});
export type LinkWalletInput = z.infer<typeof linkWalletSchema>;
export async function linkWalletTool(input: LinkWalletInput, config: XenarchConfig) {
  const token = requireSession(config);
  const account = localAccount(config);
  if (!input.confirm) {
    return needsConfirmation(
      "link_wallet",
      `This links the agent's LOCAL wallet ${account.address} to your Xenarch account as a co-wallet (it gains sign-in access to the identity).`,
    );
  }
  const nonce = await walletLinkNonce(config.apiBase, token);
  const message = buildSiweMessage({
    address: account.address,
    nonce: nonce.nonce,
    issuedAt: nonce.issued_at,
    expirationTime: nonce.expires_at,
    statement: "Link this wallet to your Xenarch account.",
  });
  const signature = await account.signMessage({ message });
  return walletLinkVerify(
    config.apiBase,
    token,
    message,
    signature,
    input.label ?? null,
  );
}

export const unlinkWalletSchema = z.object({
  address: z.string().min(1).describe("The linked wallet address to remove."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: the wallet loses access to the account."),
});
export type UnlinkWalletInput = z.infer<typeof unlinkWalletSchema>;
export async function unlinkWalletTool(input: UnlinkWalletInput, config: XenarchConfig) {
  const token = requireSession(config);
  const address = getAddress(input.address);
  if (!input.confirm) {
    return needsConfirmation(
      "unlink_wallet",
      `This unlinks wallet ${address} from the account — it can no longer sign in to this identity.`,
    );
  }
  await unlinkWallet(config.apiBase, token, address);
  return { unlinked: true, address };
}

export const setWalletLabelSchema = z.object({
  address: z.string().min(1).describe("The linked wallet address."),
  label: z.string().nullable().describe("New nickname; null clears it."),
  confirm: z.boolean().default(false).describe("Required true to change the label."),
});
export type SetWalletLabelInput = z.infer<typeof setWalletLabelSchema>;
export async function setWalletLabelTool(input: SetWalletLabelInput, config: XenarchConfig) {
  const token = requireSession(config);
  const address = getAddress(input.address);
  if (!input.confirm) {
    return needsConfirmation(
      "set_wallet_label",
      `This sets the label of wallet ${address} to ${input.label === null ? "(cleared)" : `"${input.label}"`}.`,
    );
  }
  await setWalletLabel(config.apiBase, token, address, input.label);
  return { address, label: input.label };
}

export const transferOwnerSchema = z.object({
  new_owner: z.string().min(1).describe("Linked wallet address to become the owner anchor."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: hands account ownership to another wallet."),
});
export type TransferOwnerInput = z.infer<typeof transferOwnerSchema>;
export async function transferOwnerTool(input: TransferOwnerInput, config: XenarchConfig) {
  const token = requireSession(config);
  const newOwner = getAddress(input.new_owner);
  if (!input.confirm) {
    return needsConfirmation(
      "transfer_owner",
      `This transfers OWNERSHIP of the account to ${newOwner}. The current owner wallet loses owner privileges. Hard to reverse — the new owner must transfer back.`,
    );
  }
  return transferOwner(config.apiBase, token, newOwner);
}

// --- merchant API keys ------------------------------------------------------------

export const listMerchantKeysSchema = z.object({});
export type ListMerchantKeysInput = z.infer<typeof listMerchantKeysSchema>;
export async function listMerchantKeysTool(_input: ListMerchantKeysInput, config: XenarchConfig) {
  return listMerchantKeys(config.apiBase, requireSession(config));
}

export const createMerchantKeySchema = z.object({
  label: z.string().optional().describe("Optional label for the new key."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: issues a live xm_live_ merchant credential."),
});
export type CreateMerchantKeyInput = z.infer<typeof createMerchantKeySchema>;
export async function createMerchantKeyTool(input: CreateMerchantKeyInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "create_merchant_key",
      "This issues a new xm_live_ API key that can read and manage the merchant account.",
    );
  }
  return createMerchantKey(config.apiBase, token, input.label ?? null);
}

export const rotateMerchantKeySchema = z.object({
  key_id: z.string().min(1).describe("Key id (full UUID or unambiguous prefix)."),
  confirm: z.boolean().default(false).describe("Required true: invalidates the current secret."),
});
export type RotateMerchantKeyInput = z.infer<typeof rotateMerchantKeySchema>;
export async function rotateMerchantKeyTool(input: RotateMerchantKeyInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "rotate_merchant_key",
      `Rotating merchant key ${input.key_id} invalidates its current secret.`,
    );
  }
  const id = await resolveMerchantKeyId(config.apiBase, token, input.key_id);
  return rotateMerchantKey(config.apiBase, token, id);
}

export const revokeMerchantKeySchema = z.object({
  key_id: z.string().min(1).describe("Key id (full UUID or unambiguous prefix)."),
  confirm: z.boolean().default(false).describe("Required true: permanently disables the key."),
});
export type RevokeMerchantKeyInput = z.infer<typeof revokeMerchantKeySchema>;
export async function revokeMerchantKeyTool(input: RevokeMerchantKeyInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "revoke_merchant_key",
      `Revoking merchant key ${input.key_id} permanently disables it.`,
    );
  }
  const id = await resolveMerchantKeyId(config.apiBase, token, input.key_id);
  await revokeMerchantKey(config.apiBase, token, id);
  return { revoked: true, id };
}

// --- co-owner invites ---------------------------------------------------------------

export const createInviteSchema = z.object({
  label: z.string().optional().describe("Nickname the joining wallet will get."),
  role: z
    .enum(["viewer", "operator", "full_co_owner"])
    .optional()
    .describe("Role granted on join (server default if omitted)."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: mints a live join link for your account."),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export async function createInviteTool(input: CreateInviteInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "create_invite",
      `This mints a join link — any wallet that redeems it joins your account${input.role ? ` as ${input.role}` : ""}.`,
    );
  }
  return createInvite(config.apiBase, token, {
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
  });
}

export const listInvitesSchema = z.object({});
export type ListInvitesInput = z.infer<typeof listInvitesSchema>;
export async function listInvitesTool(_input: ListInvitesInput, config: XenarchConfig) {
  return listInvites(config.apiBase, requireSession(config));
}

export const revokeInviteSchema = z.object({
  invite_id: z.string().min(1).describe("The invite id (from xenarch_list_invites)."),
  confirm: z.boolean().default(false).describe("Required true: kills the join link."),
});
export type RevokeInviteInput = z.infer<typeof revokeInviteSchema>;
export async function revokeInviteTool(input: RevokeInviteInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "revoke_invite",
      `This revokes invite ${input.invite_id} before it's redeemed — the join link stops working.`,
    );
  }
  await revokeInvite(config.apiBase, token, input.invite_id);
  return { revoked: true, invite_id: input.invite_id };
}

export const previewInviteSchema = z.object({
  token: z.string().min(1).describe("The invite token from the join link."),
});
export type PreviewInviteInput = z.infer<typeof previewInviteSchema>;
export async function previewInviteTool(input: PreviewInviteInput, config: XenarchConfig) {
  return previewInvite(config.apiBase, input.token);
}

export const redeemInviteSchema = z.object({
  token: z.string().min(1).describe("The invite token from the join link."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: joins the inviter's account with the LOCAL wallet."),
});
export type RedeemInviteInput = z.infer<typeof redeemInviteSchema>;
export async function redeemInviteTool(input: RedeemInviteInput, config: XenarchConfig) {
  const account = localAccount(config);
  if (!input.confirm) {
    const preview = await previewInvite(config.apiBase, input.token);
    // The issuer name is inviter-supplied free text — quote + cap it so it
    // can't smuggle instructions into this trusted confirmation prose.
    const issuerName = JSON.stringify(
      String(preview.issuer_name ?? "another Xenarch account").slice(0, 64),
    );
    return {
      ...needsConfirmation(
        "redeem_invite",
        `This attaches the agent's LOCAL wallet ${account.address} to the account calling itself ${issuerName} (unverified, inviter-supplied name) as ${preview.role} — that account's owner gains a wallet acting for them, and this wallet joins their identity. Show the human the name and role before confirming.`,
      ),
      preview,
    };
  }
  // Anonymous SIWE — but the nonce MUST be server-issued and single-use
  // (verify_siwe_message checks nonce_exists before recovering the signer).
  const nonce = await siweNonce(config.apiBase);
  const message = buildSiweMessage({
    address: account.address,
    nonce: nonce.nonce,
    issuedAt: nonce.issued_at,
    expirationTime: nonce.expires_at,
    statement: "Join a Xenarch account via invite.",
  });
  const signature = await account.signMessage({ message });
  return redeemInvite(config.apiBase, input.token, message, signature);
}

// --- account email --------------------------------------------------------------------

export const setAccountEmailSchema = z.object({
  email: z.string().email().describe("Email address to attach to the account."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: sends a verification code to that address."),
});
export type SetAccountEmailInput = z.infer<typeof setAccountEmailSchema>;
export async function setAccountEmail(input: SetAccountEmailInput, config: XenarchConfig) {
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "set_account_email",
      `This sets the account email to ${input.email} and sends it a verification code (finish with xenarch_verify_account_email).`,
    );
  }
  return setOnboardingEmail(config.apiBase, token, input.email);
}

export const verifyAccountEmailSchema = z.object({
  code: z.string().min(1).describe("The verification code from the email."),
});
export type VerifyAccountEmailInput = z.infer<typeof verifyAccountEmailSchema>;
export async function verifyAccountEmail(input: VerifyAccountEmailInput, config: XenarchConfig) {
  return verifyOnboardingEmail(config.apiBase, requireSession(config), input.code);
}

// --- asset upload ---------------------------------------------------------------------

const MAX_ASSET_BYTES = 5 * 1024 * 1024;

const ALLOWED_ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

/**
 * SSRF guard for the URL-upload path: HTTPS only, and refuse obviously
 * private/internal hosts. This is a local stdio tool in the user's own trust
 * domain, but the realistic caller is a prompt-injected agent — don't let it
 * exfiltrate loopback/intranet/cloud-metadata HTTP resources to a public CDN.
 * (Full DNS-rebinding defense is out of scope for a local tool.)
 */
function requireSafePublicHttpsUrl(raw: string): void {
  const u = new URL(raw);
  if (u.protocol !== "https:") {
    throw new Error(`Only https:// image URLs are allowed (got ${u.protocol}//).`);
  }
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "::1" ||
    host === "[::1]" ||
    /^\[?f[cd][0-9a-f]{2}:/.test(host) || // IPv6 ULA
    /^\[?fe80:/.test(host); // IPv6 link-local
  if (privateHost) {
    throw new Error(`Refusing to fetch from a private/internal host (${host}).`);
  }
}

export const uploadAssetSchema = z.object({
  url: z.string().url().optional().describe("HTTPS URL of the image to fetch and upload."),
  base64: z.string().optional().describe("Base64-encoded image bytes (no data: prefix needed)."),
  filename: z.string().default("upload.png").describe("Filename hint, e.g. 'logo.png'."),
  content_type: z
    .string()
    .default("image/png")
    .describe("MIME type, e.g. 'image/png' | 'image/jpeg' | 'image/svg+xml'."),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: stores the image publicly on cdn.xenarch.dev."),
});
export type UploadAssetInput = z.infer<typeof uploadAssetSchema>;
export async function uploadAssetTool(input: UploadAssetInput, config: XenarchConfig) {
  if (Boolean(input.url) === Boolean(input.base64)) {
    throw new Error("Pass exactly one of url or base64.");
  }
  const token = requireSession(config);
  if (!input.confirm) {
    return needsConfirmation(
      "upload_asset",
      `This uploads ${input.url ? `the image at ${input.url}` : "the provided image bytes"} to Xenarch's public CDN (used for logos/branding).`,
    );
  }
  let bytes: Uint8Array;
  let contentType = input.content_type;
  if (input.url) {
    requireSafePublicHttpsUrl(input.url);
    // redirect:"error" — a redirect could bounce the fetch to an internal
    // address after the URL itself passed the guard.
    const res = await fetch(input.url, { redirect: "error" });
    if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);
    contentType = res.headers.get("content-type") ?? contentType;
    bytes = new Uint8Array(await res.arrayBuffer());
  } else {
    const b64 = input.base64!.replace(/^data:[^;]+;base64,/, "");
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  }
  if (bytes.byteLength === 0) throw new Error("Image is empty.");
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(
      `Image is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — max 5 MB.`,
    );
  }
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_ASSET_TYPES.has(mime)) {
    throw new Error(
      `Content type "${mime}" is not an allowed image type (${[...ALLOWED_ASSET_TYPES].join(", ")}).`,
    );
  }
  return uploadAsset(config.apiBase, token, bytes, input.filename, mime);
}

// --- earnings -------------------------------------------------------------------------

export const getEarningsSummarySchema = z.object({});
export type GetEarningsSummaryInput = z.infer<typeof getEarningsSummarySchema>;
export async function getEarningsSummaryTool(
  _input: GetEarningsSummaryInput,
  config: XenarchConfig,
) {
  return getEarningsSummary(config.apiBase, requireSession(config));
}
