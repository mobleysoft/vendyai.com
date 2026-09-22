// Minimal, real-enough in-memory D1 fake for vendyai.com's schema
// (venture_webhook_endpoints, checkout_sessions, products) - same pattern
// as salesfactorai.com/test/fake-d1.mjs. Implements each real SQL
// statement's actual behavior in JS rather than stubbing return values.

export function fakeD1() {
  const ventures = [];
  const sessions = [];
  const products = [];

  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (sql.startsWith("INSERT INTO venture_webhook_endpoints")) {
                const [venture_id, webhook_url, hmac_secret] = args;
                const existing = ventures.find((v) => v.venture_id === venture_id);
                if (existing) Object.assign(existing, { webhook_url, hmac_secret });
                else ventures.push({ venture_id, webhook_url, hmac_secret });
              } else if (sql.startsWith("INSERT INTO checkout_sessions") && sql.includes("api_version) VALUES (?, ?, ?, ?, ?, ?, 'v2')")) {
                const [id, venture_id, stripe_session_id, status, amount_total, currency] = args;
                sessions.push({ id, venture_id, stripe_session_id, status, amount_total, currency, api_version: "v2" });
              } else if (sql.startsWith("INSERT INTO checkout_sessions")) {
                const [id, venture_id, stripe_session_id, status, amount_total, currency] = args;
                sessions.push({ id, venture_id, stripe_session_id, status, amount_total, currency, api_version: "v1" });
              } else if (sql.startsWith("UPDATE checkout_sessions SET status = 'completed'")) {
                const [stripe_customer_id, stripe_session_id] = args;
                const row = sessions.find((s) => s.stripe_session_id === stripe_session_id);
                if (row) Object.assign(row, { status: "completed", stripe_customer_id });
              } else if (sql.startsWith("UPDATE checkout_sessions SET stripe_fee_cents")) {
                const [stripe_fee_cents, net_to_venture_cents, stripe_session_id] = args;
                const row = sessions.find((s) => s.stripe_session_id === stripe_session_id);
                if (row) Object.assign(row, { stripe_fee_cents, net_to_venture_cents });
              } else if (sql.startsWith("INSERT INTO products")) {
                const [id, venture_id, name, description, unit_amount_cents, currency, recurring_interval, provider_price_id] = args;
                products.push({ id, venture_id, name, description, unit_amount_cents, currency, recurring_interval, provider_price_id, active: 1 });
              } else if (sql.startsWith("DELETE FROM checkout_sessions WHERE status = 'open'")) {
                const [cutoff] = args;
                const before = sessions.length;
                for (let i = sessions.length - 1; i >= 0; i--) {
                  if (sessions[i].status === "open" && (sessions[i].created_at || "") < cutoff) sessions.splice(i, 1);
                }
                return { success: true, meta: { changes: before - sessions.length } };
              }
              return { success: true, meta: { changes: 0 } };
            },
            async first() {
              if (sql.startsWith("SELECT venture_id FROM venture_webhook_endpoints")) {
                const v = ventures.find((v) => v.venture_id === args[0]);
                return v ? { venture_id: v.venture_id } : null;
              }
              if (sql.startsWith("SELECT webhook_url, hmac_secret FROM venture_webhook_endpoints")) {
                const v = ventures.find((v) => v.venture_id === args[0]);
                return v ? { webhook_url: v.webhook_url, hmac_secret: v.hmac_secret } : null;
              }
              if (sql.startsWith("SELECT venture_id, status, amount_total, currency FROM checkout_sessions")) {
                const s = sessions.find((s) => s.stripe_session_id === args[0]);
                return s ? { venture_id: s.venture_id, status: s.status, amount_total: s.amount_total, currency: s.currency } : null;
              }
              if (sql.startsWith("UPDATE checkout_sessions SET status = 'completed'")) {
                const [stripe_customer_id, stripe_session_id] = args;
                const row = sessions.find((s) => s.stripe_session_id === stripe_session_id);
                if (!row) return null;
                Object.assign(row, { status: "completed", stripe_customer_id });
                return { api_version: row.api_version || "v1" };
              }
              if (sql.startsWith("SELECT provider_price_id FROM products")) {
                const [priceRef, ventureId] = args;
                const p = products.find((p) => p.id === priceRef && p.venture_id === ventureId && p.active === 1);
                return p ? { provider_price_id: p.provider_price_id } : null;
              }
              if (sql.startsWith("SELECT COUNT(*) AS n FROM venture_webhook_endpoints")) {
                return { n: ventures.length };
              }
              return null;
            },
            async all() {
              if (sql.startsWith("SELECT id AS price_ref")) {
                const ventureId = args[0];
                return {
                  results: products
                    .filter((p) => p.venture_id === ventureId && p.active === 1)
                    .map((p) => ({
                      price_ref: p.id,
                      name: p.name,
                      description: p.description,
                      unit_amount_cents: p.unit_amount_cents,
                      currency: p.currency,
                      recurring_interval: p.recurring_interval,
                    })),
                };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };

  return { db, ventures, sessions, products };
}
