import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface RawRow {
  id: string;
  source_name: string;
  source_url: string | null;
  municipality: string | null;
  microzone: string | null;
  fetched_at: string;
  ingest_error: string | null;
}

interface NormRow {
  id: string;
  title: string;
  municipality: string | null;
  microzone: string | null;
  address_text: string | null;
  property_type: string | null;
  ask_price: number | null;
  surface_mq: number | null;
  source_name: string;
  source_url: string | null;
  first_seen_at: string;
  last_seen_at: string;
  freshness_days: number;
  completeness_score: number;
  priority_score: number;
  scoring_reason: string | null;
  possible_duplicate: boolean;
}

export default function DataEnginePage() {
  const [raws, setRaws] = useState<RawRow[]>([]);
  const [norms, setNorms] = useState<NormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [r, n] = await Promise.all([
          supabase.from("raw_sources_ingest").select("*").order("fetched_at", { ascending: false }).limit(50),
          supabase.from("normalized_opportunities").select("*").order("priority_score", { ascending: false }).limit(100),
        ]);
        if (r.error) throw r.error;
        if (n.error) throw n.error;
        setRaws((r.data ?? []) as RawRow[]);
        setNorms((n.data ?? []) as NormRow[]);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const duplicates = norms.filter((n) => n.possible_duplicate);
  const errors = raws.filter((r) => r.ingest_error);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Motore Dati — Pilota Padova</h1>
        <p className="text-sm text-muted-foreground">Vista tecnica MVP: raw ingestiti, normalizzati, duplicati possibili, score e motivazioni.</p>
      </div>

      {err && <div className="p-3 rounded-md border border-destructive/50 text-destructive text-sm">{err}</div>}
      {loading && <div className="text-sm text-muted-foreground">Caricamento…</div>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Raw ingestiti</div><div className="text-2xl font-bold">{raws.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Normalizzati</div><div className="text-2xl font-bold">{norms.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Possibili duplicati</div><div className="text-2xl font-bold">{duplicates.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">Errori ingest</div><div className="text-2xl font-bold">{errors.length}</div></CardContent></Card>
      </div>

      <Tabs defaultValue="normalized">
        <TabsList>
          <TabsTrigger value="normalized">Normalizzati ({norms.length})</TabsTrigger>
          <TabsTrigger value="raw">Raw ({raws.length})</TabsTrigger>
          <TabsTrigger value="duplicates">Duplicati ({duplicates.length})</TabsTrigger>
          <TabsTrigger value="errors">Errori ({errors.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="normalized" className="space-y-2">
          {norms.length === 0 && !loading && <p className="text-sm text-muted-foreground">Nessun record normalizzato. Invia un POST a <code>/functions/v1/ingest-opportunity</code>.</p>}
          {norms.map((n) => (
            <Card key={n.id}>
              <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2">
                <span>{n.title}</span>
                <Badge variant="secondary">score {n.priority_score}</Badge>
                {n.possible_duplicate && <Badge variant="destructive">dubbio duplicato</Badge>}
              </CardTitle></CardHeader>
              <CardContent className="text-xs space-y-1">
                <div>{n.municipality ?? "—"} · {n.microzone ?? "—"} · {n.property_type ?? "—"}</div>
                <div>{n.address_text ?? "—"}</div>
                <div>prezzo: {n.ask_price ?? "—"} € · mq: {n.surface_mq ?? "—"} · completezza: {n.completeness_score}% · freshness: {n.freshness_days}gg</div>
                <div className="text-muted-foreground">fonte: {n.source_name} {n.source_url && <a href={n.source_url} target="_blank" rel="noopener noreferrer" className="underline">↗</a>}</div>
                <div className="text-muted-foreground italic">{n.scoring_reason}</div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="raw" className="space-y-2">
          {raws.map((r) => (
            <Card key={r.id}><CardContent className="p-3 text-xs">
              <div className="font-medium">{r.source_name} · {r.municipality ?? "—"} {r.microzone && `· ${r.microzone}`}</div>
              <div className="text-muted-foreground">{new Date(r.fetched_at).toLocaleString()} {r.source_url && <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="underline ml-2">↗</a>}</div>
              {r.ingest_error && <div className="text-destructive mt-1">{r.ingest_error}</div>}
            </CardContent></Card>
          ))}
        </TabsContent>

        <TabsContent value="duplicates" className="space-y-2">
          {duplicates.length === 0 && <p className="text-sm text-muted-foreground">Nessun possibile duplicato rilevato.</p>}
          {duplicates.map((n) => (
            <Card key={n.id}><CardContent className="p-3 text-xs">
              <div className="font-medium">{n.title}</div>
              <div className="text-muted-foreground">{n.municipality} · {n.ask_price ?? "—"} € · {n.surface_mq ?? "—"} mq</div>
            </CardContent></Card>
          ))}
        </TabsContent>

        <TabsContent value="errors" className="space-y-2">
          {errors.length === 0 && <p className="text-sm text-muted-foreground">Nessun errore di ingest.</p>}
          {errors.map((r) => (
            <Card key={r.id}><CardContent className="p-3 text-xs">
              <div className="font-medium">{r.source_name}</div>
              <div className="text-destructive">{r.ingest_error}</div>
            </CardContent></Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
