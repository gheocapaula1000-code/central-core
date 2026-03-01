import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, Lock, Globe } from "lucide-react";

const steps = [
  "Genera AI_CORE_SECRET nelle env var del Core su Supabase",
  "Nella nuova PWA, configura CENTRAL_CORE_BASE_URL e AI_CORE_SECRET",
  "La PWA chiama il Core via core-proxy che inietta gli header di sicurezza",
  "Aggiungi il domain della PWA in PIPELINES se servono config custom",
];

const headers = ["x-internal-secret", "x-app-secret", "x-core-secret", "Authorization Bearer"];

const origins = [".lovable.app", ".lovableproject.com", ".lovable.dev", "localhost"];

export default function SecurityPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Chiavi & Sicurezza</h1>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" /> Come collegare una nuova PWA
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm">
                <span className="flex items-center justify-center h-6 w-6 rounded-full bg-violet-500/20 text-violet-400 text-xs font-bold shrink-0">
                  {i + 1}
                </span>
                <span className="text-muted-foreground">{step}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" /> Header di Sicurezza Accettati
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {headers.map((h) => (
              <span key={h} className="font-mono text-xs bg-secondary px-2.5 py-1 rounded">{h}</span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" /> Origini Consentite
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Configurabili tramite <span className="font-mono text-xs">CORE_ALLOWED_ORIGINS</span>. Per default accettati:
          </p>
          <div className="flex flex-wrap gap-2">
            {origins.map((o) => (
              <span key={o} className="font-mono text-xs bg-secondary px-2.5 py-1 rounded">{o}</span>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
