// EIP-4361 (SIWE) message construction for key-held signing flows (XEN-517):
// wallet-link (/v1/me/wallets/link/*) and invite-redeem (/v1/invites/redeem).
// Ported from the CLI's lib/siwe.ts — the platform verifier
// (app/services/siwe_auth.py) requires domain ∈ SIWE_ALLOWED_DOMAINS
// ("dash.xenarch.dev"), chain_id == 8453, a single-use unexpired nonce, and
// an issued_at inside the allowed window.

import { getAddress } from "viem";

export const SIWE_DOMAIN = "dash.xenarch.dev";
export const SIWE_URI = "https://dash.xenarch.dev";
export const SIWE_CHAIN_ID = 8453; // Base mainnet — must match SIWE_REQUIRED_CHAIN_ID.

/**
 * Build a canonical EIP-4361 message string.
 *
 * Follows the ABNF the `siwe` Python library parses: a domain preamble,
 * the checksummed address, a blank line, the statement, a blank line, then
 * the key/value field block. `address` is checksummed because siwe-py
 * rejects non-EIP-55 addresses in the message body.
 */
export function buildSiweMessage(opts: {
  address: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  statement: string;
  domain?: string;
  uri?: string;
  chainId?: number;
}): string {
  const address = getAddress(opts.address); // EIP-55 checksum
  return [
    `${opts.domain ?? SIWE_DOMAIN} wants you to sign in with your Ethereum account:`,
    address,
    "",
    opts.statement,
    "",
    `URI: ${opts.uri ?? SIWE_URI}`,
    `Version: 1`,
    `Chain ID: ${opts.chainId ?? SIWE_CHAIN_ID}`,
    `Nonce: ${opts.nonce}`,
    `Issued At: ${opts.issuedAt}`,
    `Expiration Time: ${opts.expirationTime}`,
  ].join("\n");
}
