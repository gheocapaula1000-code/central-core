# 📍 DOVE INCOLLARE: 🔵 Central Core (chat Lovable "Central Core / Core V3")

job_id: 5ac987b5-65bc-4241-9163-66242cbdfe94
casa.it crawl gia fatto: 019ea797-2ea8-74cd-b597-c0e2e396a7d9 (120 pagine, onlyMainContent:false, gia in archivio).
Problema: il parser ha estratto 0 annunci dalle 120 pagine. Vogliamo capire perche e fixare SENZA ri-crawlare (i dati grezzi ci sono gia).

NON ri-crawlare casa finche non abbiamo capito la struttura. Niente spreco di credits.

FASE 1 — ISPEZIONA il markdown gia raccolto (GRATIS, nessuna nuova chiamata esterna)

Prendi 2-3 pagine del crawl 019ea797-... gia salvate e mostrami GREZZO:

i primi ~3000 caratteri del markdown/html di una list-page di casa.it

come appaiono le singole card annuncio nel contenuto raccolto: c'e' il prezzo? i mq? il link al detail (/immobili/<id>/ o altro pattern)? il flag privato/agenzia?

dimmi se il contenuto delle card e' PRESENTE nel markdown o se e' caricato in JS e quindi assente (in quel caso il crawl semplice non bastera mai e servira un approccio diverso).

Mostrami l'estratto reale, non una descrizione. Voglio vedere cosa c'e' davvero nel testo raccolto.

FASE 2 — (solo dopo aver visto la struttura) PROPONI il fix del parser

In base a cosa vedi nel markdown:

se le card CI SONO nel testo: scrivi il parser corretto (regex/selettori sul pattern reale che hai trovato) e ri-processa le 120 pagine GIA salvate (NO nuovo crawl) per estrarre gli annunci.

se le card NON ci sono (solo JS): dimmelo chiaramente e proponi l'alternativa (es. Firecrawl con formats scrape + waitFor JS, oppure actor Apify dedicato a casa.it), col costo stimato. NON lanciare nulla, aspetta il mio ok.

Regole: deploy esplicito prima di chiamare; niente ri-crawl finche non vedo la struttura; niente run parallele.
Dammi prima l'estratto reale (FASE 1), poi la proposta (FASE 2). Mi fermo a decidere io.
