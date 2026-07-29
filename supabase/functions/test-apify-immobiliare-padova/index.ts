// Checkpoint 1A — tombstone.
//
// Questo nome di funzione e' permanentemente disattivato.
// Nessuna variabile d'ambiente, nessun client backend, nessuna chiamata di rete,
// nessun accesso al database, nessun payload operativo. Non ricreare qui alcuna
// funzionalita'.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }
  return new Response(
    JSON.stringify({ ok: false, error: { code: "GONE", message: "Endpoint removed" } }),
    { status: 410, headers: { ...CORS, "content-type": "application/json" } },
  );
});
