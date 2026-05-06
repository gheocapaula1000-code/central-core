import { useState } from "react";
import { Smartphone, Bot, ClipboardList, Activity, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APP_REGISTRY, TASK_REGISTRY, PROVIDERS } from "@/lib/constants";

const stats = [
  {
    label: "App Collegate",
    value: APP_REGISTRY.length.toString(),
    icon: Smartphone,
  },
  {
    label: "Providers Configurati",
    value: `${PROVIDERS.length}`,
    icon: Bot,
  },
  {
    label: "Task Registrati",
    value: TASK_REGISTRY.length.toString(),
    icon: ClipboardList,
  },
  {
    label: "Chiamate Oggi",
    value: "—",
    icon: Activity,
  },
];

export default function Dashboard() {
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
      <h1 className="text-2xl font-bold">Dashboard</h1>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
              <s.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" /> Attività Recente
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            I log delle chiamate saranno disponibili in un prossimo aggiornamento.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Quick Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            {PROVIDERS.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full bg-muted-foreground" />
                <span>{p.name}</span>
                <span className="text-xs text-muted-foreground">(verificabile da self-test)</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-sm">Job di Sistema</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="password"
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
            <Button size="sm" disabled={!jobSecret || jobLoading} onClick={() => runJob("/jobs/promote-early-signal-candidate", { run_id: "eos-motky4y0", force: true, min_confidence: 0.6 })}>
              Promuovi Candidati Verona
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
