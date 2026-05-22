import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Info, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DossierAgenziaPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Briefcase className="h-6 w-6" />
          Dossier Agenzia
          <Badge variant="outline" className="ml-2">Anteprima esempio</Badge>
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Pagina informativa interna del Central Core.
        </p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Anteprima dimostrativa</AlertTitle>
        <AlertDescription>
          Questa è un'anteprima dimostrativa. I dossier reali vengono generati
          dalla dashboard AcquisitionRadar con dati live del radar. Nessun dato
          mostrato qui rappresenta opportunità, proprietari, indirizzi o prezzi
          reali.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cos'è un Dossier Agenzia</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Il Dossier Agenzia è la scheda operativa che prepara l'agente alla
            telefonata e alla prima visita su un'opportunità individuata dal
            radar. Contiene sintesi commerciale, lettura della zona, range di
            posizionamento, strategia di contatto e script sicuro per il
            proprietario.
          </p>
          <p>
            La generazione, il calcolo dei punteggi e l'accesso ai dossier
            avvengono esclusivamente all'interno della dashboard
            AcquisitionRadar, su workspace autenticati con dati live del radar.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Struttura tipo del dossier</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-sm md:grid-cols-2">
            <li className="rounded-md border p-3">
              <div className="font-medium">A. Sintesi opportunità</div>
              <div className="text-xs text-muted-foreground">
                Anteprima esempio · perché è interessante, urgenza commerciale,
                obiettivo dell'agente.
              </div>
            </li>
            <li className="rounded-md border p-3">
              <div className="font-medium">B. Lettura zona</div>
              <div className="text-xs text-muted-foreground">
                Anteprima esempio · sentiment, domanda/offerta, tipologie
                richieste, fascia percepita.
              </div>
            </li>
            <li className="rounded-md border p-3">
              <div className="font-medium">C. Posizionamento immobile</div>
              <div className="text-xs text-muted-foreground">
                Anteprima esempio · range prudente, realistico, ambizioso.
              </div>
            </li>
            <li className="rounded-md border p-3">
              <div className="font-medium">D. Strategia telefonata</div>
              <div className="text-xs text-muted-foreground">
                Anteprima esempio · obiettivo, apertura, domande consentite.
              </div>
            </li>
            <li className="rounded-md border p-3">
              <div className="font-medium">E. Strategia prima visita</div>
              <div className="text-xs text-muted-foreground">
                Anteprima esempio · presentazione, argomenti forti, gestione
                obiezioni.
              </div>
            </li>
            <li className="rounded-md border p-3">
              <div className="font-medium">F. Script proprietario</div>
              <div className="text-xs text-muted-foreground">
                Anteprima esempio · testo non invasivo orientato al
                posizionamento.
              </div>
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dove si generano i dossier reali</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            I dossier operativi su opportunità reali sono disponibili solo
            all'interno della dashboard AcquisitionRadar, dove ogni workspace
            visualizza i propri dati live.
          </p>
          <Button asChild variant="default" size="sm">
            <a
              href="https://acquisitionradar.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              Apri AcquisitionRadar
              <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
