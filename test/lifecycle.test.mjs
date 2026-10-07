// node --test test/lifecycle.test.mjs
//
// 2026-10-07: subscription lifecycle forwarding (renewals, failed payments,
// cancellations) to ventures that apply them (weylandai), the extra fields on
// weylandai's completed-checkout forward, retry-on-failed-delivery for those
// ventures, and the venture on hosted subscriptions. Stripe-signed requests
// are built here with a test secret; forwards are checked for vendyai's own
// base64url HMAC exactly as weylandai verifies it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fakeD1 } from "./fake-d1.mjs";
import worker from "../src/worker.js";

const ADMIN_SECRET = "test-admin-secret";
const STRIPE_WEBHOOK_SECRET = "whsec_test_lifecycle";
const VENTURE_SECRET = "venture-hmac-secret";

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function setup({ ventures = ["weylandai"] } = {}) {
  const { db, sessions } = fakeD1();
  const env = { DB: db, ADMIN_SECRET, STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET };
  const forwards = [];
  const ledger = [];
  const stripeCalls = [];
  const state = { consumerStatus: 200 };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("https://consumer.example/")) {
      forwards.push({ url: href, headers: opts.headers, body: opts.body, json: JSON.parse(opts.body) });
      return jsonRes({ received: true }, state.consumerStatus);
    }
    if (href.startsWith("https://mobcoin.cc/api/mobcoin/ledger")) {
      ledger.push(JSON.parse(opts.body));
      return jsonRes({ ok: true }, 201);
    }
    if (href.startsWith("https://api.stripe.com/v1/")) {
      stripeCalls.push({ path: href.slice("https://api.stripe.com/v1".length), method: opts.method || "GET", body: opts.body || "" });
      if (href.includes("/checkout/sessions/")) return jsonRes({ payment_intent: null });
      if (href.endsWith("/checkout/sessions")) return jsonRes({ id: "cs_test_hosted1", url: "https://checkout.stripe.com/c/pay/cs_test_hosted1", status: "open", amount_total: 0, currency: "usd" });
      return jsonRes({ error: { message: "unhandled" } }, 500);
    }
    return jsonRes({ error: { message: "unhandled fetch " + href } }, 500);
  };
  for (const v of [...ventures, "mobcoin.cc"]) {
    await worker.fetch(new Request("https://vendyai.com/api/ventures/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Secret": ADMIN_SECRET },
      body: JSON.stringify({ venture_id: v, webhook_url: "https://consumer.example/" + v, hmac_secret: VENTURE_SECRET }),
    }), env);
  }
  return { env, sessions, forwards, ledger, stripeCalls, state, restore: () => { globalThis.fetch = origFetch; } };
}

function stripeEvent(env, event) {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex");
  return worker.fetch(new Request("https://vendyai.com/api/stripe/webhook", { method: "POST", headers: { "Stripe-Signature": `t=${t},v1=${v1}` }, body }), env);
}

function verifiesAsWeylandai(fwd) {
  const ts = fwd.headers["X-Webhook-Timestamp"];
  const expected = createHmac("sha256", VENTURE_SECRET).update(`${ts}.${fwd.body}`).digest("base64url");
  return expected === fwd.headers["X-Webhook-Signature"];
}

const subscription = (over = {}) => ({
  id: "sub_test_1", object: "subscription", customer: "cus_test_1", status: "canceled",
  cancel_at_period_end: false, canceled_at: 1790000000, current_period_end: 1790000000,
  metadata: { venture_id: "weylandai", product_id: "weyland-meetingx-seat", seats: "1" },
  default_payment_method: "pm_should_not_be_forwarded",
  items: { data: [{ id: "si_1", quantity: 1, price: { id: "price_meetingx", unit_amount: 69900, product: "prod_x" } }] },
  ...over,
});

test("customer.subscription.deleted of a weylandai subscription is forwarded, signed, trimmed, with the event id and time", async () => {
  const h = await setup();
  try {
    const res = await stripeEvent(h.env, { id: "evt_del_1", type: "customer.subscription.deleted", created: 1790000100, data: { object: subscription() } });
    assert.equal(res.status, 200);
    assert.equal(h.forwards.length, 1);
    const f = h.forwards[0];
    assert.equal(f.url, "https://consumer.example/weylandai");
    assert.ok(verifiesAsWeylandai(f), "signed with the venture's secret, base64url, as weylandai checks it");
    assert.deepEqual(Object.keys(f.json).sort(), ["created", "data", "id", "type"]);
    assert.equal(f.json.id, "evt_del_1");
    assert.equal(f.json.created, 1790000100);
    assert.equal(f.json.type, "customer.subscription.deleted");
    assert.equal(f.json.data.id, "sub_test_1");
    assert.equal(f.json.data.status, "canceled");
    assert.equal(f.json.data.customer, "cus_test_1");
    assert.equal(f.json.data.items.data[0].price.id, "price_meetingx");
    assert.equal(f.json.data.metadata.venture_id, "weylandai");
    assert.equal(f.body.includes("pm_should_not_be_forwarded"), false, "payment details are not forwarded");
    assert.equal(h.stripeCalls.length, 0, "no Stripe call for a lifecycle event");
    assert.equal(h.ledger.length, 0, "no settlement entry for a lifecycle event");
  } finally {
    h.restore();
  }
});

