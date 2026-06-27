// Temporary selftest: signs HMAC and calls civiko-one-signals-feed
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async () => {
  const SECRET = Deno.env.get("CORE_SHARED_SECRET") || "";
  if (!SECRET) return new Response(JSON.stringify({ok:false,err:"NO_SECRET"}), {status:500});
  const url = "https://jpunnzgixcghuydstdlt.supabase.co/functions/v1/civiko-one-signals-feed";
  const body = JSON.stringify({ city:"Padova", province:"PD", zone_mode:"omi_microzone", limit:250, include:["contendibili","ribassi","privati","off_market"]});
  const ts = String(Date.now());
  const tenant = "selftest";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), {name:"HMAC", hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ts+tenant+body));
  const sigHex = Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,"0")).join("");
  const r = await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-source-app":"civiko-one","x-tenant-id":tenant,"x-timestamp":ts,"x-core-signature":sigHex},body});
  const j = await r.json();
  const items = j.items || [];
  const conts = items.filter((i:any)=>i.signal_type==="contendibile").slice(0,5).map((i:any)=>({title:i.title,zone:i.display_zone,price_label:i.price_label,score:i.score}));
  const priceSamples = items.slice(0,5).map((i:any)=>({t:i.signal_type,price:i.price,price_label:i.price_label,flags:i.data_quality?.flags}));
  const unresolved = items.filter((i:any)=>i.zone_code==="UNRESOLVED_ZONE").length;
  return new Response(JSON.stringify({
    http_status: r.status,
    ok: j.ok,
    schema_version: j.schema_version,
    summary: j.summary,
    items_length: items.length,
    first_5_contendibili: conts,
    first_5_price_samples: priceSamples,
    unresolved_zone_items: unresolved,
  }, null, 2), {headers:{"content-type":"application/json"}});
});
