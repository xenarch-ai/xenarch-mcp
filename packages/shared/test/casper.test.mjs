// Tests for the Casper x402 settlement seam (XEN-500).
//
// Plain node:test + node:assert against the built ESM output — no test-runner
// dependency, matching the repo's zero-devDependency posture. Run with
// `npm test` from the repo root (builds first, then executes).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CASPER_MAINNET,
  CASPER_TESTNET,
  CASPER_NETWORKS,
  CSPR_DECIMALS,
  DEFAULT_CASPER_FACILITATOR_URL,
  isCasperNetwork,
  casperFacilitatorUrl,
  csprToMotes,
  motesToCspr,
  parseMoteAmount,
  casperNonce,
  buildCasperPaymentPayload,
  selectCasperAccept,
  gateSupportsCasper,
  CasperFacilitatorClient,
  CasperAmountPrecisionError,
  CasperConfigurationError,
  CasperFacilitatorError,
  CasperError,
} from "../dist/index.js";

import { gateNeedsCasperSettlement, settleX402 } from "../dist/payment.js";

const WCSPR = "hash-0000000000000000000000000000000000000000000000000000000000000001";
const PAY_TO = "account-hash-1111111111111111111111111111111111111111111111111111111111111111";
const FROM = "0202a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f901";
const SIG = "01deadbeef";

function casperAccept(overrides = {}) {
  return {
    scheme: "exact",
    network: CASPER_TESTNET,
    maxAmountRequired: "1000000000",
    resource: "https://example.com/article",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    asset: WCSPR,
    ...overrides,
  };
}

function baseAccept(overrides = {}) {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "3000",
    resource: "https://example.com/article",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ...overrides,
  };
}

// --- Network identification ----------------------------------------------

test("network ids match the Casper x402 spec", () => {
  assert.equal(CASPER_MAINNET, "casper:casper");
  assert.equal(CASPER_TESTNET, "casper:casper-test");
  assert.deepEqual([...CASPER_NETWORKS], [CASPER_MAINNET, CASPER_TESTNET]);
  assert.equal(CSPR_DECIMALS, 9);
});

test("isCasperNetwork accepts only the two Casper network ids", () => {
  assert.equal(isCasperNetwork("casper:casper"), true);
  assert.equal(isCasperNetwork("casper:casper-test"), true);
});

test("isCasperNetwork rejects Base, junk and nullish values", () => {
  for (const v of [
    "base",
    "base-sepolia",
    "casper",
    "Casper:Casper",
    "casper:casper-testnet",
    "",
    " casper:casper",
    undefined,
    null,
    42,
    {},
  ]) {
    assert.equal(isCasperNetwork(v), false, `expected false for ${String(v)}`);
  }
});

// --- Facilitator URL resolution ------------------------------------------

test("facilitator URL defaults to the public Casper facilitator", () => {
  assert.equal(casperFacilitatorUrl({}), DEFAULT_CASPER_FACILITATOR_URL);
  assert.equal(
    DEFAULT_CASPER_FACILITATOR_URL,
    "https://x402-facilitator.cspr.cloud",
  );
});

test("XENARCH_CASPER_FACILITATOR_URL overrides the default", () => {
  assert.equal(
    casperFacilitatorUrl({
      XENARCH_CASPER_FACILITATOR_URL: "https://facilitator.internal/",
    }),
    "https://facilitator.internal",
  );
});

test("blank or whitespace-only override falls back to the default", () => {
  assert.equal(
    casperFacilitatorUrl({ XENARCH_CASPER_FACILITATOR_URL: "   " }),
    DEFAULT_CASPER_FACILITATOR_URL,
  );
});

// --- Exact mote math -----------------------------------------------------

