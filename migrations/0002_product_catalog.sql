-- First real increment of VENDYAI_PROVIDER_ABSTRACTION.md's migration plan
-- ("Build the product/price catalog... as additive"): a VendyAI-owned
-- product/price catalog so ventures can register a product once and get
-- back a provider-neutral price_ref (vpr_...), instead of passing raw
-- Stripe price IDs into checkout. provider_price_id is the only column
-- that names Stripe specifically - swapping providers later means
-- re-creating provider-side prices and updating this column, not touching
-- any consuming venture's code.
CREATE TABLE products (
  id TEXT PRIMARY KEY,              -- vpr_... (VendyAI price ref)
  venture_id TEXT NOT NULL REFERENCES venture_webhook_endpoints(venture_id),
  name TEXT NOT NULL,
  description TEXT,
  unit_amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  recurring_interval TEXT,          -- NULL = one-time, else 'day'|'week'|'month'|'year'
  provider_price_id TEXT NOT NULL,  -- Stripe price id, today's only provider
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tags which API version created a given checkout session, so v1 and v2
-- traffic stay distinguishable during the migration described in
-- VENDYAI_PROVIDER_ABSTRACTION.md's "Migration plan" section. Existing
-- rows predate this column and are real v1 sessions - backfilled
-- explicitly rather than left NULL.
ALTER TABLE checkout_sessions ADD COLUMN api_version TEXT NOT NULL DEFAULT 'v1';
