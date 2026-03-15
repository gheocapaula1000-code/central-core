import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PROVIDERS } from "@/lib/constants";

export default function ProvidersPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Providers AI</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {PROVIDERS.map((p) => (
          <Card key={p.id} className="flex flex-col">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{p.name}</CardTitle>
                <Badge variant="outline" className="bg-secondary text-muted-foreground border-border">
                  Configurato
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex-1 space-y-4 text-sm">
              <div>
                <span className="text-muted-foreground">Modello</span>
                <p className="font-mono mt-0.5">{p.model}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Info</span>
                <p className="mt-0.5">{p.description}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Env var richiesta</span>
                <p className="font-mono text-xs mt-1 bg-secondary inline-block px-2 py-1 rounded">{p.envVar}</p>
              </div>
              <p className="text-xs text-muted-foreground italic">
                Disponibilità verificabile da self-test
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
