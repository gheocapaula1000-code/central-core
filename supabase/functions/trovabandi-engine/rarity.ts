// UEradar — visibilità "bandi rari" (is_hidden) e rarity_score.
//
// Modulo puro: nessuna rete, nessun accesso DB.
// Regola di prodotto (fail-closed, nessun dato inventato):
//   - authority_level COMUNALE o CAMERALE  ⇒ is_hidden = true, rarity >= 4
//   - source_kind GAL / ALBO_PRETORIO / AMMINISTRAZIONE_TRASPARENTE ⇒ idem
//   - documento PDF servito da Amministrazione Trasparente ⇒ is_hidden = true,
//     rarity >= 5 (bando poco monitorato, raggiungibile solo via Agent-PDF)
// Tutto il resto resta visibile con la rarity_base della fonte.

export type RaritySourceLike = {
  authority_level?: string | null;
  source_kind?: string | null;
  rarity_base?: number | null;
  name?: string | null;
};

const HIDDEN_LEVELS = new Set(["COMUNALE", "CAMERALE"]);
const HIDDEN_KINDS = new Set([
  "GAL",
  "ALBO_PRETORIO",
  "AMMINISTRAZIONE_TRASPARENTE",
  "AVVISI_PUBBLICI",
  "CAMERALE",
]);

function norm(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(value)));
}

/** true se l'URL è un PDF pubblicato in Amministrazione Trasparente / albo. */
export function isTransparencyPdf(officialUrl: string | null): boolean {
  const url = (officialUrl ?? "").toLowerCase();
  if (!url) return false;
  const isPdf = url.includes(".pdf") || url.includes("/documento");
  if (!isPdf) return false;
  return (
    url.includes("amministrazione-trasparente") ||
    url.includes("amministrazionetrasparente") ||
    url.includes("/trasparente") ||
    url.includes("albo-pretorio") ||
    url.includes("albopretorio") ||
    url.includes("/albo")
  );
}

export function computeVisibility(
  source: RaritySourceLike,
  officialUrl: string | null,
): { is_hidden: boolean; rarity_score: number } {
  const level = norm(source.authority_level);
  const kind = norm(source.source_kind);
  const name = norm(source.name);
  const base = clamp(Number(source.rarity_base ?? 1));

  const galByName = name.startsWith("GAL ") || name.includes(" GAL ");
  const pdfTrasparenza = isTransparencyPdf(officialUrl);

  const hidden =
    HIDDEN_LEVELS.has(level) || HIDDEN_KINDS.has(kind) || galByName ||
    pdfTrasparenza;

  if (!hidden) return { is_hidden: false, rarity_score: base };

  const floor = pdfTrasparenza ? 5 : 4;
  return { is_hidden: true, rarity_score: clamp(Math.max(base, floor)) };
}
