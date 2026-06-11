import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
serve(async () => {
  const sk = Deno.env.get("STRIPE_SECRET_KEY") ?? "";
  const pm = Deno.env.get("STRIPE_PRICE_CIVIKO_MONTHLY") ?? "";
  const py = Deno.env.get("STRIPE_PRICE_CIVIKO_YEARLY") ?? "";
  const out: Record<string, unknown> = {};

  async function run(label: string, priceId: string) {
    const cf = new URLSearchParams({
      email: `diag-${label}@civiko.it`,
      "metadata[supabase_user_id]": "00000000-0000-0000-0000-000000000000",
      "metadata[workspace_id]": "00000000-0000-0000-0000-000000000000",
      "metadata[app]": "civiko-diag",
    });
    const cr = await fetch("https://api.stripe.com/v1/customers", {
      method: "POST",
      headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: cf.toString(),
    });
    const cj = await cr.json();
    const customerId = cj?.id;
    const form = new URLSearchParams({
      mode: "subscription",
      customer: customerId,
      "customer_update[name]": "auto",
      "customer_update[address]": "auto",
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      success_url: "https://civiko-padova.lovable.app/abbonamento/success",
      cancel_url: "https://civiko-padova.lovable.app/abbonamento",
      locale: "it",
      allow_promotion_codes: "true",
      billing_address_collection: "required",
      "tax_id_collection[enabled]": "true",
    });
    const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${sk}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const j = await r.json();
    out[label] = { status: r.status, ok: r.ok, url_present: !!j?.url, error: j?.error ?? null };
    await fetch(`https://api.stripe.com/v1/customers/${customerId}`, { method: "DELETE", headers: { Authorization: `Bearer ${sk}` } });
  }
  await run("monthly", pm);
  await run("yearly", py);
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json" } });
});
