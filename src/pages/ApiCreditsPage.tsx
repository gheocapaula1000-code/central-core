import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, Wallet, Activity, Bell, Settings2, History, Shield, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "@/hooks/use-toast";

type Risk = "basso" | "medio" | "alto" | "ignoto";

interface Provider {
  key: string;
  name: string;
  category: string;
  configured: boolean;
  connection_status: "ok" | "error" | "unknown";
  credit_estimate: { value: number | null; unit: string; raw_label?: string };
  threshold_min_eur: number | null;
  usage_24h: { calls: number | null; cost_eur: number | null };
  usage_7d: { calls: number | null; cost_eur: number | null };
  exhaustion_risk: Risk;
  recommended_action: string;
  billing_url: string;
  automation: "auto_reload" | "manual_only" | "managed" | "pay_per_call";
  automation_label: string;
  last_check: string;
  error?: string;
}

interface CreditsResponse {
  ok: boolean;
  checked_at: string;
  summary: { total: number; configured: number; missing: number; risk_high: number; risk_medium: number; risk_unknown: number };
  providers: Provider[];
  alerts: { level: "red" | "yellow"; provider: string; message: string; action_url: string }[];
}

interface PersistedThreshold {
  provider: string;
  warning_threshold_eur: number;
  critical_threshold_eur: number;
  block_threshold_eur: number;
  recommended_topup_eur: number;
  notes?: string | null;
  updated_at?: string;
  source: "persisted" | "default";
}

interface ThresholdsResponse {
  ok: boolean;
  defaults: {
    warning_threshold_eur: number;
    critical_threshold_eur: number;
    block_threshold_eur: number;
    recommended_topup_eur: number;
  };
  thresholds: PersistedThreshold[];
  automation_note: string;
}

const AUTOMATION_NOTE_FALLBACK =
  "Le ricariche automatiche dipendono dalle policy dei singoli provider. Il sistema monitora, avvisa e guida l’azione, ma non effettua pagamenti automatici senza conferma.";