test("csprToMotes converts whole and fractional CSPR exactly", () => {
  assert.equal(csprToMotes("0"), 0n);
  assert.equal(csprToMotes("1"), 1_000_000_000n);
  assert.equal(csprToMotes("2.5"), 2_500_000_000n);
  assert.equal(csprToMotes("0.000000001"), 1n);
  assert.equal(csprToMotes("0.123456789"), 123_456_789n);
  assert.equal(csprToMotes(".5"), 500_000_000n);
  assert.equal(csprToMotes("1."), 1_000_000_000n);
});

test("csprToMotes stays exact far beyond Number.MAX_SAFE_INTEGER", () => {
  // 12_345_678_901 CSPR ≈ 1.23e19 motes — well past 2^53.
  assert.equal(
    csprToMotes("12345678901.987654321"),
    12_345_678_901_987_654_321n,
  );
});

test("csprToMotes tolerates redundant trailing zeros past 9 decimals", () => {
  assert.equal(csprToMotes("1.0000000000"), 1_000_000_000n);
  assert.equal(csprToMotes("0.1230000000000"), 123_000_000n);
});

test("csprToMotes THROWS on sub-mote precision rather than truncating", () => {
  assert.throws(
    () => csprToMotes("0.0000000001"),
    (err) => {
      assert.ok(err instanceof CasperAmountPrecisionError);
      assert.ok(err instanceof CasperError);
      assert.equal(err.name, "CasperAmountPrecisionError");
      assert.match(err.message, /sub-mote precision/);
      return true;
    },
  );
  assert.throws(
    () => csprToMotes("1.1234567891"),
    CasperAmountPrecisionError,
  );
});

test("csprToMotes rejects numbers, negatives and non-decimal strings", () => {
  for (const bad of [1.5, "-1", "-0.5", "abc", "1e9", "1,5", "", "  ", "0x10"]) {
    assert.throws(
      () => csprToMotes(bad),
      CasperAmountPrecisionError,
      `expected throw for ${String(bad)}`,
    );
  }
});

test("motesToCspr is the exact inverse of csprToMotes", () => {
  for (const v of ["0", "1", "2.5", "0.000000001", "0.123456789", "999999.5"]) {
    assert.equal(motesToCspr(csprToMotes(v)), motesToCspr(csprToMotes(v)));
    assert.equal(csprToMotes(motesToCspr(csprToMotes(v))), csprToMotes(v));
  }
  assert.equal(motesToCspr(0n), "0");
  assert.equal(motesToCspr(1n), "0.000000001");
  assert.equal(motesToCspr(1_000_000_000n), "1");
  assert.equal(motesToCspr(2_500_000_000n), "2.5");
});

test("motesToCspr rejects negative amounts", () => {
  assert.throws(() => motesToCspr(-1n), CasperAmountPrecisionError);
});

test("parseMoteAmount accepts integer base-unit strings only", () => {
  assert.equal(parseMoteAmount("0"), 0n);
  assert.equal(parseMoteAmount("1000000000"), 1_000_000_000n);
  assert.equal(parseMoteAmount(" 42 "), 42n);
  for (const bad of ["1.5", "-1", "1e3", "", "abc", null, 5]) {
    assert.throws(
      () => parseMoteAmount(bad),
      CasperAmountPrecisionError,
      `expected throw for ${String(bad)}`,
    );
  }
});

// --- accepts[] selection -------------------------------------------------

test("selectCasperAccept returns null when no Casper entry is advertised", () => {
  assert.equal(selectCasperAccept([baseAccept()]), null);
  assert.equal(selectCasperAccept([]), null);
  assert.equal(selectCasperAccept(undefined), null);
});

test("selectCasperAccept ignores non-exact schemes", () => {
  assert.equal(
    selectCasperAccept([casperAccept({ scheme: "upto" })]),
    null,
  );
});

