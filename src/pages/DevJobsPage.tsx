import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { AlertTriangle } from "lucide-react";

export default function DevJobsPage() {
  const [jobSecret, setJobSecret] = useState("");
  const [jobResult, setJobResult] = useState<string | null>(null);
  const [jobLoading, setJobLoading] = useState(false);

  const runJob = async (jobPath: string, body: object = {}) => {
    setJobLoading(true);
    setJobResult(null);
    try {
      const baseUrl = import.meta.env.VITE_SUPABASE_URL;
      const res = await fetch(`${baseUrl}/functions/v1/civiko-radar-veneto${jobPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-job-secret": jobSecret,
        },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setJobResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setJobResult(String(e));
    } finally {
      setJobLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-sm text-amber-200">
          Pagina riservata sviluppo. Richiede CENTRAL_CORE_JOB_SECRET. Non usare in produzione senza supervisione.
        </p>
      </div>

      <h1 className="text-2xl font-bold">Job di Sistema</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Esecuzione job</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <PasswordInput
            placeholder="Job Secret (CENTRAL_CORE_JOB_SECRET)"
            value={jobSecret}
            onChange={(e) => setJobSecret(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/seed-veneto-comuni")}>
              Seed Comuni Veneto
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/activate-veneto")}>
              Attiva Veneto
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/build-civiko-veneto-data-engine")}>
              Build Data Engine
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/import-veneto-open-data", { dryRun: false, import: true })}>
              Import Open Data
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/list-early-signal-candidates", { limit: 5 })}>
              Diagnosi DB
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/build-agency-offmarket-brief", { province: ["PD"], comuni: ["Padova"], dryRun: false })}>
              Test Brief Padova
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/rescore-early-offmarket-candidates", {})}>
              Rescore Candidati
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/offmarket-padova")}>
              Off-Market Firecrawl Padova
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/build-advanced-veneto-opportunities", { triggered_by: "dev_jobs_ui", import: true, dryRun: false })}>
              Opportunità Urgenti + Motivati
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/discover-early-offmarket-signals", {
              comuni: ["Padova","Vigonza","Selvazzano Dentro","Rubano","Abano Terme","Noventa Padovana","Albignasego","Cadoneghe","Limena","Mestrino","Montegrotto Terme"],
              province: ["PD"],
              maxQueries: 30,
              dryRun: false,
              saveCandidates: true
            })}>
              Scopri Affari Padova (30 query)
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={async () => {
              const ids = [
                "fa6e1602-1ff1-4b6d-adc9-1270b9e20665",
                "f89f7ab5-f977-4301-9ba4-d6349aba0266",
                "6a26522f-7869-4f92-b1a8-b4b6e552a874",
                "d31a61f5-c66d-46ed-bdef-dabca1a787cc",
                "a4882842-4b3d-45e6-92d9-d342a5933add"
              ];
              setJobLoading(true);
              setJobResult(null);
              const results = [];
              for (const id of ids) {
                const baseUrl = import.meta.env.VITE_SUPABASE_URL;
                const res = await fetch(`${baseUrl}/functions/v1/civiko-radar-veneto/jobs/promote-early-signal-candidate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
                  body: JSON.stringify({ candidate_id: id, force: true }),
                });
                const data = await res.json();
                results.push({ id: id.slice(0, 8), ok: data.ok, promoted_to: data.promoted_to });
              }
              setJobResult(JSON.stringify(results, null, 2));
              setJobLoading(false);
            }}>
              Promuovi 5 Candidati
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={async () => {
              const ids = [
                "fa6e1602-1ff1-4b6d-adc9-1270b9e20665",
                "f89f7ab5-f977-4301-9ba4-d6349aba0266",
                "d31a61f5-c66d-46ed-bdef-dabca1a787cc",
              ];
              setJobLoading(true);
              setJobResult(null);
              const results = [];
              for (const id of ids) {
                const baseUrl = import.meta.env.VITE_SUPABASE_URL;
                const res = await fetch(`${baseUrl}/functions/v1/civiko-radar-veneto/jobs/promote-early-signal-candidate`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
                  body: JSON.stringify({ candidate_id: id, force: true, reviewer_note: "Revisione manuale approvata — alienazione comunale Verona", target: "radar_signals" }),
                });
                const data = await res.json();
                results.push({ id: id.slice(0, 8), ok: data.ok, promoted_to: data.promoted_to, error: data.error ?? null });
              }
              setJobResult(JSON.stringify(results, null, 2));
              setJobLoading(false);
            }}>
              Riprova 3 Falliti
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/microzone-padova")}>
              Microzone Padova
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={async () => {
              const comuni = ["Padova","Vigonza","Selvazzano Dentro","Rubano","Abano Terme","Noventa Padovana","Albignasego","Cadoneghe","Limena","Mestrino"];
              setJobLoading(true);
              setJobResult(null);
              const results: Array<{ comune: string; totale: number; ok: boolean }> = [];
              for (const comune of comuni) {
                const baseUrl = import.meta.env.VITE_SUPABASE_URL;
                const res = await fetch(`${baseUrl}/functions/v1/civiko-radar-veneto/jobs/deep-scan-padova`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", "x-job-secret": jobSecret },
                  body: JSON.stringify({ comune }),
                });
                const data = await res.json();
                results.push({ comune, totale: data.totale ?? 0, ok: data.ok });
                setJobResult(JSON.stringify(results, null, 2));
                await new Promise(r => setTimeout(r, 2000));
              }
              setJobLoading(false);
            }}>
              Deep Scan Padova
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/perplexity-deep-padova")}>
              Perplexity Deep Padova
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/discover-early-offmarket-signals", {
              comuni: ["Padova","Vigonza","Selvazzano Dentro","Rubano","Abano Terme","Noventa Padovana","Albignasego","Cadoneghe","Limena","Mestrino","Montegrotto Terme"],
              province: ["PD"],
              maxQueries: 20,
              dryRun: false,
              saveCandidates: true
            })}>
              Scopri Segnali Padova
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/rescore-early-offmarket-candidates", { dryRun: false })}>
              Rescore Candidati
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/promote-batch", { min_priority: 60, reviewer_note: "Approvazione batch Veneto", target: "radar_signals" })}>
              Promuovi Batch Padova
            </Button>
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={async () => {
              setJobLoading(true);
              const baseUrl = import.meta.env.VITE_SUPABASE_URL;
              const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
              const res = await fetch(`${baseUrl}/rest/v1/radar_signals?municipality=ilike.Verona&is_active=eq.true&select=id,municipality,province,signal_type,is_active,fingerprint&limit=10`, {
                headers: {
                  "apikey": anonKey,
                  "Authorization": `Bearer ${anonKey}`,
                }
              });
              const data = await res.json();
              setJobResult(JSON.stringify({ count: Array.isArray(data) ? data.length : 0, rows: data }, null, 2));
              setJobLoading(false);
            }}>
              Leggi radar_signals Verona
            </Button>
          </div>
          {jobLoading && <p className="text-xs text-muted-foreground">In esecuzione...</p>}
          {jobResult && (
            <pre className="overflow-auto max-h-48 rounded-md bg-muted p-3 text-xs">
              {jobResult}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
