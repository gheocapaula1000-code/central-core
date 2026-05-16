import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

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

type FormState = {
  source_name: string;
  municipality: string;
  microzone: string;
  title: string;
  address_text: string;
  property_type: string;
  ask_price: string;
  surface_mq: string;
  source_url: string;
};

const EMPTY_FORM: FormState = {
  source_name: "",
  municipality: "Padova",
  microzone: "",
  title: "",
  address_text: "",
  property_type: "",
  ask_price: "",
  surface_mq: "",
  source_url: "",
};

const DEMOS: Record<string, FormState> = {
  "Padova Centro": {
    source_name: "demo-manuale",
    municipality: "Padova",
    microzone: "Centro Storico",
    title: "Bilocale ristrutturato vicino Piazza delle Erbe",
    address_text: "Via Roma, Padova",
    property_type: "appartamento",
    ask_price: "265000",
    surface_mq: "62",
    source_url: "https://example.test/padova-centro/demo-1",
  },
  "Arcella": {
    source_name: "demo-manuale",
    municipality: "Padova",
    microzone: "Arcella",
    title: "Trilocale luminoso zona Arcella San Carlo",
    address_text: "Via Tiziano Aspetti, Padova",
    property_type: "appartamento",
    ask_price: "138000",
    surface_mq: "85",
    source_url: "https://example.test/arcella/demo-1",
  },
  "Guizza": {
    source_name: "demo-manuale",
    municipality: "Padova",
    microzone: "Guizza",
    title: "Casa singola con giardino zona Guizza",
    address_text: "Via Guizza, Padova",
    property_type: "indipendente",
    ask_price: "320000",
    surface_mq: "140",
    source_url: "https://example.test/guizza/demo-1",
  },
};

export default function DataEnginePage() {
  const [raws, setRaws] = useState<RawRow[]>([]);
  const [norms, setNorms] = useState<NormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<{ at: string; read: number; normalized: number; errors: number } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [r, n] = await Promise.all([
        supabase.from("raw_sources_ingest").select("*").order("fetched_at", { ascending: false }).limit(50),
        supabase.from("normalized_opportunities").select("*").order("last_seen_at", { ascending: false }).limit(100),
      ]);
      if (r.error) throw r.error;
      if (n.error) throw n.error;
      setRaws((r.data ?? []) as RawRow[]);
      setNorms((n.data ?? []) as NormRow[]);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const setField = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(payload: FormState) {
    if (!payload.source_name.trim()) {
      toast.error("source_name obbligatorio");
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        source_name: payload.source_name.trim(),
        municipality: payload.municipality.trim() || undefined,
        microzone: payload.microzone.trim() || undefined,
        title: payload.title.trim() || undefined,
        address_text: payload.address_text.trim() || undefined,
        property_type: payload.property_type.trim() || undefined,
        ask_price: payload.ask_price.trim() ? payload.ask_price.trim() : undefined,
        surface_mq: payload.surface_mq.trim() ? payload.surface_mq.trim() : undefined,
        source_url: payload.source_url.trim() || undefined,
      };
      const { data, error } = await supabase.functions.invoke("admin-ingest-test", { body });
      if (error) throw error;
      const result = (data as { ok?: boolean; results?: Array<{ normalized_id?: string; error?: string; warning?: string }> })?.results?.[0];
      if (result?.error) {
        toast.error(`Errore ingest: ${result.error}`);
      } else {
        setLastCreatedId(result?.normalized_id ?? null);
        toast.success(result?.warning === "possible_duplicate" ? "Inserito (possibile duplicato)" : "Inserito correttamente");
      }
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Errore sconosciuto");
    } finally {
      setSubmitting(false);
    }
  }

  const duplicates = norms.filter((n) => n.possible_duplicate);
  const errors = raws.filter((r) => r.ingest_error);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Motore Dati — Pilota Padova</h1>
        <p className="text-sm text-muted-foreground">Vista tecnica MVP: raw ingestiti, normalizzati, duplicati possibili, score e motivazioni.</p>
      </div>

      {err && <div className="p-3 rounded-md border border-destructive/50 text-destructive text-sm">{err}</div>}

      {/* Form admin di test */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Inserimento opportunità test</CardTitle>
          <p className="text-xs text-muted-foreground">Solo admin. Il segreto del job resta server-side, mai esposto al frontend.</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {Object.keys(DEMOS).map((k) => (
              <Button key={k} size="sm" variant="outline" onClick={() => setForm(DEMOS[k])}>
                Carica esempio {k}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => setForm(EMPTY_FORM)}>Reset</Button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {([
              ["source_name", "source_name *"],
              ["municipality", "municipality"],
              ["microzone", "microzone"],
              ["title", "title"],
              ["address_text", "address_text"],
              ["property_type", "property_type"],
              ["ask_price", "ask_price (€)"],
              ["surface_mq", "surface_mq"],
              ["source_url", "source_url"],
            ] as Array<[keyof FormState, string]>).map(([k, label]) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={k} className="text-xs">{label}</Label>
                <Input id={k} value={form[k]} onChange={setField(k)} />
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <Button onClick={() => submit(form)} disabled={submitting}>
              {submitting ? "Invio…" : "Invia a ingest-opportunity"}
            </Button>
          </div>
        </CardContent>
      </Card>

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
          {norms.length === 0 && !loading && <p className="text-sm text-muted-foreground">Nessun record normalizzato. Usa il form qui sopra.</p>}
          {norms.map((n) => {
            const highlight = n.id === lastCreatedId;
            return (
              <Card key={n.id} className={highlight ? "border-primary ring-2 ring-primary/40" : undefined}>
                <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2 flex-wrap">
                  <span>{n.title}</span>
                  <Badge variant="secondary">score {n.priority_score}</Badge>
                  {n.possible_duplicate && <Badge variant="destructive">dubbio duplicato</Badge>}
                  {highlight && <Badge>appena creato</Badge>}
                </CardTitle></CardHeader>
                <CardContent className="text-xs space-y-1">
                  <div>{n.municipality ?? "—"} · {n.microzone ?? "—"} · {n.property_type ?? "—"}</div>
                  <div>{n.address_text ?? "—"}</div>
                  <div>prezzo: {n.ask_price ?? "—"} € · mq: {n.surface_mq ?? "—"} · completezza: {n.completeness_score}% · freshness: {n.freshness_days}gg</div>
                  <div className="text-muted-foreground">fonte: {n.source_name} {n.source_url && <a href={n.source_url} target="_blank" rel="noopener noreferrer" className="underline">↗</a>}</div>
                  <div className="text-muted-foreground italic">{n.scoring_reason}</div>
                </CardContent>
              </Card>
            );
          })}
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
