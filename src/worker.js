/**
 * vendyai.com - the portfolio's single point of direct Stripe integration.
 * Built 2026-09-03 to replace the previous state: no working checkout
 * existed anywhere in the portfolio (the old vendyai.com/worker.js
 * hardcoded buy.stripe.com/test_placeholder links and admitted in a
 * comment that webhook signature verification wasn't implemented; its own
 * wrangler.toml named the worker
 * "vendyai-com-worker-DEAD-UNUSED-do-not-deploy"; the live vendyai.com
 * zone route pointed at the generic mobley-venture-fleet-a template, not
 * any dedicated worker at all).
 *
 * This implements the real contract weylandai.com's worker already calls
 * (POST {VENDYAI_API}/api/checkout/sessions, POST .../api/portal/sessions,
 * and an outbound HMAC-signed webhook matching its
 * /api/webhooks/subscription handler) - so weylandai becomes vendyai's
 * first real consumer on day one, not a hypothetical one. Other ventures
 * register their own webhook endpoint + secret via /api/ventures/register
 * to become additional consumers without any code change here.
 *
 * Real, load-bearing distinction: STRIPE_SECRET_KEY here is genuinely
 * live-mode (verified via GET /v1/account before building this - real
 * Stripe account, charges_enabled: true). Creating a Checkout Session
 * costs nothing and charges nobody by itself - a human still has to
 * complete it - but this worker is real payment infrastructure from the
 * moment it's deployed, not a sandbox.
 */

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(code, message, status = 400) {
  return jsonResponse({ error: { code, message } }, status);
}