test("customer.subscription.updated (past_due) and invoice.payment_failed / invoice.paid reach weylandai; the 2025+ invoice shape too", async () => {
  const h = await setup();
  try {
    await stripeEvent(h.env, { id: "evt_upd", type: "customer.subscription.updated", created: 1790000200, data: { object: subscription({ status: "past_due" }) } });
    const acacia = {
      id: "in_1", object: "invoice", customer: "cus_test_1", billing_reason: "subscription_cycle", status: "open",
      subscription: "sub_test_1", subscription_details: { metadata: { venture_id: "weylandai" } },
      customer_address: { line1: "should not be forwarded" },
      lines: { data: [{ type: "subscription", subscription: "sub_test_1", quantity: 1, price: { id: "price_meetingx" }, metadata: { venture_id: "weylandai" } }] },
    };
    await stripeEvent(h.env, { id: "evt_fail", type: "invoice.payment_failed", created: 1790000300, data: { object: acacia } });
    const basil = {
      id: "in_2", object: "invoice", customer: "cus_test_1", billing_reason: "subscription_cycle", status: "paid",
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_test_1", metadata: { venture_id: "weylandai" } } },
      lines: { data: [{ quantity: 1, pricing: { price_details: { price: "price_meetingx" } }, parent: { subscription_item_details: { subscription: "sub_test_1" } } }] },
    };
    await stripeEvent(h.env, { id: "evt_paid", type: "invoice.paid", created: 1790000400, data: { object: basil } });
    assert.deepEqual(h.forwards.map((f) => f.json.type), ["customer.subscription.updated", "invoice.payment_failed", "invoice.paid"]);
    assert.equal(h.forwards[0].json.data.status, "past_due");
    assert.equal(h.forwards[1].json.data.subscription, "sub_test_1");
    assert.equal(h.forwards[1].json.data.billing_reason, "subscription_cycle");
    assert.equal(h.forwards[1].body.includes("should not be forwarded"), false);
    assert.equal(h.forwards[2].json.data.subscription, "sub_test_1");
    assert.equal(h.forwards[2].json.data.subscription_details.metadata.venture_id, "weylandai");
    assert.equal(h.forwards[2].json.data.lines.data[0].price.id, "price_meetingx");
    assert.equal(h.forwards[2].json.data.lines.data[0].subscription, "sub_test_1");
    assert.ok(h.forwards.every(verifiesAsWeylandai));
  } finally {
    h.restore();
  }
});

test("a subscription without venture metadata is routed by the customer's completed vendyai checkout", async () => {
  const h = await setup();
  try {
    h.sessions.push({ id: "row1", venture_id: "weylandai", stripe_session_id: "cs_old", status: "completed", stripe_customer_id: "cus_hosted", api_version: "v1", created_at: "2026-10-07 10:00:00" });
    const res = await stripeEvent(h.env, { id: "evt_nometa", type: "customer.subscription.deleted", created: 1790000500, data: { object: subscription({ customer: "cus_hosted", metadata: {} }) } });
    assert.equal(res.status, 200);
    assert.equal(h.forwards.length, 1);
    assert.equal(h.forwards[0].json.data.customer, "cus_hosted");
  } finally {
    h.restore();
  }
});

test("other ventures' lifecycle events, and events of nobody's, are not forwarded", async () => {
  const h = await setup({ ventures: ["weylandai", "lawyik"] });
  try {
    const r1 = await stripeEvent(h.env, { id: "evt_l", type: "customer.subscription.deleted", created: 1, data: { object: subscription({ metadata: { venture_id: "lawyik" } }) } });
    assert.equal((await r1.json()).reason, "venture_not_subscribed_to_lifecycle_events");
    const r2 = await stripeEvent(h.env, { id: "evt_n", type: "invoice.payment_failed", created: 1, data: { object: { id: "in_x", customer: "cus_unknown", lines: { data: [] } } } });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).reason, "no_venture");
    const r3 = await stripeEvent(h.env, { id: "evt_c", type: "customer.subscription.created", created: 1, data: { object: subscription() } });
    assert.equal((await r3.json()).reason, "unhandled_event_type_or_missing_venture_id");
    assert.equal(h.forwards.length, 0);
  } finally {
    h.restore();
  }
});

