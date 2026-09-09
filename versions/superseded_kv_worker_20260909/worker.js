/**
 * ====================================================================
 * VENDYAI // THE CONGLOMERATE PAYMENT ABSTRACTION LAYER (TIER 2)
 * ====================================================================
 * This Cloudflare Worker acts as the central financial membrane for all
 * MobCorp ventures (LiteraCraft, YutaniAI, Agentzaar, etc.).
 * 
 * By routing all capital capture through this endpoint, no individual
 * venture is hardcoded to a 3rd-party provider (Stripe/Adyen). 
 * When the Conglomerate internalizes the payment stack, this worker 
 * flips the routing logic, and all 120 ventures switch instantly 
 * without deploying a single line of front-end code.
 * ====================================================================
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -------------------------------------------------------------
    // ROUTE: CHECKOUT ABSTRACTION (/checkout/:productId)
    // -------------------------------------------------------------
    if (url.pathname.startsWith("/checkout/")) {
      const productId = url.pathname.split("/")[2];

      const paymentLedger = {
        "lt_sub_999": env.STRIPE_LINK_LITERACRAFT || "https://buy.stripe.com/test_placeholder_lt_999",
        "way_ent_50k": env.STRIPE_LINK_WEYLAND || "https://buy.stripe.com/test_placeholder_way_50k",
        "yut_syn_499": env.STRIPE_LINK_YUTANI || "https://buy.stripe.com/test_placeholder_yut_499"
      };

      const targetGateway = paymentLedger[productId];

      if (targetGateway) {
        return Response.redirect(targetGateway, 302);
      } else {
        // Proxy to local bare-metal uvicorn daemon
        const targetUrl = `${env.MAC_MINI_TUNNEL_URL || "https://core.jmobleyworks.com"}/pay/${productId}`;
        return fetch(targetUrl, { method: "GET" });
      }
    }

    // -------------------------------------------------------------
    // ROUTE: STATIC INDEX (/)
    // -------------------------------------------------------------
    if (url.pathname === "/" && request.method === "GET") {
      const html = await env.VENDYAI_KV.get("static:index") || 
        "<!DOCTYPE html><html><body><h1>Vendyai Sovereign Financial Edge Online</h1></body></html>";
      return new Response(html, {
        headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" }
      });
    }

    // -------------------------------------------------------------
    // ROUTE: API PROXY PASS-THROUGH TO BARE-METAL CORE
    // -------------------------------------------------------------
    if (url.pathname.startsWith("/api/v1/checkout/")) {
      const targetUrl = `${env.MAC_MINI_TUNNEL_URL || "https://core.jmobleyworks.com"}${url.pathname}${url.search}`;
      
      // Clone request to preserve headers/body
      const headers = new Headers(request.headers);
      headers.set("Host", new URL(targetUrl).host);

      return fetch(targetUrl, {
        method: request.method,
        headers: headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : undefined
      });
    }

    // -------------------------------------------------------------
    // ROUTE: BILLING EVENT TRACKING (/api/billing/event)
    // -------------------------------------------------------------
    // Flashed from authfor or other platform assets
    if (url.pathname === "/api/billing/event" && request.method === "POST") {
      try {
        const payload = await request.json();
        const { venture_id, user_id, event, app_id, plan, timestamp } = payload;
        
        if (!venture_id || !user_id) {
          return new Response("Missing venture_id or user_id", { status: 400 });
        }

        const date = new Date(timestamp || Date.now());
        const yyyymm = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        
        const usageKey = `usage:${venture_id}:${user_id}:${yyyymm}`;
        
        // Simple atomic counter increment using KV read-modify-write
        let count = parseInt(await env.VENDYAI_KV.get(usageKey)) || 0;
        await env.VENDYAI_KV.put(usageKey, (count + 1).toString());

        return new Response(JSON.stringify({ status: "recorded", current_usage: count + 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      } catch (e) {
        return new Response("Billing event malformed", { status: 400 });
      }
    }

    // -------------------------------------------------------------
    // ROUTE: WEBHOOK TRANSLATION LAYER (/api/webhook)
    // -------------------------------------------------------------
    // Stripe fires webhooks here. Vendyai translates the Stripe payload 
    // into a standardized MobCorp event and forwards it to the local 
    // bare-metal Cortex (Mac Mini) to trigger the actual JIT generation.
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      try {
        const payload = await request.json();
        
        // In a production environment, verify Stripe signatures here.
        
        // If payment succeeded, translate and forward to the Bare-Metal Cortex
        if (payload.type === "checkout.session.completed") {
            const cortexEndpoint = env.MAC_MINI_TUNNEL_URL || "https://core.jmobleyworks.com";
            
            ctx.waitUntil(
                fetch(`${cortexEndpoint}/vendyai/trigger`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        event: "capital_captured",
                        product: payload.data.object.client_reference_id,
                        customer: payload.data.object.customer_email
                    })
                }).catch(e => console.error("Cortex unreachable:", e))
            );
        }

        return new Response(JSON.stringify({ status: "acknowledged" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
        
      } catch (e) {
        return new Response("Vendyai Webhook Malformed", { status: 400 });
      }
    }

    // Catch-all
    return new Response("Vendyai Sovereign Financial Edge Online.", { status: 200 });
  }
};
