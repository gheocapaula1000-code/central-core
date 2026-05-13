import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { TERRITORI_CIVIKO_ONE, type Microzona } from "@/data/civiko-one-territori";

const sentimentColor: Record<string, string> = {
  freddo: "bg-slate-700 text-slate-100",
  tiepido: "bg-amber-900/40 text-amber-200",
  stabile: "bg-secondary text-muted-foreground",
  caldo: "bg-orange-900/40 text-orange-200",
  molto_caldo: "bg-red-900/40 text-red-200",
};

function MicrozonaCard({ m }: { m: Microzona }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{m.nome}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              {m.comune} · {m.cluster.replaceAll("_", " ")}
            </p>
          </div>
          <Badge className={sentimentColor[m.sentimentCommerciale] ?? ""}>
            {m.sentimentCommerciale.replace("_", " ")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Fascia percepita</span>
          <span className="capitalize">{m.fasciaPercepita}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Tipologie prevalenti</span>
          <span className="text-right text-xs">{m.tipologiePrevalenti.join(", ")}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Domanda / Offerta</span>
          <span>
            <Badge variant="outline" className="mr-1 capitalize">{m.domandaStimata}</Badge>
            <Badge variant="outline" className="capitalize">{m.offertaStimata}</Badge>
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Prezzo indicativo €/mq</span>
          <span className="font-mono text-xs">
            {m.rangePrezzoIndicativoEurMq.min.toLocaleString("it-IT")} – {m.rangePrezzoIndicativoEurMq.max.toLocaleString("it-IT")}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Tempi vendita</span>
          <span className="text-xs">{m.tempiStimatiVenditaMesi.min}–{m.tempiStimatiVenditaMesi.max} mesi</span>
        </div>
        <div className="pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground">Note operative interne</p>
          <p className="text-xs mt-1">{m.noteOperativeInterne}</p>
        </div>
        <p className="text-[10px] text-muted-foreground text-right">
          Aggiornato: {m.ultimoAggiornamento}
        </p>
      </CardContent>
    </Card>
  );
}

export default function TerritoriPage() {
  const [query, setQuery] = useState("");
  const territorio = TERRITORI_CIVIKO_ONE[0];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return territorio.microzone;
    return territorio.microzone.filter(
      (m) =>
        m.nome.toLowerCase().includes(q) ||
        m.comune.toLowerCase().includes(q) ||
        m.cluster.toLowerCase().includes(q),
    );
  }, [query, territorio.microzone]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Territori</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Dati interni Core per la PWA <span className="font-medium">Metodo Civiko One</span>.
            Non esporre fonti grezze o payload tecnici fuori dal Core.
          </p>
        </div>
        <Badge variant="outline" className="capitalize">PWA principale: Metodo Civiko One</Badge>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg">{territorio.nome}</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Stato: <Badge variant="outline" className="capitalize">{territorio.stato}</Badge> · {territorio.microzone.length} microzone · {territorio.cluster.length} cluster
              </p>
            </div>
            <Input
              placeholder="Filtra microzone, comuni o cluster"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="max-w-xs"
            />
          </div>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map((m) => (
          <MicrozonaCard key={`${m.comune}-${m.nome}`} m={m} />
        ))}
      </div>
    </div>
  );
}