test("selectCasperAccept prefers the requested Casper network", () => {
  const accepts = [
    baseAccept(),
    casperAccept({ network: CASPER_TESTNET }),
    casperAccept({ network: CASPER_MAINNET }),
  ];
  assert.equal(
    selectCasperAccept(accepts, CASPER_MAINNET).network,
    CASPER_MAINNET,
  );
  assert.equal(
    selectCasperAccept(accepts, CASPER_TESTNET).network,
    CASPER_TESTNET,
  );
  // Unknown/Base preference falls back to the first Casper entry.
  assert.equal(selectCasperAccept(accepts, "base").network, CASPER_TESTNET);
});

test("gateSupportsCasper is false for a Base-only gate", () => {
  assert.equal(gateSupportsCasper({ accepts: [baseAccept()] }), false);
  assert.equal(
    gateSupportsCasper({ accepts: [baseAccept(), casperAccept()] }),
    true,
  );
});

// --- Payload construction ------------------------------------------------

test("buildCasperPaymentPayload emits a v2 exact-scheme envelope", () => {
  const payload = buildCasperPaymentPayload({
    accept: casperAccept(),
    from: FROM,
    signature: SIG,
    now: () => 1_700_000_000_000,
    nonce: "0xabc",
  });
  assert.deepEqual(payload, {
    x402Version: 2,
    scheme: "exact",
    network: CASPER_TESTNET,
    payload: {
      signature: SIG,
      authorization: {
        from: FROM,
        to: PAY_TO,
        value: "1000000000",
        validAfter: "0",
        validBefore: String(1_700_000_000 + 600),
        nonce: "0xabc",
      },
    },
  });
});

test("buildCasperPaymentPayload honours a custom validity window", () => {
  const payload = buildCasperPaymentPayload({
    accept: casperAccept(),
    from: FROM,
    signature: SIG,
    validitySeconds: 30,
    now: () => 1_700_000_000_000,
  });
  assert.equal(payload.payload.authorization.validBefore, "1700000030");
});

test("buildCasperPaymentPayload generates a fresh 32-byte nonce by default", () => {
  const mk = () =>
    buildCasperPaymentPayload({ accept: casperAccept(), from: FROM, signature: SIG })
      .payload.authorization.nonce;
  const a = mk();
  const b = mk();
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a, b);
  assert.match(casperNonce(), /^0x[0-9a-f]{64}$/);
});

test("buildCasperPaymentPayload rejects malformed accepts entries", () => {
  const cases = [
    ["non-exact scheme", { scheme: "upto" }],
    ["non-Casper network", { network: "base" }],
    ["missing payTo", { payTo: "" }],
    ["missing asset", { asset: "" }],
    ["zero amount", { maxAmountRequired: "0" }],
  ];
  for (const [label, override] of cases) {
    assert.throws(
      () =>
        buildCasperPaymentPayload({
          accept: casperAccept(override),
          from: FROM,
          signature: SIG,
        }),
      CasperConfigurationError,
      label,
    );
  }
  assert.throws(
    () =>
      buildCasperPaymentPayload({
        accept: casperAccept(),
        from: "",
        signature: SIG,
      }),
    CasperConfigurationError,
  );
  assert.throws(
    () =>
      buildCasperPaymentPayload({
        accept: casperAccept(),
        from: FROM,
        signature: "",
      }),
    CasperConfigurationError,
  );
});

test("buildCasperPaymentPayload throws on a fractional maxAmountRequired", () => {
  assert.throws(
    () =>
      buildCasperPaymentPayload({
        accept: casperAccept({ maxAmountRequired: "1000.5" }),
        from: FROM,
        signature: SIG,
      }),
    CasperAmountPrecisionError,
  );
});

// --- Fail-closed facilitator client --------------------------------------

function clientWith(handler) {
  return new CasperFacilitatorClient({
    baseUrl: "https://facilitator.test",
    fetchImpl: handler,
  });
}

function jsonResponse(body, status = 200) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const PAYLOAD = buildCasperPaymentPayload({
  accept: casperAccept(),
  from: FROM,
  signature: SIG,
  nonce: "0xfeed",
  now: () => 1_700_000_000_000,
});

