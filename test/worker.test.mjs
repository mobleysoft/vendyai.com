import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fakeD1 } from "./fake-d1.mjs";
import worker from "../src/worker.js";

const ADMIN_SECRET = "test-admin-secret";

function makeEnv() {
  const { db, ventures, sessions, products } = fakeD1();
  return { env: { DB: db, ADMIN_SECRET, STRIPE_SECRET_KEY: "sk_test_fake" }, ventures, sessions, products };
}

// Real-enough fake Stripe: creates deterministic ids, records what was
// sent, and returns shapes matching the real fields this worker reads.
function fakeStripeFetch() {
  const calls = [];
  let seq = 0;
  const existingPrices = {
    price_existing_live: { id: "price_existing_live", active: true, unit_amount: 29900, currency: "usd", recurring: { interval: "month" } },
    price_existing_inactive: { id: "price_existing_inactive", active: false, unit_amount: 500, currency: "usd", recurring: null },
  };
  return {
    calls,
    fetchImpl: async (url, opts) => {
      const path = url.replace("https://api.stripe.com/v1", "");
      const bodyStr = opts?.body || "";
      calls.push({ path, method: opts.method, bodyStr });
      seq += 1;
      if (path.startsWith("/prices/") && (!opts.method || opts.method === "GET")) {
        const priceId = path.slice("/prices/".length);
        const price = existingPrices[priceId];
        return price ? jsonRes(price) : jsonRes({ error: { message: "No such price" } }, 404);
      }
      if (path === "/products") {
        return jsonRes({ id: `prod_${seq}` });
      }
      if (path === "/prices") {
        return jsonRes({ id: `price_${seq}` });
      }
      if (path === "/checkout/sessions") {
        return jsonRes({ id: `cs_test_${seq}`, url: `https://checkout.stripe.com/c/pay/cs_test_${seq}`, status: "open", amount_total: 1999, currency: "usd" });
      }
      return jsonRes({ error: { message: `unhandled stripe path ${path}` } }, 500);
    },
  };
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function req(path, { method = "GET", body, headers = {} } = {}) {
  return new Request(`https://vendyai.com${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

test("v2: registering a product with an unregistered venture_id is rejected", async () => {
  const { env } = makeEnv();
  const stripe = fakeStripeFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  try {
    const res = await worker.fetch(
      req("/api/v2/products", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "ghostventure", name: "Widget", unit_amount_cents: 500 },
      }),
      env
    );
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error.code, "UNKNOWN_VENTURE");
    assert.equal(stripe.calls.length, 0, "must not call Stripe before venture is confirmed registered");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v2: registering a product without the admin secret is rejected", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(
    req("/api/v2/products", { method: "POST", body: { venture_id: "weylandai", name: "Widget", unit_amount_cents: 500 } }),
    env
  );
  assert.equal(res.status, 401);
});

test("v2: full flow - register venture, register product, create checkout session by price_ref, list products", async () => {
  const { env, ventures, products, sessions } = makeEnv();
  const stripe = fakeStripeFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  try {
    // Register the venture the same way /api/ventures/register already does.
    const regRes = await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/api/webhooks/subscription", hmac_secret: "s3cret" },
      }),
      env
    );
    assert.equal(regRes.status, 201);
    assert.equal(ventures.length, 1);

    // Register a real product - should create a Stripe Product+Price and
    // return a provider-neutral price_ref, never a Stripe price id.
    const prodRes = await worker.fetch(
      req("/api/v2/products", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", name: "SubX Pro", description: "Monthly plan", unit_amount_cents: 19900, currency: "usd", recurring_interval: "month" },
      }),
      env
    );
    assert.equal(prodRes.status, 201);
    const prodData = await prodRes.json();
    assert.match(prodData.product.price_ref, /^vpr_[a-f0-9]{32}$/);
    assert.equal(prodData.product.unit_amount_cents, 19900);
    assert.equal(products.length, 1);
    assert.equal(products[0].provider_price_id, "price_2", "Stripe price id must never be returned to the caller");
    assert.ok(!JSON.stringify(prodData).includes("price_2"), "response body must not leak the raw Stripe price id");

    const priceRef = prodData.product.price_ref;

    // List the venture's catalog.
    const listRes = await worker.fetch(req(`/api/v2/products?venture_id=weylandai`), env);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.products.length, 1);
    assert.equal(listData.products[0].price_ref, priceRef);

    // Create a v2 checkout session using only the price_ref - never a raw Stripe price id.
    const checkoutRes = await worker.fetch(
      req("/api/v2/checkout/sessions", {
        method: "POST",
        body: {
          venture_id: "weylandai",
          price_refs: [{ price_ref: priceRef, quantity: 2 }],
          mode: "subscription",
          success_url: "https://weylandai.com/success",
          cancel_url: "https://weylandai.com/cancel",
          metadata: { product_id: "subx" },
        },
      }),
      env
    );
    assert.equal(checkoutRes.status, 201);
    const checkoutData = await checkoutRes.json();
    assert.ok(checkoutData.session.id.startsWith("cs_test_"));
    assert.ok(checkoutData.session.url.startsWith("https://checkout.stripe.com/"));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].api_version, "v2");
    assert.equal(sessions[0].venture_id, "weylandai");

    // The real Stripe checkout-session call must have received the resolved
    // Stripe price id, never the price_ref string.
    const checkoutCall = stripe.calls.find((c) => c.path === "/checkout/sessions");
    assert.ok(checkoutCall.bodyStr.includes("price_2"));
    assert.ok(!checkoutCall.bodyStr.includes(priceRef));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v2: checkout session creation rejects an unknown or inactive price_ref", async () => {
  const { env } = makeEnv();
  const stripe = fakeStripeFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    const res = await worker.fetch(
      req("/api/v2/checkout/sessions", {
        method: "POST",
        body: {
          venture_id: "weylandai",
          price_refs: [{ price_ref: "vpr_doesnotexist" }],
          success_url: "https://weylandai.com/success",
          cancel_url: "https://weylandai.com/cancel",
        },
      }),
      env
    );
    assert.equal(res.status, 404);
    const data = await res.json();
    assert.equal(data.error.code, "UNKNOWN_PRICE_REF");
    assert.equal(stripe.calls.length, 0, "must not call Stripe checkout creation for an unresolved price_ref");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v2: registering a product with provider_price_id reuses the existing Stripe price instead of creating a new one", async () => {
  const { env, products } = makeEnv();
  const stripe = fakeStripeFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    const prodRes = await worker.fetch(
      req("/api/v2/products", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", name: "SubX seat", provider_price_id: "price_existing_live" },
      }),
      env
    );
    assert.equal(prodRes.status, 201);
    const prodData = await prodRes.json();
    assert.equal(prodData.product.unit_amount_cents, 29900, "amount must come from the real Stripe price, not a guess");
    assert.equal(prodData.product.currency, "usd");
    assert.equal(prodData.product.recurring_interval, "month");
    assert.equal(products[0].provider_price_id, "price_existing_live", "must reuse the existing price id, not mint a new one");
    assert.ok(
      !stripe.calls.some((c) => c.path === "/products" || c.path === "/prices"),
      "must not create a new Stripe Product/Price when reusing an existing price"
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v2: registering a product with an inactive provider_price_id is rejected", async () => {
  const { env } = makeEnv();
  const stripe = fakeStripeFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    const res = await worker.fetch(
      req("/api/v2/products", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", name: "Dead seat", provider_price_id: "price_existing_inactive" },
      }),
      env
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error.code, "INACTIVE_PRICE");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("webhook: a completed checkout posts a real settlement entry to mobcoin.cc's ledger", async () => {
  const { env, sessions } = makeEnv();
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const mobcoinCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://mobcoin.cc/api/mobcoin/ledger")) {
      mobcoinCalls.push({ url: href, headers: opts.headers, body: JSON.parse(opts.body) });
      return jsonRes({ ok: true, id: "entry_1" }, 201);
    }
    if (href.includes("/checkout/sessions/cs_test_settle")) {
      return jsonRes({
        payment_intent: {
          latest_charge: {
            balance_transaction: { fee: 42, net: 358 },
          },
        },
      });
    }
    return jsonRes({ error: { message: `unhandled fetch ${href}` } }, 500);
  };
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    // mobcoin.cc's own hmac registration (real production row, provisioned
    // for its /api/vendyai-webhook signature verification) - postMobcoinLedgerEntry
    // (2026-09-24 depth audit) now signs its outbound ledger POST with this
    // same secret rather than posting unsigned.
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "mobcoin.cc", webhook_url: "https://mobcoin.cc/api/vendyai-webhook", hmac_secret: "mobcoin-s3cret" },
      }),
      env
    );
    sessions.push({ id: "row1", venture_id: "weylandai", stripe_session_id: "cs_test_settle", status: "open" });

    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_settle",
          customer: "cus_123",
          amount_total: 400,
          currency: "usd",
          metadata: { venture_id: "weylandai" },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");

    const res = await worker.fetch(
      new Request("https://vendyai.com/api/stripe/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
        body: payload,
      }),
      env
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.mobcoin_ledger.posted, true);

    assert.equal(mobcoinCalls.length, 1, "must post exactly one settlement entry to mobcoin.cc's ledger");
    assert.equal(mobcoinCalls[0].body.from_venture, "vendyai.com");
    assert.equal(mobcoinCalls[0].body.to_venture, "weylandai");
    assert.equal(mobcoinCalls[0].body.units, 358, "must settle the real net-of-fee amount, not the gross amount");
    assert.match(mobcoinCalls[0].body.memo, /cs_test_settle/);
    assert.ok(mobcoinCalls[0].headers["X-Webhook-Signature"], "ledger POST must be HMAC-signed, not sent unsigned");
    assert.ok(mobcoinCalls[0].headers["X-Webhook-Timestamp"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("webhook: an out-of-range settlement amount is skipped, not posted, to mobcoin.cc's ledger", async () => {
  const { env, sessions } = makeEnv();
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const mobcoinCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://mobcoin.cc/api/mobcoin/ledger")) {
      mobcoinCalls.push({ url: href, body: JSON.parse(opts.body) });
      return jsonRes({ ok: true }, 201);
    }
    if (href.includes("/checkout/sessions/cs_test_toobig")) {
      // Fee capture fails/returns nothing usable - falls back to gross,
      // which here deliberately exceeds the ledger's own validated bound.
      return jsonRes({ payment_intent: {} });
    }
    return jsonRes({ error: { message: `unhandled fetch ${href}` } }, 500);
  };
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    sessions.push({ id: "row2", venture_id: "weylandai", stripe_session_id: "cs_test_toobig", status: "open" });

    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_toobig",
          customer: "cus_123",
          amount_total: 5000000,
          currency: "usd",
          metadata: { venture_id: "weylandai" },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");

    const res = await worker.fetch(
      new Request("https://vendyai.com/api/stripe/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
        body: payload,
      }),
      env
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.mobcoin_ledger.posted, false);
    assert.equal(data.mobcoin_ledger.reason, "units_out_of_range");
    assert.equal(mobcoinCalls.length, 0, "must not post an out-of-range amount to the ledger");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("v1: existing /api/checkout/sessions contract is completely unaffected by the v2 additions", async () => {
  const { env, sessions } = makeEnv();
  const stripe = fakeStripeFetch();
  const origFetch = globalThis.fetch;
  globalThis.fetch = stripe.fetchImpl;
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    const res = await worker.fetch(
      req("/api/checkout/sessions", {
        method: "POST",
        body: {
          venture_id: "weylandai",
          success_url: "https://weylandai.com/success",
          cancel_url: "https://weylandai.com/cancel",
          line_items: [{ price: "price_1AbCRealStripePriceId", quantity: 1 }],
        },
      }),
      env
    );
    assert.equal(res.status, 201);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].api_version, "v1");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("webhook: v1 session forwards the legacy Stripe-shaped payload, byte-for-byte unchanged", async () => {
  const { env, sessions } = makeEnv();
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const forwardCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href === "https://weylandai.com/hook") {
      forwardCalls.push(JSON.parse(opts.body));
      return jsonRes({ ok: true });
    }
    if (href.startsWith("https://mobcoin.cc/api/mobcoin/ledger")) {
      return jsonRes({ ok: true, id: "entry_1" }, 201);
    }
    if (href.includes("/checkout/sessions/cs_test_v1fwd")) {
      return jsonRes({ payment_intent: { latest_charge: { balance_transaction: { fee: 10, net: 90 } } } });
    }
    return jsonRes({ error: { message: `unhandled fetch ${href}` } }, 500);
  };
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    sessions.push({ id: "row3", venture_id: "weylandai", stripe_session_id: "cs_test_v1fwd", status: "open", api_version: "v1" });

    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_v1fwd",
          customer: "cus_v1",
          mode: "payment",
          amount_total: 100,
          currency: "usd",
          customer_details: { email: "a@b.com", name: "A B" },
          metadata: { venture_id: "weylandai" },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");

    const res = await worker.fetch(
      new Request("https://vendyai.com/api/stripe/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
        body: payload,
      }),
      env
    );
    assert.equal(res.status, 200);
    assert.equal(forwardCalls.length, 1);
    assert.equal(forwardCalls[0].type, "checkout.session.completed", "v1 sessions must keep the legacy {type, data} shape");
    assert.equal(forwardCalls[0].data.id, "cs_test_v1fwd");
    assert.equal(forwardCalls[0].data.customer, "cus_v1");
    assert.equal(forwardCalls[0].data.stripe_fee_cents, 10);
    assert.equal(forwardCalls[0].data.net_to_venture_cents, 90);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("webhook: v2 session forwards the provider-neutral payment.completed shape, not Stripe's own", async () => {
  const { env, sessions } = makeEnv();
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const forwardCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href === "https://weylandai.com/hook") {
      forwardCalls.push(JSON.parse(opts.body));
      return jsonRes({ ok: true });
    }
    if (href.startsWith("https://mobcoin.cc/api/mobcoin/ledger")) {
      return jsonRes({ ok: true, id: "entry_1" }, 201);
    }
    if (href.includes("/checkout/sessions/cs_test_v2fwd")) {
      return jsonRes({ payment_intent: { latest_charge: { balance_transaction: { fee: 12, net: 388 } } } });
    }
    return jsonRes({ error: { message: `unhandled fetch ${href}` } }, 500);
  };
  try {
    await worker.fetch(
      req("/api/ventures/register", {
        method: "POST",
        headers: { "X-Admin-Secret": ADMIN_SECRET },
        body: { venture_id: "weylandai", webhook_url: "https://weylandai.com/hook", hmac_secret: "s3cret" },
      }),
      env
    );
    sessions.push({ id: "row4", venture_id: "weylandai", stripe_session_id: "cs_test_v2fwd", status: "open", api_version: "v2" });

    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_v2fwd",
          customer: "cus_v2",
          amount_total: 400,
          currency: "usd",
          customer_details: { email: "c@d.com", name: "C D" },
          metadata: { venture_id: "weylandai", product_id: "widget" },
        },
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");

    const res = await worker.fetch(
      new Request("https://vendyai.com/api/stripe/webhook", {
        method: "POST",
        headers: { "Stripe-Signature": `t=${timestamp},v1=${signature}` },
        body: payload,
      }),
      env
    );
    assert.equal(res.status, 200);
    assert.equal(forwardCalls.length, 1);
    const fwd = forwardCalls[0];
    assert.equal(fwd.event, "payment.completed");
    assert.equal(fwd.venture_id, "weylandai");
    assert.equal(fwd.external_reference, "cs_test_v2fwd");
    assert.equal(fwd.customer.ref, "cus_v2");
    assert.equal(fwd.customer.email, "c@d.com");
    assert.equal(fwd.customer.name, "C D");
    assert.equal(fwd.amount_total_cents, 400);
    assert.equal(fwd.currency, "usd");
    assert.equal(fwd.provider_fee_cents, 12);
    assert.equal(fwd.net_cents, 388);
    assert.deepEqual(fwd.metadata, { venture_id: "weylandai", product_id: "widget" });
    assert.ok(fwd.occurred_at, "must include a real timestamp");
    assert.equal(fwd.type, undefined, "v2 shape must not carry the old Stripe-mirrored field names");
    assert.equal(fwd.data, undefined);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("admin prune: deletes only 'open' sessions older than the cutoff, leaves recent and completed rows alone", async () => {
  // Timestamps computed relative to the real clock at test-run time, not
  // hardcoded absolute dates - a hardcoded "recent" date silently becomes
  // "stale" once enough real time passes, making this test fail on an
  // unrelated later date with no code change (found 2026-09-25: the old
  // "2026-09-19 23:00:00" "recent" row had drifted past the 2-day cutoff
  // by the time this ran, deleting 2 rows instead of the expected 1).
  const toSqlTimestamp = (d) => d.toISOString().replace("T", " ").slice(0, 19);
  const fiveDaysAgo = toSqlTimestamp(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
  const oneHourAgo = toSqlTimestamp(new Date(Date.now() - 60 * 60 * 1000));
  const { env, sessions } = makeEnv();
  sessions.push(
    { id: "a", venture_id: "x", stripe_session_id: "cs_old_open", status: "open", created_at: fiveDaysAgo },
    { id: "b", venture_id: "x", stripe_session_id: "cs_old_completed", status: "completed", created_at: fiveDaysAgo },
    { id: "c", venture_id: "x", stripe_session_id: "cs_recent_open", status: "open", created_at: oneHourAgo }
  );
  const res = await worker.fetch(
    req("/api/admin/prune-stale-sessions", { method: "POST", headers: { "X-Admin-Secret": ADMIN_SECRET } }),
    env
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.deleted, 1);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((s) => s.stripe_session_id === "cs_old_completed"), "completed rows must never be pruned");
  assert.ok(sessions.some((s) => s.stripe_session_id === "cs_recent_open"), "recent open rows must survive");
  assert.ok(!sessions.some((s) => s.stripe_session_id === "cs_old_open"), "stale open row must be deleted");
});

test("admin prune: rejected without the admin secret", async () => {
  const { env } = makeEnv();
  const res = await worker.fetch(req("/api/admin/prune-stale-sessions", { method: "POST" }), env);
  assert.equal(res.status, 401);
});
