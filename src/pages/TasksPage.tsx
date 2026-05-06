import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TASK_REGISTRY } from "@/lib/constants";

type Filter = "all" | "web" | "generative";

export default function TasksPage() {
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = filter === "all" ? TASK_REGISTRY : TASK_REGISTRY.filter((t) => t.type === filter);

  return (
    <div className="space-y-6 min-w-0">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl font-bold">Task Registry</h1>
        <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <TabsList>
            <TabsTrigger value="all">Tutti ({TASK_REGISTRY.length})</TabsTrigger>
            <TabsTrigger value="web">Web</TabsTrigger>
            <TabsTrigger value="generative">Generativi</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto w-full min-w-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead className="text-right">Max Tokens</TableHead>
              <TableHead>Tipo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((t) => (
              <TableRow key={t.task}>
                <TableCell className="font-mono text-sm">{t.task}</TableCell>
                <TableCell className="text-sm">{t.provider}</TableCell>
                <TableCell>
                  <div className="flex gap-1 flex-wrap">
                    {t.domains.map((d) => (
                      <span key={d} className="font-mono text-xs bg-secondary px-1.5 py-0.5 rounded">{d}</span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-sm">{t.maxTokens}</TableCell>
                <TableCell>
                  <Badge
                    className={
                      t.type === "web"
                        ? "bg-cyan-500/20 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/20"
                        : "bg-violet-500/20 text-violet-400 border-violet-500/30 hover:bg-violet-500/20"
                    }
                  >
                    {t.type}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
