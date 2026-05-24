import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { APP_REGISTRY } from "@/lib/constants";

export default function AppsPage() {
  const active = APP_REGISTRY.filter((a) => a.lifecycle === "attiva" || a.lifecycle === "principale");
  const archived = APP_REGISTRY.filter((a) => a.lifecycle !== "attiva" && a.lifecycle !== "principale");

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">App Collegate</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Prodotti attivi e archivio progetti legacy o sperimentali.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          PWA Collegate · Attive
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {active.map((app) => {
            const a = app as typeof app & { coreEndpoint?: string; diagnosticsPath?: string; previewUrl?: string };
            return (
              <Card key={app.id} className="border-violet-900/40">
                <CardHeader className="flex flex-row items-start gap-3 pb-3">
                  <span className="text-3xl">{app.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-lg">{app.name}</CardTitle>
                      <Badge className="bg-violet-900/40 text-violet-200 border-violet-700">Attiva</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{app.description}</p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Dominio</span>
                    <div className="flex gap-1.5 flex-wrap justify-end">
                      {app.domains.map((d) => (
                        <span key={d} className="font-mono text-xs bg-secondary px-2 py-0.5 rounded">{d}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Stato</span>
                    <span className="text-emerald-400">connected</span>
                  </div>
                  <div className="pt-3 border-t border-border flex flex-col gap-2">
                    {a.previewUrl && (
                      <a href={a.previewUrl} target="_blank" rel="noopener noreferrer">
                        <Button variant="secondary" size="sm" className="w-full">Apri app</Button>
                      </a>
                    )}
                    {a.diagnosticsPath && (
                      <Link to={a.diagnosticsPath}>
                        <Button variant="outline" size="sm" className="w-full">Diagnostica</Button>
                      </Link>
                    )}
                    {a.coreEndpoint && (
                      <p className="text-[11px] font-mono text-muted-foreground text-center truncate" title={a.coreEndpoint}>
                        {a.coreEndpoint}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-xs font-semibold text-muted-foreground/70 uppercase tracking-wider">
          Archivio / Legacy
        </h2>
        <p className="text-xs text-muted-foreground/70">
          Progetti incompleti, sperimentali o sostituiti. Mantenuti per continuità ma non in produzione.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {archived.map((app) => (
            <Card key={app.id} className="opacity-70 bg-card/50">
              <CardHeader className="flex flex-row items-start gap-2 pb-2 p-4">
                <span className="text-xl opacity-80">{app.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <CardTitle className="text-sm">{app.name}</CardTitle>
                    <Badge variant="outline" className="bg-muted text-muted-foreground border-border text-[10px] py-0">
                      Archivio
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{app.description}</p>
                </div>
              </CardHeader>
              <CardContent className="px-4 pb-3 pt-0 text-xs text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span>{app.platform}</span>
                  <span className="font-mono">{app.domains[0]}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
