-- Adds real Stripe fee pass-through tracking to checkout_sessions.
-- stripe_fee_cents / net_to_venture_cents are populated from Stripe's own
-- balance_transaction on the completed charge (real number, not an assumed
-- flat rate) once the webhook handler captures it.
ALTER TABLE checkout_sessions ADD COLUMN stripe_fee_cents INTEGER;
ALTER TABLE checkout_sessions ADD COLUMN net_to_venture_cents INTEGER;
ALTER TABLE checkout_sessions ADD COLUMN fee_captured_at TEXT;
