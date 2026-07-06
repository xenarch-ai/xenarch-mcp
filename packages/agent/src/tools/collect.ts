// On-chain collection MCP tools (XEN-517) — the money-moving half of the
// subscribers surface. Ported from the CLI's proven collect.ts money-safety
// pattern (XEN-518, validated with a real on-chain transfer), then hardened
// for MCP after adversarial review.
//
// LOCAL-KEY ONLY (scoping decision, XEN-517): the merchant wallet broadcasts
// USDC.permit / USDC.transferFrom itself, signing with config.privateKey. That
// wallet must BE the permit spender and hold Base ETH for gas. A WalletConnect
// merchant has a session but no local signer — these tools error with a clear
// pointer to the dashboard. Stdio transport only (remote HTTP has no local key).
//
// Money-safety invariants (agents auto-retry — stricter than the CLI):
//  1. needs_confirmation returns BEFORE any signing/broadcast, and confirm:true
//     must pin the amount (expected_amount_usdc) — the bag is re-fetched
//     between the two calls, so an unpinned confirm could transfer a value the
//     human never saw (metered totals grow as charges accrue).
//  2. Preflight before broadcast: allowance, balance, exact-call simulation —
//     never broadcast a doomed tx.
//  3. Sign locally FIRST, so the tx hash is known before any bytes hit the
//     wire, then send the raw tx on a NO-RETRY transport. viem's default http
//     transport retries eth_sendRawTransaction; a lost response would make the
//     retry throw "already known" AFTER the tx is in the mempool — an error the
//     agent would re-run, double-charging. With sign-then-send, every
//     send-phase failure returns the tx hash + recovery instead of throwing.
//  4. A per-subscription pending-tx ledger (~/.xenarch/pending-collects.json)
//     is written BEFORE send and cleared only on a terminal outcome (booked or
//     confirmed revert). A re-run while an un-booked tx is outstanding returns
//     that tx hash instead of broadcasting again — this closes the window
//     where the row is still in the collectable bag because the backend books
//     only at confirmation depth.
//  5. In-call time is bounded (receipt wait 25s + record poll ≤3×4s) to stay
//     under the MCP client's 60s default request timeout — a client-side
//     timeout would swallow the tx hash and invite a re-run.
//  6. Once the raw tx is signed, NEVER throw a re-runnable error: every
//     post-sign failure returns { booked: false, tx_hash, … } with the
//     idempotent xenarch_record_collect recovery (backend dedups on tx_hash
//     and verifies the transfer log on-chain before booking).
//  7. HTTP 202 = mined but not deep enough = NOT success: re-POST the SAME
//     tx_hash, never treat as booked, never re-broadcast.
//  8. A mined-but-REVERTED transferFrom moved NO money: report it as
//     transferred:false + safe-to-retry, not as an unbooked transfer.

import { z } from "zod";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  formatUnits,
  parseUnits,
  parseSignature,
  keccak256,
  encodeFunctionData,
  erc20Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import {
  listPermitCollectable,
  listMeteredCollectable,
  collectPermit,
  collectMetered,
  submitPermit,
  ClaimAwaitingConfirmationsError,
} from "@xenarch/core";
import type {
  XenarchConfig,
  CollectableRow,
  CollectRecordResult,
} from "@xenarch/core";
import { requireSession, needsConfirmation } from "./util.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const microUsd = (micro: number | bigint): string =>
  `$${formatUnits(BigInt(micro), 6)}`;

// Bounded in-call timing (invariant 5). Base blocks land in ~2s; 25s of
// receipt wait + 3×4s of booking polls keeps the worst case well under the
// MCP client's 60s default request timeout.
const RECEIPT_TIMEOUT_MS = 25_000;
const RECORD_ATTEMPTS = 3;
const RECORD_POLL_MS = 4_000;

