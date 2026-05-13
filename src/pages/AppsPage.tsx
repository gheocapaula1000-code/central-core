import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { APP_REGISTRY } from "@/lib/constants";

export default function AppsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">App Collegate</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {APP_REGISTRY.map((app) => (
          <Card key={app.id}>
            <CardHeader className="flex flex-row items-start gap-3 pb-3">
              <span className="text-3xl">{app.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle className="text-lg">{app.name}</CardTitle>
                  <Badge variant="outline" className="bg-secondary text-muted-foreground border-border capitalize">
                    {app.lifecycle}
                  </Badge>
                  {app.lifecycle === "principale" && (
                    <Badge className="bg-violet-900/40 text-violet-200 border-violet-700">
                      PWA attiva
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-1">{app.description}</p>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Domini</span>
                <div className="flex gap-1.5 flex-wrap justify-end">
                  {app.domains.map((d) => (
                    <span key={d} className="font-mono text-xs bg-secondary px-2 py-0.5 rounded">{d}</span>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Piattaforma</span>
                <span>{app.platform}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Registrata dal</span>
                <span className="font-mono text-xs">{app.connectedAt}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
