import { Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { APP_REGISTRY } from "@/lib/constants";
import { toast } from "@/hooks/use-toast";

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
                <div className="flex items-center gap-2">
                  <CardTitle className="text-lg">{app.name}</CardTitle>
                  <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20">
                    Connessa
                  </Badge>
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
                <span className="text-muted-foreground">Connessa dal</span>
                <span className="font-mono text-xs">{app.connectedAt}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Button
        variant="outline"
        className="w-full border-dashed border-2 h-14 text-muted-foreground hover:text-foreground"
        onClick={() => toast({ title: "Collega Nuova App", description: "Usa il README per collegare una nuova app." })}
      >
        <Plus className="mr-2 h-4 w-4" />
        Collega Nuova App
      </Button>
    </div>
  );
}