test("verify passes only on an explicit isValid === true", async () => {
  const client = clientWith(jsonResponse({ isValid: true, payer: FROM }));
  const res = await client.verify(PAYLOAD, casperAccept());
  assert.equal(res.isValid, true);
  assert.equal(res.payer, FROM);
});

test("verify posts x402 v2 envelope to /verify", async () => {
  let seenUrl;
  let seenBody;
  const client = clientWith(async (url, init) => {
    seenUrl = url;
    seenBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ isValid: true }), { status: 200 });
  });
  await client.verify(PAYLOAD, casperAccept());
  assert.equal(seenUrl, "https://facilitator.test/verify");
  assert.equal(seenBody.x402Version, 2);
  assert.equal(seenBody.paymentPayload.network, CASPER_TESTNET);
  assert.equal(seenBody.paymentRequirements.asset, WCSPR);
});

test("verify FAILS CLOSED on non-2xx", async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503]) {
    const client = clientWith(jsonResponse({ isValid: true }, status));
    await assert.rejects(
      () => client.verify(PAYLOAD, casperAccept()),
      (err) => {
        assert.ok(err instanceof CasperFacilitatorError);
        assert.equal(err.status, status);
        return true;
      },
      `status ${status} must not pass`,
    );
  }
});

test("verify FAILS CLOSED on an unparseable body", async () => {
  const client = clientWith(
    async () => new Response("<html>gateway</html>", { status: 200 }),
  );
  await assert.rejects(
    () => client.verify(PAYLOAD, casperAccept()),
    /unparseable body/,
  );
});

test("verify FAILS CLOSED on a missing or non-true verdict", async () => {
  for (const body of [
    {},
    { isValid: false },
    { isValid: "true" },
    { isValid: 1 },
    { isValid: null },
    { valid: true },
    { isValid: false, invalidReason: "insufficient_funds" },
  ]) {
    const client = clientWith(jsonResponse(body));
    await assert.rejects(
      () => client.verify(PAYLOAD, casperAccept()),
      CasperFacilitatorError,
      `body ${JSON.stringify(body)} must not pass`,
    );
  }
});

test("verify FAILS CLOSED when the host is unreachable", async () => {
  const client = clientWith(async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  });
  await assert.rejects(
    () => client.verify(PAYLOAD, casperAccept()),
    (err) => {
      assert.ok(err instanceof CasperFacilitatorError);
      assert.match(err.message, /unreachable/);
      return true;
    },
  );
});

test("settle returns the transaction hash on success", async () => {
  const client = clientWith(
    jsonResponse({ success: true, transaction: "deploy-hash-abc", payer: FROM }),
  );
  const res = await client.settle(PAYLOAD, casperAccept());
  assert.deepEqual(res, {
    success: true,
    transaction: "deploy-hash-abc",
    network: CASPER_TESTNET,
    payer: FROM,
  });
});

test("settle FAILS CLOSED on non-2xx, bad body, or missing success", async () => {
  const failures = [
    ["http 500", jsonResponse({ success: true, transaction: "x" }, 500)],
    ["unparseable", async () => new Response("nope", { status: 200 })],
    ["success false", jsonResponse({ success: false })],
    ["success string", jsonResponse({ success: "true", transaction: "x" })],
    ["success missing", jsonResponse({ transaction: "x" })],
    ["errorReason", jsonResponse({ success: false, errorReason: "expired" })],
  ];
  for (const [label, handler] of failures) {
    await assert.rejects(
      () => clientWith(handler).settle(PAYLOAD, casperAccept()),
      CasperFacilitatorError,
      label,
    );
  }
});

test("settle FAILS CLOSED when success is true but no tx hash comes back", async () => {
  for (const body of [
    { success: true },
    { success: true, transaction: "" },
    { success: true, transaction: 123 },
    { success: true, transaction: null },
  ]) {
    await assert.rejects(
      () => clientWith(jsonResponse(body)).settle(PAYLOAD, casperAccept()),
      /without a transaction hash/,
    );
  }
});

