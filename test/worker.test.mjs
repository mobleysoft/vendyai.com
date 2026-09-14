import { test } from "node:test";
import assert from "node:assert/strict";
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
  return {
    calls,
    fetchImpl: async (url, opts) => {
      const path = url.replace("https://api.stripe.com/v1", "");
      const bodyStr = opts?.body || "";
      calls.push({ path, method: opts.method, bodyStr });
      seq += 1;
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