function riskBadge(risk: Risk) {
  const map: Record<Risk, { label: string; className: string }> = {
    basso: { label: "Rischio basso", className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
    medio: { label: "Rischio medio", className: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
    alto: { label: "Rischio alto", className: "bg-red-500/15 text-red-400 border-red-500/30" },
    ignoto: { label: "Non noto", className: "bg-muted text-muted-foreground border-border" },
  };
  const m = map[risk];
  return <Badge variant="outline" className={m.className}>{m.label}</Badge>;
}

function automationBadge(p: Provider) {
  if (p.automation === "auto_reload") return <Badge variant="outline" className="border-violet-500/30 text-violet-400">Automazione possibile</Badge>;
  if (p.automation === "managed") return <Badge variant="outline">Gestito</Badge>;
  if (p.automation === "pay_per_call") return <Badge variant="outline">Pay-per-call</Badge>;
  return <Badge variant="outline">Ricarica manuale consigliata</Badge>;
}

export default function ApiCreditsPage() {
  const [data, setData] = useState<CreditsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errType, setErrType] = useState<'auth' | 'generic' | null>(null);
  const [thr, setThr] = useState<ThresholdsResponse | null>(null);
  const [thrLoading, setThrLoading] = useState(false);
  const [thrErrType, setThrErrType] = useState<'auth' | 'generic' | null>(null);
  const [savingProvider, setSavingProvider] = useState<string | null>(null);

  async function callEdgeFunction<T>(
    name: string,
    options?: { method?: string; body?: unknown }
  ): Promise<{ data: T | null; error: { type: 'auth' | 'generic'; message: string } | null }> {
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = {
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      "Content-Type": "application/json",
    };
    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    }

    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`, {
      method: options?.method ?? "GET",
      headers,
      ...(options?.body ? { body: JSON.stringify(options.body) } : {}),
    });

    if (res.status === 401 || res.status === 403) {
      return { data: null, error: { type: 'auth', message: 'Accesso negato' } };
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || 'Errore del servizio';
      return { data: null, error: { type: 'generic', message: msg } };
    }

    const data = await res.json().catch(() => null);
    return { data, error: null };
  }

  const load = useCallback(async () => {
    setLoading(true); setErr(null); setErrType(null);
    const { data: res, error } = await callEdgeFunction<CreditsResponse>("api-credits-status", { method: "POST" });
    if (error) {
      setErr(error.message);
      setErrType(error.type);
    } else {
      setData(res);
    }
    setLoading(false);
  }, []);

  const loadThresholds = useCallback(async () => {
    setThrLoading(true); setThrErrType(null);
    const { data: res, error } = await callEdgeFunction<ThresholdsResponse>("api-credit-thresholds", { method: "GET" });
    if (error) {
      if (error.type === 'generic') {
        toast({ title: "Centro Crediti non disponibile", description: "Il servizio soglie non ha risposto correttamente. Riprova più tardi." });
      }
      setThrErrType(error.type);
    } else {
      setThr(res);
    }
    setThrLoading(false);
  }, []);

  useEffect(() => { load(); loadThresholds(); }, [load, loadThresholds]);

  function updateLocal(provider: string, patch: Partial<PersistedThreshold>) {
    setThr((prev) => prev ? {
      ...prev,
      thresholds: prev.thresholds.map((t) => t.provider === provider ? { ...t, ...patch } : t),
    } : prev);
  }

  async function saveThreshold(t: PersistedThreshold) {
    if (!(t.warning_threshold_eur >= t.critical_threshold_eur && t.critical_threshold_eur >= t.block_threshold_eur)) {
      toast({ title: "Soglie non valide", description: "Deve valere: giallo ≥ rosso ≥ blocco." });
      return;
    }
    setSavingProvider(t.provider);
    try {
      const { error } = await callEdgeFunction<ThresholdsResponse>("api-credit-thresholds", {
        method: "POST",
        body: {
          provider: t.provider,
          warning_threshold_eur: t.warning_threshold_eur,
          critical_threshold_eur: t.critical_threshold_eur,
          block_threshold_eur: t.block_threshold_eur,
          recommended_topup_eur: t.recommended_topup_eur,
        },
      });
      if (error) {
        if (error.type === 'auth') {
          toast({ title: "Accesso negato", description: "Non hai i permessi per salvare le soglie." });
        } else {
          toast({ title: "Salvataggio non riuscito", description: "Il servizio non ha risposto correttamente. Riprova più tardi." });
        }
        return;
      }
      toast({ title: "Soglie salvate", description: `Provider: ${t.provider}` });
      updateLocal(t.provider, { source: "persisted", updated_at: new Date().toISOString() });
    } catch (e) {
      toast({ title: "Salvataggio non riuscito", description: "Errore imprevisto. Riprova più tardi." });
    } finally { setSavingProvider(null); }
  }


  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Wallet className="h-6 w-6 text-violet-400" /> Centro Crediti API</h1>
          <p className="text-sm text-muted-foreground mt-1">Monitoraggio crediti e usage stimato dei provider del Central Core. Nessuna chiave o token esposta.</p>
        </div>
        <Button onClick={load} disabled={loading} variant="outline" size="sm">
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} /> Aggiorna
        </Button>
      </div>

      {errType === 'auth' && (
        <Card className="border-amber-500/20 bg-amber-500/5">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Shield className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <h3 className="font-semibold">Accesso admin richiesto</h3>
                <p className="text-sm text-muted-foreground mt-1">Per visualizzare il Centro Crediti API devi essere autenticata come owner/admin del Central Core.</p>
                <p className="text-xs text-muted-foreground mt-2">Nessuna chiave, token o informazione sensibile viene esposta.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {errType === 'generic' && (
        <Card className="border-border">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <h3 className="font-semibold">Centro Crediti non disponibile</h3>
                <p className="text-sm text-muted-foreground mt-1">Il servizio non ha risposto correttamente. Riprova più tardi o verifica lo stato del Central Core.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="overview"><Activity className="h-4 w-4 mr-1.5" />Panoramica</TabsTrigger>
          <TabsTrigger value="providers"><Wallet className="h-4 w-4 mr-1.5" />Provider</TabsTrigger>
          <TabsTrigger value="thresholds"><Settings2 className="h-4 w-4 mr-1.5" />Soglie</TabsTrigger>
          <TabsTrigger value="history"><History className="h-4 w-4 mr-1.5" />Storico</TabsTrigger>
          <TabsTrigger value="actions"><Bell className="h-4 w-4 mr-1.5" />Azioni consigliate</TabsTrigger>
        </TabsList>

        {/* ── Panoramica ───────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryCard label="Provider" value={data?.summary.total ?? "—"} />
            <SummaryCard label="Configurati" value={data?.summary.configured ?? "—"} tone="ok" />
            <SummaryCard label="Rischio alto" value={data?.summary.risk_high ?? "—"} tone={data && data.summary.risk_high > 0 ? "red" : "muted"} />
            <SummaryCard label="Rischio medio" value={data?.summary.risk_medium ?? "—"} tone={data && data.summary.risk_medium > 0 ? "amber" : "muted"} />
          </div>
          {data?.alerts && data.alerts.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base flex items-center gap-2"><Bell className="h-4 w-4" /> Avvisi attivi</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {data.alerts.map((a, i) => (
                  <div key={i} className={`flex items-start gap-3 rounded-md border p-3 ${a.level === "red" ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5"}`}>
                    <AlertTriangle className={`h-4 w-4 mt-0.5 ${a.level === "red" ? "text-red-400" : "text-amber-400"}`} />
                    <div className="flex-1 text-sm">
                      <div className="font-medium">{a.provider}</div>
                      <div className="text-muted-foreground">{a.message}</div>
                    </div>
                    <a href={a.action_url} target="_blank" rel="noreferrer" className="text-xs underline text-muted-foreground hover:text-foreground inline-flex items-center gap-1">Portale <ExternalLink className="h-3 w-3" /></a>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
          {data && data.alerts.length === 0 && (
            <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Tutto ok</AlertTitle><AlertDescription>Nessun provider sotto soglia di attenzione.</AlertDescription></Alert>
          )}
          {data?.checked_at && <p className="text-xs text-muted-foreground">Ultimo controllo: {new Date(data.checked_at).toLocaleString("it-IT")}</p>}
        </TabsContent>

        {/* ── Provider ─────────────────────────────────────────────── */}
        <TabsContent value="providers" className="space-y-3">
          {data?.providers?.map((p) => (
            <Card key={p.key}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      {p.name}
                      <span className="text-xs font-normal text-muted-foreground capitalize">· {p.category}</span>
                    </CardTitle>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      {riskBadge(p.exhaustion_risk)}
                      {automationBadge(p)}
                      <Badge variant={p.connection_status === "ok" ? "default" : "destructive"} className="text-xs">
                        {p.connection_status === "ok" ? "Connesso" : p.configured ? "Errore" : "Non configurato"}
                      </Badge>
                    </div>
                  </div>
                  <a href={p.billing_url} target="_blank" rel="noreferrer" className="text-xs underline text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                    Portale billing <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <Metric label="Credito stimato" value={
                  p.credit_estimate.value != null
                    ? `${p.credit_estimate.value} ${p.credit_estimate.unit}`
                    : (p.credit_estimate.raw_label ?? "n/d")
                } />
                <Metric label="Soglia minima" value={p.threshold_min_eur != null ? `${p.threshold_min_eur} €` : "n/a"} />
                <Metric label="Consumo 24h" value={p.usage_24h.cost_eur != null ? `${p.usage_24h.cost_eur} €` : "n/d"} />
                <Metric label="Consumo 7g" value={p.usage_7d.cost_eur != null ? `${p.usage_7d.cost_eur} €` : "n/d"} />
                <div className="col-span-2 md:col-span-4">
                  <div className="text-xs text-muted-foreground mb-1">Azione consigliata</div>
                  <div className="text-sm">{p.recommended_action}</div>
                </div>
                {p.error && (
                  <div className="col-span-2 md:col-span-4 text-xs text-red-400">⚠ {p.error}</div>
                )}
                <div className="col-span-2 md:col-span-4 text-xs text-muted-foreground">
                  Ultimo controllo: {new Date(p.last_check).toLocaleString("it-IT")}
                </div>
              </CardContent>
            </Card>
          ))}
          {!data && !err && <p className="text-sm text-muted-foreground">Caricamento…</p>}
        </TabsContent>

        {/* ── Soglie ───────────────────────────────────────────────── */}
        <TabsContent value="thresholds" className="space-y-3">
          <Alert>
            <Bell className="h-4 w-4" />
            <AlertTitle>Automazione e ricariche</AlertTitle>
            <AlertDescription>{thr?.automation_note ?? AUTOMATION_NOTE_FALLBACK}</AlertDescription>
          </Alert>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Soglie persistenti lato Core. Default applicati quando non salvate: giallo {thr?.defaults.warning_threshold_eur ?? 25}€ · rosso {thr?.defaults.critical_threshold_eur ?? 10}€ · blocco {thr?.defaults.block_threshold_eur ?? 5}€.
            </p>
            <Button variant="outline" size="sm" onClick={loadThresholds} disabled={thrLoading}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${thrLoading ? "animate-spin" : ""}`} /> Ricarica
            </Button>
          </div>

          {thr?.thresholds.map((t) => (
            <Card key={t.provider}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-base capitalize">{t.provider.replace(/_/g, " ")}</CardTitle>
                  <Badge variant="outline" className={t.source === "persisted" ? "border-emerald-500/30 text-emerald-400" : ""}>
                    {t.source === "persisted" ? "Salvata" : "Default"}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Avviso giallo (€)</Label>
                  <Input type="number" min={0} value={t.warning_threshold_eur}
                    onChange={(e) => updateLocal(t.provider, { warning_threshold_eur: Number(e.target.value) })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Avviso rosso (€)</Label>
                  <Input type="number" min={0} value={t.critical_threshold_eur}
                    onChange={(e) => updateLocal(t.provider, { critical_threshold_eur: Number(e.target.value) })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Blocco prudenziale (€)</Label>
                  <Input type="number" min={0} value={t.block_threshold_eur}
                    onChange={(e) => updateLocal(t.provider, { block_threshold_eur: Number(e.target.value) })} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Ricarica consigliata (€)</Label>
                  <Input type="number" min={0} value={t.recommended_topup_eur}
                    onChange={(e) => updateLocal(t.provider, { recommended_topup_eur: Number(e.target.value) })} />
                </div>
                <div className="col-span-2 md:col-span-4 flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs text-muted-foreground">
                    {t.updated_at ? `Ultimo aggiornamento: ${new Date(t.updated_at).toLocaleString("it-IT")}` : "Mai aggiornata"}
                  </p>
                  <Button size="sm" onClick={() => saveThreshold(t)} disabled={savingProvider === t.provider}>
                    {savingProvider === t.provider ? "Salvataggio…" : "Salva soglia"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

          {!thr && !thrLoading && (
            <p className="text-sm text-muted-foreground">Devi essere admin/owner per gestire le soglie.</p>
          )}
        </TabsContent>


        {/* ── Storico ──────────────────────────────────────────────── */}
        <TabsContent value="history">
          <Card>
            <CardHeader><CardTitle className="text-base">Storico consumi</CardTitle></CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Lo storico per provider verrà popolato quando avremo telemetria dei job lato Central Core.
                Per ora consulta i portali billing tramite la tab Provider.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Azioni ───────────────────────────────────────────────── */}
        <TabsContent value="actions" className="space-y-3">
          {data?.providers.filter(p => p.exhaustion_risk !== "basso").map((p) => (
            <Card key={p.key}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">{p.name} {riskBadge(p.exhaustion_risk)}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>{p.recommended_action}</div>
                <a href={p.billing_url} target="_blank" rel="noreferrer" className="text-xs underline text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                  Apri portale {p.name} <ExternalLink className="h-3 w-3" />
                </a>
              </CardContent>
            </Card>
          ))}
          {data && data.providers.every(p => p.exhaustion_risk === "basso") && (
            <Alert><CheckCircle2 className="h-4 w-4" /><AlertTitle>Nessuna azione richiesta</AlertTitle><AlertDescription>Tutti i provider sono entro le soglie.</AlertDescription></Alert>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryCard({ label, value, tone = "muted" }: { label: string; value: number | string; tone?: "ok" | "red" | "amber" | "muted" }) {
  const toneClass = tone === "ok" ? "text-emerald-400" : tone === "red" ? "text-red-400" : tone === "amber" ? "text-amber-400" : "text-foreground";
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${toneClass}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
