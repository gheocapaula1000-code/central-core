import { Link } from "react-router-dom";
import { LEGAL_ENTITY } from "@/lib/legalEntity";

const field = (val: string) => val || "—";

export default function LegalFooter() {
  return (
    <footer className="border-t border-border bg-card/50 px-6 py-4 text-center text-xs text-muted-foreground space-y-1">
      <div className="flex flex-wrap justify-center gap-2">
        <Link to="/privacy-policy" className="underline hover:text-foreground">Privacy Policy</Link>
        <span>|</span>
        <Link to="/cookie-policy" className="underline hover:text-foreground">Cookie Policy</Link>
        <span>|</span>
        <Link to="/termini-condizioni" className="underline hover:text-foreground">Termini e Condizioni</Link>
        <span>|</span>
        <Link to="/note-legali" className="underline hover:text-foreground">Note Legali</Link>
      </div>
      <p>
        © 2026 {LEGAL_ENTITY.companyName} — Tutti i diritti riservati
        {LEGAL_ENTITY.vatNumber && <> · P.IVA: {field(LEGAL_ENTITY.vatNumber)}</>}
        {LEGAL_ENTITY.email && <> · {field(LEGAL_ENTITY.email)}</>}
      </p>
    </footer>
  );
}
