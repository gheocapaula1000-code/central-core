import { Smartphone, Bot, ClipboardList, Activity, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    </div>
  );
}
