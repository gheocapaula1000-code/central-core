import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";

interface SourceRow {
  source_code: string;
  source_name: string;
  source_url: string | null;
  refresh_frequency: string | null;
  access_type: string;
  compliance_level: string;
  implementation_status: string;
  last_success_at: string | null;
  last_error: string | null;
  record_count: number;
  notes: string | null;
}

const statusVariant: Record<string, string> = {
  live: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  partial: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  manual_import: "bg-sky-500/10 text-sky-600 border-sky-500/30",
  planned: "bg-muted text-muted-foreground border-border",
  disabled: "bg-destructive/10 text-destructive border-destructive/30",
};

const complianceVariant: Record<string, string> = {
  public: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30",
  sensitive_aggregate: "bg-amber-500/10 text-amber-600 border-amber-500/30",
  sensitive_restricted: "bg-destructive/10 text-destructive border-destructive/30",
};

export default function SourceRegistryPage() {
  const [rows, setRows] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data, error } = await supabase
        .from("civiko_source_registry")
        .select("*")
        .order("source_code", { ascending: true });
      if (!mounted) return;
      if (error) setError(error.message);
      else setRows((data ?? []) as SourceRow[]);
      setLoading(false);
    })();
    return () => { mounted = false; };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Source Registry Padova</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Catalogo unificato fonti dati Civiko. Solo admin. Dati aggregati o gated.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fonti registrate</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-sm text-muted-foreground">Caricamento…</p>}
          {error && <p className="text-sm text-destructive">Errore: {error}</p>}
          {!loading && !error && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">Nessuna fonte registrata.</p>
          )}
          {!loading && rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Codice</TableHead>
                  <TableHead>Nome</TableHead>
                  <TableHead>Accesso</TableHead>
                  <TableHead>Compliance</TableHead>
                  <TableHead>Stato</TableHead>
                  <TableHead className="text-right">Record</TableHead>
                  <TableHead>Ultimo OK</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.source_code}>
                    <TableCell className="font-mono text-xs">{r.source_code}</TableCell>
                    <TableCell>
                      <div className="font-medium">{r.source_name}</div>
                      {r.notes && <div className="text-xs text-muted-foreground mt-0.5">{r.notes}</div>}
                    </TableCell>
                    <TableCell className="text-xs">{r.access_type}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={complianceVariant[r.compliance_level] ?? ""}>
                        {r.compliance_level}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusVariant[r.implementation_status] ?? ""}>
                        {r.implementation_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{r.record_count}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.last_success_at ? new Date(r.last_success_at).toLocaleDateString("it-IT") : "—"}
                      {r.last_error && (
                        <div className="text-xs text-destructive mt-0.5 truncate max-w-[200px]" title={r.last_error}>
                          {r.last_error}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