test("supported lists facilitator kinds and fails closed otherwise", async () => {
  const ok = clientWith(
    jsonResponse({
      kinds: [
        { scheme: "exact", network: CASPER_MAINNET },
        { scheme: "exact", network: CASPER_TESTNET },
        { bogus: true },
      ],
    }),
  );
  assert.deepEqual(await ok.supported(), [
    { scheme: "exact", network: CASPER_MAINNET },
    { scheme: "exact", network: CASPER_TESTNET },
  ]);

  await assert.rejects(
    () => clientWith(jsonResponse({ kinds: [] }, 503)).supported(),
    CasperFacilitatorError,
  );
  await assert.rejects(
    () => clientWith(jsonResponse({})).supported(),
    /no `kinds` array/,
  );
  await assert.rejects(
    () =>
      clientWith(async () => new Response("!", { status: 200 })).supported(),
    /unparseable body/,
  );
});

test("client strips trailing slashes from the base URL", async () => {
  let seen;
  const client = new CasperFacilitatorClient({
    baseUrl: "https://facilitator.test///",
    fetchImpl: async (url) => {
      seen = url;
      return new Response(JSON.stringify({ isValid: true }), { status: 200 });
    },
  });
  await client.verify(PAYLOAD, casperAccept());
  assert.equal(seen, "https://facilitator.test/verify");
});

// --- Opt-in: zero behaviour change for existing Base deployments ----------

test("a Base-only gate is not routed to Casper", () => {
  const gate = {
    gate_id: "g_1",
    x402Version: 1,
    accepts: [baseAccept()],
    facilitators: [{ name: "x", url: "https://f.test", priority: 1, spec_version: "v1" }],
    seller_wallet: "0x1111111111111111111111111111111111111111",
    network: "base",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  };
  assert.equal(gateNeedsCasperSettlement(gate), false);
  assert.equal(gateSupportsCasper(gate), false);
});

test("the EIP-3009 path still settles a Base gate with no Casper env set", async () => {
  delete process.env.XENARCH_CASPER_FACILITATOR_URL;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith("/settle")) {
      return new Response(
        JSON.stringify({ success: true, transaction: "0xbeef" }),
        { status: 200 },
      );
    }
    return new Response("ok", { status: 200 });
  };
  try {
    const result = await settleX402(
      {
        // Well-known Hardhat test key — never funded, used only to exercise
        // the signer deterministically.
        privateKey:
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        maxPaymentUsd: 0,
      },
      {
        gate_id: "g_1",
        x402Version: 1,
        accepts: [baseAccept()],
        facilitators: [
          { name: "x", url: "https://f.test", priority: 1, spec_version: "v1" },
        ],
        seller_wallet: "0x1111111111111111111111111111111111111111",
        network: "base",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
    );
    assert.deepEqual(result, {
      txHash: "0xbeef",
      facilitator: "https://f.test",
    });
    assert.deepEqual(calls, ["https://f.test/settle"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the EIP-3009 signer refuses a Casper accepts entry instead of mis-signing", async () => {
  await assert.rejects(
    () =>
      settleX402(
        {
          privateKey:
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
          maxPaymentUsd: 0,
        },
        {
          gate_id: "g_2",
          x402Version: 2,
          accepts: [casperAccept()],
          facilitators: [
            { name: "x", url: "https://f.test", priority: 1, spec_version: "v2" },
          ],
          seller_wallet: PAY_TO,
          network: CASPER_TESTNET,
          asset: WCSPR,
        },
      ),
    (err) => {
      assert.ok(err instanceof CasperConfigurationError);
      assert.match(err.message, /EIP-3009 signer cannot sign/);
      return true;
    },
  );
});