// EIP-2612 permit + nonces — not part of viem's bundled erc20Abi.
const permitAbi = [
  {
    type: "function",
    name: "permit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "nonces",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** The LOCAL signing account, or a clear error for WC-only merchants. */
function localAccount(config: XenarchConfig) {
  if (!config.privateKey) {
    throw new Error(
      "On-chain collection signs with a LOCAL wallet key and none is " +
        "configured. A WalletConnect wallet cannot sign here (its key lives " +
        "on the phone) — collect via the dashboard, or provide the seller " +
        "wallet's key locally (CLI `xenarch wallet import` / XENARCH_PRIVATE_KEY).",
    );
  }
  return privateKeyToAccount(config.privateKey as `0x${string}`);
}

function requireSafeMicro(value: unknown, label: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Backend sent a non-integer ${label} (${String(value)}) — refusing to compute an on-chain amount from it.`,
    );
  }
  return BigInt(value);
}

/** Minimal structural view of the public client — dodges viem's generics. */
interface ChainReader {
  getChainId(): Promise<number>;
  getTransaction(args: { hash: Hex }): Promise<unknown>;
}

/** Collect is Base-mainnet only; a mismatched RPC must fail loudly, not weirdly. */
async function requireBaseMainnet(
  publicClient: ChainReader,
  rpcUrl: string,
): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (chainId !== base.id) {
    throw new Error(
      `Configured RPC (${rpcUrl}) is chain ${chainId}, but collection settles USDC on Base mainnet (${base.id}). Fix XENARCH_RPC_URL / config.rpcUrl.`,
    );
  }
}

function rowToken(row: CollectableRow): Hex {
  if (typeof row.token !== "string" || !row.token) {
    throw new Error(
      "Collectable row is missing its token contract address — refusing to fall back to a default. Re-fetch the collectable bag or report this upstream.",
    );
  }
  return getAddress(row.token) as Hex;
}

async function findCollectableRow(
  kind: "permit" | "metered",
  subscriptionId: string,
  config: XenarchConfig,
  token: string,
): Promise<CollectableRow> {
  const bag =
    kind === "permit"
      ? await listPermitCollectable(config.apiBase, token)
      : await listMeteredCollectable(config.apiBase, token);
  const row = bag.collectable.find((r) => r.subscription_id === subscriptionId);
  if (!row) {
    throw new Error(
      `Subscription ${subscriptionId} is not in the ${kind} collectable bag right now ` +
        `(nothing due, or the sweep hasn't confirmed it collectable). ` +
        `Check xenarch_list_${kind}_collectable.`,
    );
  }
  return row;
}

// --- pending-tx ledger (invariant 4) -----------------------------------------

const PENDING_FILE = join(homedir(), ".xenarch", "pending-collects.json");

interface PendingEntry {
  tx_hash: string;
  ts: number;
}

async function readPendingLedger(): Promise<Record<string, PendingEntry>> {
  try {
    return JSON.parse(await readFile(PENDING_FILE, "utf-8")) as Record<
      string,
      PendingEntry
    >;
  } catch {
    return {};
  }
}

async function writePendingLedger(map: Record<string, PendingEntry>): Promise<void> {
  await mkdir(join(homedir(), ".xenarch"), { recursive: true, mode: 0o700 });
  await writeFile(PENDING_FILE, JSON.stringify(map, null, 2), { mode: 0o600 });
  await chmod(PENDING_FILE, 0o600);
}

async function setPending(key: string, txHash: string): Promise<void> {
  const map = await readPendingLedger();
  map[key] = { tx_hash: txHash, ts: Date.now() };
  await writePendingLedger(map);
}

async function clearPending(key: string): Promise<void> {
  const map = await readPendingLedger();
  if (key in map) {
    delete map[key];
    await writePendingLedger(map);
  }
}

/**
 * If an earlier collect signed/broadcast a tx for this subscription that never
 * reached a terminal state, refuse to broadcast again — surface the old hash.
 * After 15 minutes, allow a retry ONLY if the chain has never seen the old tx
 * (getTransaction returns null: dropped before entering any node we can see).
 */
async function checkPendingGuard(
  key: string,
  publicClient: ChainReader,
): Promise<PendingEntry | null> {
  const map = await readPendingLedger();
  const entry = map[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > 15 * 60 * 1000) {
    const tx = await publicClient
      .getTransaction({ hash: entry.tx_hash as Hex })
      .catch(() => null);
    if (tx === null) {
      // Never made it on-chain and long dead — safe to let a new attempt run.
      await clearPending(key);
      return null;
    }
  }
  return entry;
}

/**
 * Record a broadcast tx, retrying only on HTTP 202 ("mined but not deep enough
 * yet"). NEVER re-broadcasts — it re-POSTs the SAME tx_hash, which the backend
 * dedups. Returns null if still awaiting after the retry budget; non-202
 * errors propagate.
 */
async function recordWithPoll(
  recordFn: (
    apiBase: string,
    token: string,
    id: string,
    txHash: string,
  ) => Promise<CollectRecordResult>,
  config: XenarchConfig,
  token: string,
  id: string,
  txHash: string,
): Promise<CollectRecordResult | null> {
  for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt++) {
    try {
      return await recordFn(config.apiBase, token, id, txHash);
    } catch (err) {
      if (err instanceof ClaimAwaitingConfirmationsError) {
        await sleep(RECORD_POLL_MS);
        continue;
      }
      throw err;
    }
  }
  return null;
}

