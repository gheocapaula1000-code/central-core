import { Link } from "react-router-dom";
import { LEGAL_ENTITY } from "@/lib/legalEntity";

const f = (v: string) => v || "[da compilare]";

export default function PrivacyPolicy() {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">← Torna indietro</Link>
      <h1 className="text-2xl font-bold">Informativa sulla Privacy</h1>
      <p className="text-xs text-muted-foreground">Ultimo aggiornamento: marzo 2026</p>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">Titolare del trattamento</h2>
        <p>{f(LEGAL_ENTITY.companyName)}, {f(LEGAL_ENTITY.address)} {f(LEGAL_ENTITY.cap)} {f(LEGAL_ENTITY.city)} ({f(LEGAL_ENTITY.province)})</p>
        <p>Email: {f(LEGAL_ENTITY.email)} | PEC: {f(LEGAL_ENTITY.pec)}</p>
      </section>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">Tipi di dati raccolti</h2>
        <p>Dati di navigazione (log del server, indirizzo IP), cookie tecnici, dati forniti volontariamente dall'utente (email, form di contatto).</p>
      </section>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">Finalità del trattamento</h2>
        <p>Funzionamento del servizio, assistenza tecnica, adempimenti di legge.</p>
      </section>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">Base giuridica</h2>
        <p>Consenso dell'interessato, esecuzione di un contratto, legittimo interesse del titolare.</p>
      </section>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">Conservazione dei dati</h2>
        <p>I dati sono conservati per il tempo strettamente necessario alle finalità per cui sono raccolti.</p>
      </section>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">Diritti dell'interessato</h2>
        <p>L'utente ha diritto di accesso, rettifica, cancellazione, portabilità dei dati, opposizione al trattamento e reclamo al Garante per la protezione dei dati personali.</p>
      </section>

      <section className="space-y-2 text-sm text-muted-foreground">
        <h2 className="text-base font-semibold text-foreground">Cookie</h2>
        <p>Per informazioni sui cookie utilizzati, consultare la <Link to="/cookie-policy" className="underline hover:text-foreground">Cookie Policy</Link>.</p>
      </section>
    </div>
  );
}
