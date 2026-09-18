# VendyAI as a payment-provider abstraction, not a Stripe passthrough

**Status:** Design document. Not yet implemented — today's real, live `src/worker.js` is a Stripe passthrough with Stripe's own shapes leaking directly into both the request contract (ventures pass raw Stripe `line_items` with Stripe price IDs) and the webhook forward contract (mirrors Stripe's `checkout.session.completed` object field-for-field, by explicit, acknowledged choice — see the comment in `forwardToVenture`'s call site as of 2026-09-09). This document is the target this debt is measured against, not a claim that it's already true.

## The actual requirement

Direct instruction: vendyai.com should not just be Stripe integration-as-a-service for the conglomerate — it should be a real payment-provider abstraction. Consuming ventures should never be able to tell Stripe is what it depends on internally. The internal provider must be swappable at will, without any consuming venture changing code, until VendyAI can eventually become its own provider.

This is the same principle already established for identity (AuthFor) applied to payments: a venture depending on a shared platform's *capability* (checkout, subscriptions, portal access) is correct; a venture depending on that platform's *chosen implementation detail* (Stripe specifically) is a leak that defeats the point of centralizing in the first place.

## Where Stripe currently leaks through the contract

1. **Checkout creation request shape**: `POST /api/checkout/sessions` takes a raw `line_items` array with Stripe `price` IDs (e.g. `{ price: "price_1AbC...", quantity: 3 }`) — a caller has to know Stripe's price-object model to use this API at all. weylandai.com's real integration passes its own `WEYLAND_PRODUCTS[...].priceId` directly through, unchanged.
2. **Webhook forward shape**: `forwardToVenture()` sends `{ type: "checkout.session.completed", data: { id, customer, mode, customer_details, metadata, amount_total, currency, ... } }` — field names deliberately chosen to mirror Stripe's own session object (a real, intentional choice made 2026-09-09 to keep the just-fixed end-to-end flow small and correct without also redesigning the contract in the same pass — see the code comment at that call site). A consuming venture's webhook handler is directly coupled to Stripe's object shape today.
3. **Fee/net accounting language**: `stripe_fee_cents`/`net_to_venture_cents` names the provider directly in a field a consuming venture stores and reasons about.

## Target design

### 1. A real product/price catalog owned by VendyAI

Ventures register *products* with VendyAI (name, description, recurring/one-time, unit amount, currency) and get back a VendyAI-native price reference (`vpr_...`). Checkout creation takes `{ venture_id, price_refs: [{ price_ref: "vpr_...", quantity }], ... }` — never a provider-specific price ID. VendyAI's own D1 maps `vpr_...` → whatever the live provider's real price/product ID is internally. Swapping providers means re-creating provider-side prices and updating this mapping table — zero consuming-venture changes.

### 2. A provider interface, not a Stripe-shaped set of functions

Internally, `stripeRequest()` and the ad hoc Stripe-shaped logic scattered through the route handlers become one implementation of a generic interface:

```
createCheckoutSession({ price_refs, mode, customer_email, success_url, cancel_url, metadata }) -> { id, url }
createPortalSession({ customer_ref, return_url }) -> { url }
verifyWebhookSignature(rawBody, headers) -> boolean
parseWebhookEvent(rawBody) -> { type, provider_event_id, session: { id, customer_ref, customer_email, customer_name, amount_total_cents, currency, metadata } }
```

Route handlers call this interface, never `fetch("https://api.stripe.com/...")` directly. A future second implementation (a different processor, or VendyAI's own native rails) is a new file implementing the same interface, selected by config — not a rewrite of every route.

### 3. A provider-neutral webhook forward shape

`forwardToVenture()` sends VendyAI's own event schema, not Stripe's:

```json
{
  "event": "payment.completed",
  "venture_id": "weylandai",
  "external_reference": "vpay_...",
  "customer": { "ref": "vcus_...", "email": "...", "name": "..." },
  "amount_total_cents": 19900,
  "currency": "usd",
  "provider_fee_cents": 607,
  "net_cents": 19293,
  "metadata": { "product_id": "weyland_subconp", "seats": "3" },
  "occurred_at": "2026-09-09T12:00:00Z"
}
```

No field name here implies a specific provider. `external_reference`/`customer.ref` are VendyAI-issued opaque identifiers, not passed-through provider IDs.

## Migration plan (compat, not a hard break)

weylandai.com and any other already-registered venture depend on today's Stripe-shaped contract *right now* — the fix landed 2026-09-09 makes that contract actually work end to end for the first time. A hard contract change would break that immediately. Real sequencing:

1. Build the product/price catalog and the provider-interface refactor as **additive** — new `/api/v2/checkout/sessions` (neutral shape) alongside the existing `/api/checkout/sessions` (Stripe-shaped, unchanged, still real). Same for a v2 webhook forward format, opt-in per venture via their registration record.
2. Migrate weylandai.com (the one real, exercised consumer) to v2 first, verified the same way the v1 fix was — real signature round-trip, real shape checks, before any production traffic depends on it.
3. Deprecate v1 only once there are zero real consumers left on it. Do not remove it preemptively.

## What this document does not yet resolve

- Whether VendyAI ever actually becomes its own payment provider (explicitly out of scope — "until we can properly become our own provider" names this as a future possibility, not a current commitment) — this design only needs to make that switch *possible later without a rewrite*, not build it now.
- **CORRECTED 2026-09-18**: section 1 (product/price catalog) and the checkout-creation half of section 2 ARE built and live - real `POST`/`GET /api/v2/products` and `POST /api/v2/checkout/sessions` (price_ref-based, provider-neutral request shape) exist in `src/worker.js`, previously smoke-tested (a real `weylandai` test product, `price_ref vpr_b9224f87788d419f80fe9d6c18970bcf`, still registered). What's still genuinely true: section 3 (the provider-neutral webhook-forward shape) is NOT built - `forwardToVenture()` still always emits the old Stripe-shaped payload regardless of which checkout API created the session. And migration plan step 2 (migrate weylandai.com) has NOT happened - its real production billing code (`src/routes/billing.js`, `weyland.worker.js`) still calls the v1 endpoint exclusively, checked directly, no v2 call site exists yet.
- Exact schema for the product/price catalog tables — real implementation detail for whoever builds section 1, not decided here.
