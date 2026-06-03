// Browser device-login for the MCP (XEN-411) — sign in to the agent control
// plane without the CLI, gh-style.
//
// Stateful across two calls (pending request stashed in ~/.xenarch/.device-auth.json):
//   1st call (no pending): start a device flow → return the link to open.
//   2nd call (pending):    poll → on approval, save the session to config.json
//                          (so every xenarch_agent_* tool can use it).
//
// The human opens the link, signs in with their wallet on dash.xenarch.dev,
// and approves — the wallet signature stays in the browser; the MCP only ever
// receives the resulting session token.

import { readFile, writeFile, unlink, mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { deviceStart, devicePoll, saveSession } from "@xenarch/core";
import type { XenarchConfig } from "@xenarch/core";

const PENDING_FILE = join(homedir(), ".xenarch", ".device-auth.json");

interface Pending {
  device_code: string;
  verification_uri: string;
  started_at: number;
}

async function readPending(): Promise<Pending | null> {
  try {
    return JSON.parse(await readFile(PENDING_FILE, "utf-8")) as Pending;
  } catch {
    return null;
  }
}

async function writePending(p: Pending): Promise<void> {
  await mkdir(join(homedir(), ".xenarch"), { recursive: true, mode: 0o700 });
  await writeFile(PENDING_FILE, JSON.stringify(p), { mode: 0o600 });
  await chmod(PENDING_FILE, 0o600);
}

async function clearPending(): Promise<void> {
  try {
    await unlink(PENDING_FILE);
  } catch {
    // already gone
  }
}

export const agentLoginSchema = z.object({});
export type AgentLoginInput = z.infer<typeof agentLoginSchema>;

export async function agentLogin(_input: AgentLoginInput, config: XenarchConfig) {
  const pending = await readPending();
  const now = Date.now();

  // A request is in flight — poll it. Trust the server's status
  // (pending/approved/expired) rather than a local clock, so a slow human
  // approval is never abandoned prematurely. The server enforces the TTL and
  // returns "expired" when the code is dead, which we handle below.
  if (pending) {
    const r = await devicePoll(config.apiBase, pending.device_code);
    if (r.status === "approved" && r.session_token) {
      await saveSession(r.session_token, r.expires_at ?? "");
      await clearPending();
      return {
        status: "signed_in",
        expires_at: r.expires_at ?? null,
        message:
          "Signed in to the agent control plane. The xenarch_agent_* tools are ready.",
      };
    }
    if (r.status === "pending") {
      return {
        status: "waiting",
        verification_uri: pending.verification_uri,
        message:
          `Not approved yet. Open ${pending.verification_uri} , sign in with ` +
          `your wallet, approve, then call xenarch_agent_login again.`,
      };
    }
    // expired / unknown — start a fresh one below
    await clearPending();
  }

  // No live request — start one.
  const s = await deviceStart(config.apiBase);
  await writePending({
    device_code: s.device_code,
    verification_uri: s.verification_uri_complete,
    started_at: now,
  });
  return {
    status: "action_required",
    verification_uri: s.verification_uri_complete,
    user_code: s.user_code,
    message:
      `Open ${s.verification_uri_complete} in your browser, sign in with your ` +
      `wallet, and approve the request (code ${s.user_code}). Then call ` +
      `xenarch_agent_login again to finish — your session is saved for 7 days.`,
  };
}