test("weylandai not reachable: vendyai answers Stripe 503 so Stripe redelivers; the redelivery goes through", async () => {
  const h = await setup();
  try {
    h.state.consumerStatus = 500;
    const event = { id: "evt_retry", type: "customer.subscription.deleted", created: 1790000600, data: { object: subscription() } };
    const first = await stripeEvent(h.env, event);
    assert.equal(first.status, 503);
    assert.equal((await first.json()).retry, true);
    h.state.consumerStatus = 200;
    const again = await stripeEvent(h.env, event);
    assert.equal(again.status, 200);
    assert.equal(h.forwards.length, 2);
    assert.equal(h.forwards[1].json.id, "evt_retry", "same event id, so weylandai applies it once");
  } finally {
    h.restore();
  }
});

test("weylandai's completed-checkout forward carries the event id, time, subscription and buyer; a failed delivery is retried and settles once", async () => {
  const h = await setup();
  try {
    const session = {
      id: "cs_test_emb", object: "checkout.session", mode: "subscription", customer: "cus_new", subscription: "sub_new",
      client_reference_id: "user-123", customer_email: "buyer@example.com", amount_total: 4900, currency: "usd",
      customer_details: { email: "buyer@example.com", name: "Buyer" },
      metadata: { venture_id: "weylandai", product_id: "weyland-wire-seat", seats: "1", ui: "embedded" },
    };
    const event = { id: "evt_done", type: "checkout.session.completed", created: 1790000700, data: { object: session } };
    h.state.consumerStatus = 500;
    const failed = await stripeEvent(h.env, event);
    assert.equal(failed.status, 503);
    assert.equal(h.ledger.length, 0, "no settlement entry while the venture has not received it");
    h.state.consumerStatus = 200;
    const ok = await stripeEvent(h.env, event);
    assert.equal(ok.status, 200);
    assert.equal(h.ledger.length, 1, "settled once");
    const f = h.forwards[1].json;
    assert.equal(f.type, "checkout.session.completed");
    assert.equal(f.id, "evt_done");
    assert.equal(f.created, 1790000700);
    assert.equal(f.data.id, "cs_test_emb");
    assert.equal(f.data.subscription, "sub_new");
    assert.equal(f.data.client_reference_id, "user-123");
    assert.equal(f.data.customer_email, "buyer@example.com");
    assert.equal(f.data.metadata.product_id, "weyland-wire-seat");
  } finally {
    h.restore();
  }
});

test("other ventures' completed-checkout forward is unchanged: no extra fields, no retry status", async () => {
  const h = await setup({ ventures: ["weylandai", "bookclubs"] });
  try {
    h.state.consumerStatus = 500;
    const session = { id: "cs_test_bc", mode: "payment", customer: "cus_bc", amount_total: 900, currency: "usd", customer_details: { email: "a@b.c", name: "A" }, metadata: { venture_id: "bookclubs" } };
    const res = await stripeEvent(h.env, { id: "evt_bc", type: "checkout.session.completed", created: 1, data: { object: session } });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(h.forwards[0].json).sort(), ["data", "type"]);
    assert.equal("subscription" in h.forwards[0].json.data, false);
  } finally {
    h.restore();
  }
});

test("hosted subscription checkout: the venture goes on the subscription, and the buyer's account id on the session", async () => {
  const h = await setup();
  try {
    const res = await worker.fetch(new Request("https://vendyai.com/api/checkout/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venture_id: "weylandai", mode: "subscription", customer_email: "buyer@example.com", client_reference_id: "user-123",
        success_url: "https://weylandai.com/?checkout=success", cancel_url: "https://weylandai.com/",
        line_items: [{ price: "price_meetingx", quantity: 1 }], metadata: { product_id: "weyland-meetingx-seat", seats: "1" },
      }),
    }), h.env);
    assert.equal(res.status, 201);
    const form = new URLSearchParams(h.stripeCalls.find((c) => c.path === "/checkout/sessions").body);
    assert.equal(form.get("client_reference_id"), "user-123");
    assert.equal(form.get("subscription_data[metadata][venture_id]"), "weylandai");
    assert.equal(form.get("subscription_data[metadata][product_id]"), "weyland-meetingx-seat");
    assert.equal(form.get("metadata[venture_id]"), "weylandai");
    // A one-time payment gets no subscription_data.
    h.stripeCalls.length = 0;
    await worker.fetch(new Request("https://vendyai.com/api/checkout/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venture_id: "weylandai", success_url: "https://x/", cancel_url: "https://x/", line_items: [{ price: "price_x", quantity: 1 }] }),
    }), h.env);
    const form2 = new URLSearchParams(h.stripeCalls.find((c) => c.path === "/checkout/sessions").body);
    assert.equal(form2.get("subscription_data[metadata][venture_id]"), null);
    assert.equal(form2.get("client_reference_id"), null);
  } finally {
    h.restore();
  }
});