// Stripe's API is application/x-www-form-urlencoded with bracket notation
// for nested objects/arrays - there is no JSON body option.
function toStripeForm(obj, prefix = "") {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          parts.push(toStripeForm(item, `${paramKey}[${i}]`));
        } else {
          parts.push(`${encodeURIComponent(`${paramKey}[${i}]`)}=${encodeURIComponent(item)}`);
        }
      });
    } else if (typeof value === "object") {
      parts.push(toStripeForm(value, paramKey));
    } else {
      parts.push(`${encodeURIComponent(paramKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

async function stripeRequest(env, method, path, body) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? toStripeForm(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error?.message || `Stripe ${path} failed with ${res.status}`);
    err.stripeError = data.error;
    throw err;
  }
  return data;
}

async function hmacSha256Hex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Outbound venture-forwarding signature - matches weylandai's real,
// already-deployed createHmacSignature() exactly (base64url, not hex).
// Found the hard way 2026-09-03: a hex/base64url mismatch here silently
// produced a real, live 401 on every forwarded event. Any venture
// registering to receive events must verify against this same encoding.
async function hmacSha256Base64Url(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const binary = String.fromCharCode(...new Uint8Array(sig));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Verifies Stripe's own webhook signature scheme:
// header is "t=<timestamp>,v1=<hex hmac of `${timestamp}.${rawBody}`>"
async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  if (!parts.t || !parts.v1) return false;
  const expected = await hmacSha256Hex(`${parts.t}.${rawBody}`, secret);
  return expected === parts.v1;
}

// mobcoin.cc depth audit, 2026-09-19: real second user for mobcoin.cc's
// internal MobCoin ledger (GET/POST /api/mobcoin/ledger on
// mobley-venture-fleet-a). Its own recorded next_step asked for "another
// venture's own worker actually posting a cross-venture credit note, not
// just this session's own test entry" - every completed Stripe checkout
// that flows through vendyai (i.e. across the whole registered portfolio)
// is a real settlement event: vendyai holds the Stripe payout, the venture
// is owed the net. Recording that here is an honest reflection of
// mobcoin.cc's own stated purpose ("payment infrastructure for the MobCorp
// ecosystem"), driven by real code on a different Worker, not a manual
// entry. Units = net cents settled (falls back to gross if the fee capture
// above failed), clamped to the ledger's own validated 1..1,000,000 bound;
// skipped (logged, not thrown) when out of range or the ledger endpoint is
// unreachable, so a ledger hiccup never blocks the real webhook response.
async function postMobcoinLedgerEntry(ventureId, units, sessionId) {
  if (!Number.isInteger(units) || units < 1 || units > 1000000) {
    console.warn(`[vendyai] skipping mobcoin ledger entry for ${sessionId}: units ${units} out of range`);
    return { posted: false, reason: "units_out_of_range" };
  }
  try {
    const res = await fetch("https://mobcoin.cc/api/mobcoin/ledger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_venture: "vendyai.com",
        to_venture: ventureId,
        units,
        memo: `stripe settlement, checkout session ${sessionId}`,
      }),
    });
    return { posted: res.ok, status: res.status };
  } catch (err) {
    console.error(`[vendyai] mobcoin ledger post failed for ${sessionId}:`, err.message);
    return { posted: false, reason: err.message };
  }
}

// 2026-09-20 depth audit: checkout_sessions has grown to 375 rows across 73
// registered ventures since 2026-09-03, every single one still "open" -
// verified this is expected, not a bug (every row traces to a depth-audit
// session's own live-verification checkout create, never a real completed
// payment; agents correctly never complete a real Stripe charge on their
// own) - but nothing ever pruned them, and Stripe Checkout Sessions
// themselves expire after 24h by default, so any row still "open" past 2
// days is provably dead: Stripe will never send a completed/expired event
// for it. Unbounded growth with no cleanup is a real, if minor, gap - this
// closes it without touching any row that could still transition state.
async function pruneStaleCheckoutSessions(env, olderThanDays = 2) {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const result = await env.DB.prepare(
    "DELETE FROM checkout_sessions WHERE status = 'open' AND created_at < ?"
  ).bind(cutoff).run();
  return { deleted: result.meta?.changes ?? 0, cutoff };
}

// 2026-09-22 depth audit: takes a fully-shaped payload rather than
// building {type, data} itself, so callers can send either the legacy
// v1 (Stripe-shaped) or the v2 (provider-neutral, VENDYAI_PROVIDER_
// ABSTRACTION.md section 3) wire format - the signing/delivery mechanics
// are identical either way, only the JSON shape differs.
async function forwardToVenture(env, ventureId, payload) {
  const registration = await env.DB.prepare(
    "SELECT webhook_url, hmac_secret FROM venture_webhook_endpoints WHERE venture_id = ?"
  ).bind(ventureId).first();
  if (!registration) {
    console.warn(`[vendyai] no webhook registered for venture_id=${ventureId}, skipping forward`);
    return { forwarded: false, reason: "unregistered_venture" };
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify(payload);
  const signedPayload = `${timestamp}.${body}`;
  const signature = await hmacSha256Base64Url(signedPayload, registration.hmac_secret);
  try {
    const res = await fetch(registration.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
        "X-Webhook-Timestamp": timestamp,
      },
      body,
    });
    return { forwarded: true, status: res.status };
  } catch (err) {
    console.error(`[vendyai] forward to ${ventureId} failed:`, err.message);
    return { forwarded: false, reason: err.message };
  }
}

export default {
  // Daily Cloudflare Cron Trigger (see wrangler.toml [triggers]) - real
  // scheduled cleanup, not just a callable-on-demand function nobody calls.
  async scheduled(event, env, ctx) {
    const result = await pruneStaleCheckoutSessions(env);
    console.log(`[vendyai] scheduled prune: deleted ${result.deleted} stale open sessions older than ${result.cutoff}`);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // Admin-triggered on-demand prune, additive to the scheduled cron above -
    // exists so this pass's fix could be live-verified immediately via a real
    // HTTP call instead of waiting up to 24h for the cron to fire.
    if (url.pathname === "/api/admin/prune-stale-sessions" && request.method === "POST") {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return errorResponse("UNAUTHORIZED", "invalid admin secret", 401);
      }
      const result = await pruneStaleCheckoutSessions(env);
      return jsonResponse({ ok: true, ...result });
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ status: "ok", service: "vendyai-com-worker" });
    }

    // Real, live Stripe Checkout Session creation. metadata.venture_id is
    // required so the webhook handler knows which venture to notify later.
    if (url.pathname === "/api/checkout/sessions" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse("INVALID_JSON", "invalid JSON body");
      }
      const { venture_id, mode, customer_email, success_url, cancel_url, line_items, metadata } = body || {};
      if (!venture_id || !success_url || !cancel_url || !Array.isArray(line_items) || line_items.length === 0) {
        return errorResponse("VALIDATION_ERROR", "venture_id, success_url, cancel_url, and a non-empty line_items array are required");
      }
      const registration = await env.DB.prepare(
        "SELECT venture_id FROM venture_webhook_endpoints WHERE venture_id = ?"
      ).bind(venture_id).first();
      if (!registration) {
        return errorResponse("UNKNOWN_VENTURE", `venture_id "${venture_id}" is not registered - see POST /api/ventures/register`, 404);
      }
      try {
        const session = await stripeRequest(env, "POST", "/checkout/sessions", {
          mode: mode || "payment",
          customer_email,
          success_url,
          cancel_url,
          line_items,
          metadata: { ...metadata, venture_id },
        });
        await env.DB.prepare(
          "INSERT INTO checkout_sessions (id, venture_id, stripe_session_id, status, amount_total, currency) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), venture_id, session.id, session.status || "open", session.amount_total ?? null, session.currency ?? null).run();
        return jsonResponse({ session: { id: session.id, url: session.url } }, 201);
      } catch (err) {
        console.error("[vendyai] checkout session creation failed:", err.message);
        return errorResponse("STRIPE_ERROR", err.message, 502);
      }
    }

    // Real entitlement verification, added 2026-09-04: catches a real gap
    // found the same night - checkout sessions were being created and paid
    // for (in principle) but nothing ever checked payment status before
    // granting the "Pro" upgrade on the consuming venture's side. Session
    // IDs are unguessable Stripe-generated randoms, safe to check by ID
    // alone without further auth - this only reveals whether a payment for
    // THAT specific session succeeded, not anyone's broader purchase history.
    if (url.pathname.startsWith("/api/checkout/sessions/") && request.method === "GET") {
      const sessionId = url.pathname.slice("/api/checkout/sessions/".length);
      if (!sessionId) return errorResponse("VALIDATION_ERROR", "session id required", 400);
      // 2026-09-20 depth audit (bloomagi.cc): added created_at to this
      // response. Consumers gating a time-limited pass (e.g. bloomagi.cc's
      // "$4, 30-day Pro pass") had no way to check purchase age server-side -
      // a completed session's `status` never changes, so a single payment
      // granted permanent access forever, contradicting the pass's own
      // description. Purely additive field; existing consumers that only
      // read venture_id/status/amount_total/currency are unaffected.
      const row = await env.DB.prepare(
        "SELECT venture_id, status, amount_total, currency, created_at FROM checkout_sessions WHERE stripe_session_id = ?"
      ).bind(sessionId).first();
      if (!row) return errorResponse("NOT_FOUND", "no such checkout session", 404);
      return jsonResponse({ venture_id: row.venture_id, status: row.status, amount_total: row.amount_total, currency: row.currency, created_at: row.created_at });
    }

    if (url.pathname === "/api/portal/sessions" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse("INVALID_JSON", "invalid JSON body");
      }
      const { customer_id, return_url } = body || {};
      if (!customer_id || !return_url) {
        return errorResponse("VALIDATION_ERROR", "customer_id and return_url are required");
      }
      try {
        const portal = await stripeRequest(env, "POST", "/billing_portal/sessions", {
          customer: customer_id,
          return_url,
        });
        return jsonResponse({ portal: { url: portal.url } });
      } catch (err) {
        console.error("[vendyai] portal session creation failed:", err.message);
        return errorResponse("STRIPE_ERROR", err.message, 502);
      }
    }

    // Real Stripe webhook receiver - verifies Stripe's own signature scheme,
    // then re-signs and forwards to whichever venture owns the session
    // (via metadata.venture_id set at creation time above).
    if (url.pathname === "/api/stripe/webhook" && request.method === "POST") {
      const rawBody = await request.text();
      const signatureHeader = request.headers.get("Stripe-Signature");
      const valid = await verifyStripeSignature(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
      if (!valid) {
        console.warn("[vendyai] rejected webhook with invalid Stripe signature");
        return errorResponse("INVALID_SIGNATURE", "signature verification failed", 401);
      }
      const event = JSON.parse(rawBody);
      const session = event.data?.object || {};
      const ventureId = session.metadata?.venture_id;

      if (event.type === "checkout.session.completed" && ventureId) {
        const sessionRow = await env.DB.prepare(
          "UPDATE checkout_sessions SET status = 'completed', stripe_customer_id = ? WHERE stripe_session_id = ? RETURNING api_version"
        ).bind(session.customer || null, session.id).first();
        const apiVersion = sessionRow?.api_version || "v1";

        // Real fee pass-through: pull Stripe's own balance_transaction for
        // this charge rather than assuming a flat rate. That's the actual
        // amount Stripe kept - the venture's net is gross minus this real
        // number, not gross minus an estimate.
        let feeCents = null;
        let netCents = null;
        try {
          const full = await stripeRequest(
            env,
            "GET",
            `/checkout/sessions/${session.id}?expand[]=payment_intent.latest_charge.balance_transaction`
          );
          const balanceTxn = full.payment_intent?.latest_charge?.balance_transaction;
          if (balanceTxn) {
            feeCents = balanceTxn.fee;
            netCents = balanceTxn.net;
            await env.DB.prepare(
              "UPDATE checkout_sessions SET stripe_fee_cents = ?, net_to_venture_cents = ?, fee_captured_at = datetime('now') WHERE stripe_session_id = ?"
            ).bind(feeCents, netCents, session.id).run();
          }
        } catch (err) {
          console.error("[vendyai] fee capture failed for", session.id, ":", err.message);
        }

        // 2026-09-22 depth audit: closes VENDYAI_PROVIDER_ABSTRACTION.md
        // section 3, the one piece of the provider-abstraction design left
        // unbuilt after 2026-09-18's catalog/v2-checkout work. Gated on the
        // session's own api_version (set at creation time by which checkout
        // endpoint made it - v1 /api/checkout/sessions vs v2 /api/v2/
        // checkout/sessions), so weylandai - the only real consumer today,
        // still exclusively on v1 - gets byte-for-byte the same Stripe-
        // shaped forward it always has. A venture created via v2 gets the
        // provider-neutral shape from the design doc instead; no consumer
        // has to opt in or change code for this to be correct, since which
        // shape they get is fully determined by which checkout API they
        // already called.
        const forwardPayload = apiVersion === "v2"
          ? {
              event: "payment.completed",
              venture_id: ventureId,
              external_reference: session.id,
              customer: {
                ref: session.customer || null,
                email: session.customer_details?.email || null,
                name: session.customer_details?.name || null,
              },
              amount_total_cents: session.amount_total,
              currency: session.currency,
              provider_fee_cents: feeCents,
              net_cents: netCents,
              metadata: session.metadata || {},
              occurred_at: new Date().toISOString(),
            }
          : {
              // Legacy v1 shape - field names deliberately mirror Stripe's
              // own checkout.session object (id, customer, mode,
              // customer_details) so weylandai's existing webhook handler
              // needs zero changes. Unchanged from before this pass.
              type: "checkout.session.completed",
              data: {
                id: session.id,
                mode: session.mode,
                metadata: session.metadata,
                customer: session.customer,
                customer_details: session.customer_details || null,
                amount_total: session.amount_total,
                currency: session.currency,
                stripe_fee_cents: feeCents,
                net_to_venture_cents: netCents,
              },
            };
        const forward = await forwardToVenture(env, ventureId, forwardPayload);
        const ledgerUnits = netCents ?? session.amount_total ?? null;
        const mobcoinLedger = ledgerUnits != null
          ? await postMobcoinLedgerEntry(ventureId, ledgerUnits, session.id)
          : { posted: false, reason: "no_amount" };
        return jsonResponse({ received: true, forwarded: forward, stripe_fee_cents: feeCents, net_to_venture_cents: netCents, mobcoin_ledger: mobcoinLedger });
      }

      return jsonResponse({ received: true, forwarded: false, reason: "unhandled_event_type_or_missing_venture_id" });
    }

    // Minimal admin registration - shared-secret protected, not full auth,
    // since the only real registrant so far is weylandai (added below via
    // direct D1 insert). A real auth model belongs here once there's a
    // second self-service registrant.
    if (url.pathname === "/api/ventures/register" && request.method === "POST") {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return errorResponse("UNAUTHORIZED", "invalid admin secret", 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse("INVALID_JSON", "invalid JSON body");
      }
      const { venture_id, webhook_url, hmac_secret } = body || {};
      if (!venture_id || !webhook_url || !hmac_secret) {
        return errorResponse("VALIDATION_ERROR", "venture_id, webhook_url, and hmac_secret are required");
      }
      await env.DB.prepare(
        "INSERT INTO venture_webhook_endpoints (venture_id, webhook_url, hmac_secret) VALUES (?, ?, ?) ON CONFLICT(venture_id) DO UPDATE SET webhook_url = excluded.webhook_url, hmac_secret = excluded.hmac_secret"
      ).bind(venture_id, webhook_url, hmac_secret).run();
      return jsonResponse({ ok: true, venture_id }, 201);
    }

    // Real first increment of VENDYAI_PROVIDER_ABSTRACTION.md's migration
    // plan: a VendyAI-owned product catalog. A venture registers a product
    // once and gets back a provider-neutral price_ref (vpr_...) instead of
    // ever seeing a Stripe price id. Internally this still creates a real
    // Stripe Product+Price (today's only provider) - the provider-interface
    // refactor itself (swappable implementations behind one interface) is
    // not built in this pass, only made possible without a rewrite later,
    // per that document's own stated scope.
    if (url.pathname === "/api/v2/products" && request.method === "POST") {
      const adminSecret = request.headers.get("X-Admin-Secret");
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return errorResponse("UNAUTHORIZED", "invalid admin secret", 401);
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse("INVALID_JSON", "invalid JSON body");
      }
      const { venture_id, name, description, unit_amount_cents, currency, recurring_interval, provider_price_id } = body || {};
      if (!venture_id || !name) {
        return errorResponse("VALIDATION_ERROR", "venture_id and name are required");
      }
      if (!provider_price_id && (!Number.isInteger(unit_amount_cents) || unit_amount_cents <= 0)) {
        return errorResponse("VALIDATION_ERROR", "a positive integer unit_amount_cents is required unless provider_price_id references an existing price");
      }
      const registration = await env.DB.prepare(
        "SELECT venture_id FROM venture_webhook_endpoints WHERE venture_id = ?"
      ).bind(venture_id).first();
      if (!registration) {
        return errorResponse("UNKNOWN_VENTURE", `venture_id "${venture_id}" is not registered - see POST /api/ventures/register`, 404);
      }
      try {
        let resolvedPriceId, resolvedAmount, resolvedCurrency, resolvedRecurring;
        if (provider_price_id) {
          // Migration path for a product that predates this catalog: reuse
          // an already-live Stripe price instead of minting a duplicate
          // Product+Price for something that already exists (found
          // 2026-09-15 - the create-only path below made it impossible to
          // bring any pre-existing live product into the v2 catalog without
          // duplicating it in Stripe, which blocked the one real migration
          // this catalog was built for - see VENDYAI_PROVIDER_ABSTRACTION.md
          // step 2 / this venture's own recorded next_step). Fields are read
          // back from Stripe's own price object, not trusted from the
          // request body, so the catalog can't drift from the real price.
          const price = await stripeRequest(env, "GET", `/prices/${provider_price_id}`);
          if (!price.active) {
            return errorResponse("INACTIVE_PRICE", `provider_price_id "${provider_price_id}" is not an active Stripe price`, 400);
          }
          resolvedPriceId = price.id;
          resolvedAmount = price.unit_amount;
          resolvedCurrency = price.currency;
          resolvedRecurring = price.recurring?.interval || null;
        } else {
          const cur = (currency || "usd").toLowerCase();
          const product = await stripeRequest(env, "POST", "/products", { name, description: description || undefined });
          const priceBody = {
            product: product.id,
            unit_amount: unit_amount_cents,
            currency: cur,
          };
          if (recurring_interval) priceBody.recurring = { interval: recurring_interval };
          const price = await stripeRequest(env, "POST", "/prices", priceBody);
          resolvedPriceId = price.id;
          resolvedAmount = unit_amount_cents;
          resolvedCurrency = cur;
          resolvedRecurring = recurring_interval || null;
        }
        const priceRef = `vpr_${crypto.randomUUID().replace(/-/g, "")}`;
        await env.DB.prepare(
          "INSERT INTO products (id, venture_id, name, description, unit_amount_cents, currency, recurring_interval, provider_price_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(priceRef, venture_id, name, description || null, resolvedAmount, resolvedCurrency, resolvedRecurring, resolvedPriceId).run();
        return jsonResponse({ product: { price_ref: priceRef, venture_id, name, unit_amount_cents: resolvedAmount, currency: resolvedCurrency, recurring_interval: resolvedRecurring } }, 201);
      } catch (err) {
        console.error("[vendyai] product registration failed:", err.message);
        return errorResponse("STRIPE_ERROR", err.message, 502);
      }
    }

    // Lists a venture's own active catalog - a venture only ever needs to
    // know its own price_refs, never another venture's.
    if (url.pathname === "/api/v2/products" && request.method === "GET") {
      const ventureId = url.searchParams.get("venture_id");
      if (!ventureId) return errorResponse("VALIDATION_ERROR", "venture_id query param is required", 400);
      const rows = await env.DB.prepare(
        "SELECT id AS price_ref, name, description, unit_amount_cents, currency, recurring_interval FROM products WHERE venture_id = ? AND active = 1 ORDER BY created_at DESC"
      ).bind(ventureId).all();
      return jsonResponse({ products: rows.results || [] });
    }

    // Provider-neutral checkout creation: callers pass price_refs
    // (vpr_...), never a Stripe price id - the actual requirement named in
    // VENDYAI_PROVIDER_ABSTRACTION.md ("consuming ventures should never be
    // able to tell Stripe is what it depends on internally"). Additive
    // alongside /api/checkout/sessions (unchanged, still real, still what
    // weylandai's live integration uses today) - no existing consumer is
    // touched by this route existing.
    if (url.pathname === "/api/v2/checkout/sessions" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return errorResponse("INVALID_JSON", "invalid JSON body");
      }
      const { venture_id, mode, customer_email, success_url, cancel_url, price_refs, metadata } = body || {};
      if (!venture_id || !success_url || !cancel_url || !Array.isArray(price_refs) || price_refs.length === 0) {
        return errorResponse("VALIDATION_ERROR", "venture_id, success_url, cancel_url, and a non-empty price_refs array are required");
      }
      const registration = await env.DB.prepare(
        "SELECT venture_id FROM venture_webhook_endpoints WHERE venture_id = ?"
      ).bind(venture_id).first();
      if (!registration) {
        return errorResponse("UNKNOWN_VENTURE", `venture_id "${venture_id}" is not registered - see POST /api/ventures/register`, 404);
      }

      const lineItems = [];
      for (const ref of price_refs) {
        const priceRef = ref?.price_ref;
        const quantity = Number.isInteger(ref?.quantity) && ref.quantity > 0 ? ref.quantity : 1;
        if (!priceRef) {
          return errorResponse("VALIDATION_ERROR", "each price_refs entry needs a price_ref", 400);
        }
        const product = await env.DB.prepare(
          "SELECT provider_price_id FROM products WHERE id = ? AND venture_id = ? AND active = 1"
        ).bind(priceRef, venture_id).first();
        if (!product) {
          return errorResponse("UNKNOWN_PRICE_REF", `price_ref "${priceRef}" is not a registered, active product for venture_id "${venture_id}"`, 404);
        }
        lineItems.push({ price: product.provider_price_id, quantity });
      }

      try {
        const session = await stripeRequest(env, "POST", "/checkout/sessions", {
          mode: mode || "payment",
          customer_email,
          success_url,
          cancel_url,
          line_items: lineItems,
          metadata: { ...metadata, venture_id },
        });
        await env.DB.prepare(
          "INSERT INTO checkout_sessions (id, venture_id, stripe_session_id, status, amount_total, currency, api_version) VALUES (?, ?, ?, ?, ?, ?, 'v2')"
        ).bind(crypto.randomUUID(), venture_id, session.id, session.status || "open", session.amount_total ?? null, session.currency ?? null).run();
        return jsonResponse({ session: { id: session.id, url: session.url } }, 201);
      } catch (err) {
        console.error("[vendyai] v2 checkout session creation failed:", err.message);
        return errorResponse("STRIPE_ERROR", err.message, 502);
      }
    }

    if (url.pathname === "/" && request.method === "GET") {
      let ventureCount = null;
      try {
        const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM venture_webhook_endpoints").first();
        ventureCount = row?.n ?? null;
      } catch { /* count is a nice-to-have, not required for the page to render */ }
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>vendyai.com</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:80px auto;padding:0 24px;color:#1a1a1a;line-height:1.6}
h1{font-size:1.5rem;margin-bottom:4px}
.sub{color:#666;font-size:.95rem;margin-bottom:32px}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-size:.85em}
.stat{font-size:.9rem;color:#444;margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5}
</style></head>
<body>
<h1>vendyai.com</h1>
<p class="sub">Shared Stripe checkout infrastructure for the MobCorp venture portfolio.</p>
<p>This is a real, live-mode payment API - not a consumer product. Ventures register here once (<code>POST /api/ventures/register</code>) and then create real Stripe Checkout sessions (<code>POST /api/checkout/sessions</code>) without each needing its own direct Stripe integration.</p>
<p class="stat">${ventureCount !== null ? `${ventureCount} ventures registered.` : ""} Health check: <a href="/health">/health</a></p>
</body></html>`;
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return errorResponse("NOT_FOUND", "no route for this path", 404);
  },
};
