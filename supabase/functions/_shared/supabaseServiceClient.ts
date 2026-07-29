// Client service-role condiviso per le edge function del pilot territoriale.
// Import statico (bundle-friendly): il runtime edge non risolve import remoti
// a runtime, quindi il modulo va importato staticamente qui e caricato dai
// chiamanti con un dynamic import locale (analizzabile dal bundler).
// @ts-ignore: import remoto risolto solo dal runtime Deno, non da tsc.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// deno-lint-ignore no-explicit-any
export function createServiceClient(url: string, key: string): any {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