/**
 * The ONLY safe shape once a tx may be on-chain but isn't booked: a NORMAL
 * result (never isError — an erroring MCP tool invites the agent to re-run it,
 * and re-running collect would transfer a second time).
 */
function unbookedResult(
  subscriptionId: string,
  mode: "permit" | "metered",
  txHash: string,
  reason: string,
) {
  return {
    transferred: true,
    booked: false,
    tx_hash: txHash,
    reason,
    recovery:
      `The transfer tx is (or may be) on-chain. Do NOT re-run the collect tool — ` +
      `that could transfer a second time. Book it with xenarch_record_collect ` +
      `{ subscription_id: "${subscriptionId}", tx_hash: "${txHash}", mode: "${mode}" } ` +
      `(idempotent, does NOT transfer).`,
  };
}

// --- collect (permit + metered) -----------------------------------------------

async function runCollect(
  kind: "permit" | "metered",
  input: { subscription_id: string; confirm: boolean; expected_amount_usdc?: string },
  config: XenarchConfig,
) {
  const token = requireSession(config);

  // 1. Find the collectable row.
  const row = await findCollectableRow(kind, input.subscription_id, config, token);
  const tf = row.transfer_from;
  if (!tf?.owner || !tf?.spender || !tf.value) {
    throw new Error("Collectable row is missing transfer_from(owner, spender, value).");
  }
  const owner = getAddress(tf.owner);
  const spender = getAddress(tf.spender);
  const amount = requireSafeMicro(tf.value, "transfer_from.value"); // micro-USDC == USDC base units
  const amountUsdc = formatUnits(amount, 6);
  const usdcAddress = rowToken(row);

  // 2. Tier-2 confirm FIRST — before any wallet/key/RPC interaction. The
  //    confirm call MUST pin the amount it is confirming (invariant 1): the
  //    bag is re-fetched per call, so metered totals can grow in between.
  const pinnedOk =
    input.expected_amount_usdc !== undefined &&
    (() => {
      try {
        return parseUnits(input.expected_amount_usdc, 6) === amount;
      } catch {
        return false;
      }
    })();
  if (!input.confirm || !pinnedOk) {
    return {
      ...needsConfirmation(
        `collect_${kind}`,
        `This broadcasts an on-chain USDC.transferFrom moving ${microUsd(amount)} USDC ` +
          `from the buyer ${owner} to your wallet ${spender}. Real money; gas is paid ` +
          `by your wallet in Base ETH.`,
      ),
      message_extra:
        input.confirm && !pinnedOk && input.expected_amount_usdc !== undefined
          ? `Amount changed since you last looked: it is now ${amountUsdc} USDC (you pinned ${input.expected_amount_usdc}). Review and re-confirm with the new amount.`
          : `Re-invoke with confirm: true AND expected_amount_usdc: "${amountUsdc}" — the transfer aborts if the due amount changes in between.`,
      amount_usdc: amountUsdc,
      owner,
      spender,
      payer_email: row.payer_email,
    };
  }

  // 3. The broadcasting signer must BE the spender.
  const account = localAccount(config);
  if (account.address.toLowerCase() !== spender.toLowerCase()) {
    throw new Error(
      `Local wallet ${account.address} is not the allowance spender ${spender}. ` +
        `transferFrom would revert — this tool needs the seller wallet's local key.`,
    );
  }

  const publicClient = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
  await requireBaseMainnet(publicClient, config.rpcUrl);

  // 4. Pending-tx guard (invariant 4): if an earlier attempt's tx is still
  //    un-booked, hand back ITS hash instead of broadcasting again.
  const pendingKey = `${kind}:${input.subscription_id}`;
  const pending = await checkPendingGuard(pendingKey, publicClient);
  if (pending) {
    return unbookedResult(
      input.subscription_id,
      kind,
      pending.tx_hash,
      "a previous collect attempt already signed/broadcast this transfer and it has not been booked yet",
    );
  }

  // 5. Preflight against chain state (read-only, no gas).
  const [allowance, balance] = await Promise.all([
    publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }) as Promise<bigint>,
  ]);
  if (allowance < amount) {
    throw new Error(
      `On-chain allowance ${microUsd(allowance)} < ${microUsd(amount)} — the buyer's ` +
        `permit hasn't been submitted on-chain yet (see xenarch_permit_submit).`,
    );
  }
  if (balance < amount) {
    throw new Error(
      `Buyer USDC balance ${microUsd(balance)} < ${microUsd(amount)} — insufficient funds to collect.`,
    );
  }
  // Simulate the exact call — throws on any revert we didn't anticipate.
  await publicClient.simulateContract({
    account,
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "transferFrom",
    args: [owner, spender, amount],
  });

  // 6. Sign locally FIRST (invariant 3) so the tx hash exists before any bytes
  //    hit the wire, persist it to the pending ledger, then send the raw tx on
  //    a NO-RETRY transport. From the moment the ledger is written, every
  //    failure path returns the hash — never a re-runnable error.
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl),
  });
  const prepared = await walletClient.prepareTransactionRequest({
    to: usdcAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transferFrom",
      args: [owner, spender, amount],
    }),
  });
  const serialized = await walletClient.signTransaction(prepared);
  const txHash = keccak256(serialized);
  await setPending(pendingKey, txHash);

  const sendClient = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl, { retryCount: 0 }),
  });
  try {
    await sendClient.sendRawTransaction({ serializedTransaction: serialized });
  } catch (err) {
    // The node's response was lost or it rejected the tx — but the tx MAY
    // already be in the mempool. Never throw (invariant 6).
    return unbookedResult(
      input.subscription_id,
      kind,
      txHash,
      `send error (tx may still be on-chain): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 7. Bounded wait + record — both post-broadcast, both guarded.
  const record = kind === "permit" ? collectPermit : collectMetered;
  let result: CollectRecordResult | null;
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    if (receipt.status === "reverted") {
      // Mined but reverted: NO money moved (invariant 8). Clear the pending
      // entry — a fresh collect (after diagnosing) is the correct next step.
      await clearPending(pendingKey);
      return {
        transferred: false,
        reverted: true,
        tx_hash: txHash,
        message:
          "The transferFrom was mined but REVERTED — no money moved. Check the buyer's allowance/balance (they may have changed after preflight), then re-run the collect tool.",
      };
    }
    result = await recordWithPoll(record, config, token, input.subscription_id, txHash);
  } catch (err) {
    return unbookedResult(
      input.subscription_id,
      kind,
      txHash,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (!result) {
    return unbookedResult(
      input.subscription_id,
      kind,
      txHash,
      "awaiting confirmations after retries",
    );
  }
  await clearPending(pendingKey);
  return { ...result, transferred: true, booked: true, tx_hash: txHash };
}

const collectInputSchema = {
  subscription_id: z.string().min(1).describe("Subscription id from the collectable bag."),
  expected_amount_usdc: z
    .string()
    .optional()
    .describe(
      "The exact amount (USDC, e.g. '0.10') from the needs_confirmation payload. REQUIRED with confirm:true — the transfer aborts if the due amount changed.",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true: broadcasts an on-chain transferFrom (moves real money)."),
};

export const permitCollectSchema = z.object(collectInputSchema);
export type PermitCollectInput = z.infer<typeof permitCollectSchema>;
export async function permitCollect(input: PermitCollectInput, config: XenarchConfig) {
  return runCollect("permit", input, config);
}

export const meteredCollectSchema = z.object(collectInputSchema);
export type MeteredCollectInput = z.infer<typeof meteredCollectSchema>;
export async function meteredCollect(input: MeteredCollectInput, config: XenarchConfig) {
  return runCollect("metered", input, config);
}

// --- record (recovery) -----------------------------------------------------------

export const recordCollectSchema = z.object({
  subscription_id: z.string().min(1).describe("The subscription id."),
  tx_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .describe("The already-broadcast transferFrom tx hash."),
  mode: z.enum(["permit", "metered"]).describe("Which collect flow the tx belongs to."),
});
export type RecordCollectInput = z.infer<typeof recordCollectSchema>;
export async function recordCollect(input: RecordCollectInput, config: XenarchConfig) {
  const token = requireSession(config);
  const record = input.mode === "permit" ? collectPermit : collectMetered;
  const result = await recordWithPoll(
    record,
    config,
    token,
    input.subscription_id,
    input.tx_hash,
  );
  if (!result) {
    return {
      booked: false,
      tx_hash: input.tx_hash,
      reason: "awaiting confirmations",
      note: "Safe to re-run xenarch_record_collect in a bit — it never transfers.",
    };
  }
  // Terminal booking: release the pending-tx guard for this subscription.
  await clearPending(`${input.mode}:${input.subscription_id}`);
  return { ...result, booked: true, tx_hash: input.tx_hash };
}

// --- permit submit ------------------------------------------------------------------

export const permitSubmitSchema = z.object({
  subscription_id: z.string().min(1).describe("Subscription id from the permit collectable bag."),
  tx_hash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional()
    .describe(
      "Recovery only: an ALREADY-broadcast permit tx hash to record — skips any broadcast (and needs no confirm; the record is idempotent).",
    ),
  confirm: z
    .boolean()
    .default(false)
    .describe("Required true to BROADCAST the buyer's signed USDC.permit on-chain (gas only, moves no funds)."),
});
export type PermitSubmitInput = z.infer<typeof permitSubmitSchema>;
export async function permitSubmitTool(input: PermitSubmitInput, config: XenarchConfig) {
  const token = requireSession(config);

  // Recovery path: record a permit tx that is already on-chain. Idempotent on
  // (subscription_id, tx_hash); never signs or broadcasts, so no confirm gate.
  if (input.tx_hash) {
    const recorded = await submitPermit(
      config.apiBase,
      token,
      input.subscription_id,
      input.tx_hash,
    );
    return { ...recorded, submitted: true, recorded: true, tx_hash: input.tx_hash };
  }

  const row = await findCollectableRow("permit", input.subscription_id, config, token);
  const permit = row.permit;
  if (!permit?.signature || permit.value == null || permit.deadline == null || permit.nonce == null) {
    throw new Error(
      "Collectable row is missing the buyer's permit(signature, value, nonce, deadline).",
    );
  }
  const tf = row.transfer_from;
  if (!tf?.owner || !tf?.spender) {
    throw new Error("Collectable row is missing transfer_from(owner, spender).");
  }
  const owner = getAddress(tf.owner);
  const spender = getAddress(tf.spender);
  const value = requireSafeMicro(permit.value, "permit.value");
  const deadline = BigInt(permit.deadline);
  const usdcAddress = rowToken(row);

  if (permit.submitted) {
    return {
      already_submitted: true,
      message:
        "This subscription's permit is already recorded as submitted on-chain — " +
        "the allowance should be live. Check with xenarch_permit_collect.",
    };
  }

  if (!input.confirm) {
    return {
      ...needsConfirmation(
        "permit_submit",
        `This broadcasts the buyer's signed USDC.permit on-chain, setting ` +
          `allowance[${owner}][${spender}] = ${microUsd(value)} USDC so future cycles ` +
          `can be collected. Moves NO funds; your wallet pays gas in Base ETH.`,
      ),
      owner,
      spender,
      allowance_usdc: formatUnits(value, 6),
    };
  }

  // Anyone may broadcast a signed permit, but per the local-key scoping the
  // configured wallet does it (it pays gas).
  const account = localAccount(config);
  const publicClient = createPublicClient({ chain: base, transport: http(config.rpcUrl) });
  await requireBaseMainnet(publicClient, config.rpcUrl);

  // EIP-2612: the permit only succeeds while nonces(owner) equals the nonce it
  // was signed with. A mismatch means it was consumed (submitted earlier) or
  // superseded — broadcasting would revert forever, so diagnose instead.
  const [allowance, currentNonce] = await Promise.all([
    publicClient.readContract({
      address: usdcAddress,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner, spender],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: usdcAddress,
      abi: permitAbi,
      functionName: "nonces",
      args: [owner],
    }) as Promise<bigint>,
  ]);
  if (currentNonce !== BigInt(permit.nonce)) {
    if (allowance >= value) {
      return {
        already_live: true,
        allowance_usdc: formatUnits(allowance, 6),
        message:
          "The permit was already submitted on-chain (nonce consumed) and the allowance is live. " +
          "If you have the original submission tx hash, record it via the tx_hash parameter " +
          "so the dashboard shows it; otherwise just collect with xenarch_permit_collect.",
      };
    }
    return {
      permit_unusable: true,
      signed_nonce: permit.nonce,
      current_nonce: currentNonce.toString(),
      allowance_usdc: formatUnits(allowance, 6),
      message:
        "This stored permit can never succeed: its signed nonce no longer matches the " +
        "buyer's on-chain permit nonce (consumed or superseded) and the allowance is below " +
        "the permit value. The buyer must re-sign (re-up) the permit. If it WAS submitted " +
        "earlier, record that tx via the tx_hash parameter.",
    };
  }
  if (allowance >= value) {
    return {
      already_live: true,
      allowance_usdc: formatUnits(allowance, 6),
      message:
        "The on-chain allowance is already at or above the permit value — " +
        "nothing to submit. Collect with xenarch_permit_collect.",
    };
  }

  const { r, s, v, yParity } = parseSignature(permit.signature as Hex);
  const vNum = v ?? BigInt(27 + (yParity ?? 0));

  // Simulate the exact permit() call — reverts (expired deadline, bad
  // signature) surface here, pre-broadcast.
  const { request } = await publicClient.simulateContract({
    account,
    address: usdcAddress,
    abi: permitAbi,
    functionName: "permit",
    args: [owner, spender, value, deadline, Number(vNum), r, s],
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(config.rpcUrl),
  });
  const txHash = await walletClient.writeContract(request);

  // Post-broadcast: the permit IS on-chain (or will be); recording is a light,
  // idempotent audit write — a failure here must not read as "retry the
  // broadcast" (a second permit() would revert on the consumed nonce anyway,
  // costing only gas).
  try {
    await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    const recorded = await submitPermit(
      config.apiBase,
      token,
      input.subscription_id,
      txHash,
    );
    return { ...recorded, submitted: true, tx_hash: txHash };
  } catch (err) {
    return {
      submitted: true,
      recorded: false,
      tx_hash: txHash,
      reason: err instanceof Error ? err.message : String(err),
      recovery:
        `The permit tx IS broadcast — do not broadcast again. Once it has ` +
        `mined, record it with xenarch_permit_submit ` +
        `{ subscription_id: "${input.subscription_id}", tx_hash: "${txHash}" } ` +
        `(record-only, idempotent).`,
    };
  }
}
