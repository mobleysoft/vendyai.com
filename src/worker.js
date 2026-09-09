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

async function forwardToVenture(env, ventureId, eventType, data) {
  const registration = await env.DB.prepare(
    "SELECT webhook_url, hmac_secret FROM venture_webhook_endpoints WHERE venture_id = ?"
  ).bind(ventureId).first();
  if (!registration) {
    console.warn(`[vendyai] no webhook registered for venture_id=${ventureId}, skipping forward`);
    return { forwarded: false, reason: "unregistered_venture" };
  }
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ type: eventType, data });
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
  async fetch(request, env) {
    const url = new URL(request.url);

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
      const row = await env.DB.prepare(
        "SELECT venture_id, status, amount_total, currency FROM checkout_sessions WHERE stripe_session_id = ?"
      ).bind(sessionId).first();
      if (!row) return errorResponse("NOT_FOUND", "no such checkout session", 404);
      return jsonResponse({ venture_id: row.venture_id, status: row.status, amount_total: row.amount_total, currency: row.currency });
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
        await env.DB.prepare(
          "UPDATE checkout_sessions SET status = 'completed', stripe_customer_id = ? WHERE stripe_session_id = ?"
        ).bind(session.customer || null, session.id).run();

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

        // Field names deliberately mirror Stripe's own checkout.session
        // object for now (id, customer, mode, customer_details) so existing
        // consumers (weylandai's webhook handler) need minimal changes to
        // read this. This is a real, acknowledged debt: a provider-neutral
        // wire format for this forward is the actual target (see
        // VENDYAI_PROVIDER_ABSTRACTION.md) - deferred, not solved here,
        // since redesigning the contract for all registered ventures is a
        // bigger, separate change from making the flow work correctly.
        const forward = await forwardToVenture(env, ventureId, "checkout.session.completed", {
          id: session.id,
          mode: session.mode,
          metadata: session.metadata,
          customer: session.customer,
          // Stripe includes customer_details (email/name/address) directly
          // on checkout.session.completed by default, no expansion needed -
          // forwarded here so every consuming venture doesn't have to make
          // its own extra Stripe API call just to learn who paid.
          customer_details: session.customer_details || null,
          amount_total: session.amount_total,
          currency: session.currency,
          stripe_fee_cents: feeCents,
          net_to_venture_cents: netCents,
        });
        return jsonResponse({ received: true, forwarded: forward, stripe_fee_cents: feeCents, net_to_venture_cents: netCents });
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
