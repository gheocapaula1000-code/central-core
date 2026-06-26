Deno.serve(() => {
  return new Response(JSON.stringify({
    FIRECRAWL_API_KEY_present: !!Deno.env.get("FIRECRAWL_API_KEY"),
    FIRECRAWL_API_KEY_len: (Deno.env.get("FIRECRAWL_API_KEY") ?? "").length,
    B2B_FINDER_FIRECRAWL_ENABLED: Deno.env.get("B2B_FINDER_FIRECRAWL_ENABLED") ?? null,
    APIFY_API_TOKEN_present: !!Deno.env.get("APIFY_API_TOKEN"),
    B2B_FINDER_APIFY_ACTOR_ID: Deno.env.get("B2B_FINDER_APIFY_ACTOR_ID") ?? null,
  }), { headers: { "Content-Type": "application/json" } });
});
