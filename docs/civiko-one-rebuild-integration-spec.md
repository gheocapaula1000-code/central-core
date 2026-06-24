# Civiko One Rebuild — Spec di integrazione PWA → Central Core

**Versione:** V1.0 — 2026-06-24
**Backend Core project ref:** `jpunnzgixcghuydstdlt`
**Anon key:** già configurata in Lovable Cloud (verrà iniettata in `.env` del nuovo progetto automaticamente).

---

## 0. Setup nuovo progetto Lovable

Quando crei il progetto `civiko-one-rebuild`:

1. **Abilita Lovable Cloud** sul nuovo progetto: questo gli darà il proprio Supabase.
2. **MA**: tutte le tabelle/edge functions Civiko One vivono già nel Core (`jpunnzgixcghuydstdlt`).
3. Configura il client Supabase del nuovo progetto per puntare al **Core**, non al suo Cloud locale, sovrascrivendo `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` con i valori del Core (che ti passerò separatamente nella chat di setup).
4. Stack: React 18 + Vite 5 + Tailwind v3 + shadcn (default Lovable).

---

## 1. Autenticazione

- **Provider V1:** email/password (Google in V1.1).
- **Sessione:** standard Supabase `onAuthStateChange` + `getSession()` per il bearer.
- **Tabella profili:** crea `profiles` lato Core in fase 1.1 se servirà (per ora non necessario: agenzia → `agency_memberships` esistente).
- **Onboarding pilota:** un super-admin Core crea l'agenzia pilota e inserisce una riga in `agency_memberships` con `role='owner'`, `status='active'`.

---

## 2. Tabelle (già create, RLS attive)

Tutte filtrano per `agency_id` via `is_agency_member()` / `is_agency_admin()`.

| Tabella | Scopo |
| --- | --- |
| `civiko_one_property_cases` | immobile/pratica |
| `civiko_one_property_photos` | foto (storage path) |
| `civiko_one_property_documents` | checklist documenti |
| `civiko_one_generated_outputs` | dossier, annunci, piani promo (versionati) |

**Enum:**
- `civiko_one_case_status`: `draft, active, listed, negotiating, sold, withdrawn, archived`
- `civiko_one_doc_status`: `missing, uploaded, verified, rejected`
- `civiko_one_output_kind`: `owner_dossier, listing_casa, listing_immobiliare, listing_idealista, listing_subito, promo_plan`

---

## 3. Storage

Due bucket **privati** già creati:

- `civiko-one-photos`
- `civiko-one-docs`

**Convenzione path obbligatoria:** `{agency_id}/{case_id}/{filename}`
La RLS lo richiede: la prima cartella DEVE essere l'`agency_id` (uuid) del membro autenticato.

**Lettura nel client:** sempre via `createSignedUrl(path, 3600)`, mai URL pubblici.

```ts
const { data } = await supabase.storage
  .from('civiko-one-photos')
  .createSignedUrl(`${agencyId}/${caseId}/${filename}`, 3600);
```

---

## 4. Endpoint Core (edge functions)

Base URL: `https://jpunnzgixcghuydstdlt.supabase.co/functions/v1`

Tutti i POST richiedono:
- `Authorization: Bearer <user_jwt>`
- `Content-Type: application/json`
- `x-source-app: civiko-one` (consigliato, futuro hardening)

Auth: end-user JWT verificato + check `agency_memberships` server-side.

### 4.1 `POST /civiko-one-cases/create-with-checklist`

Crea un case e popola automaticamente la checklist documenti standard (11 voci).

```json
{
  "agency_id": "uuid",
  "title": "Trilocale via Mazzini 12",
  "address_text": "Via Mazzini 12",
  "cap": "35100",
  "municipality": "Padova",
  "province": "PD",
  "property_type": "trilocale",
  "rooms": 3,
  "bathrooms": 2,
  "surface_mq": 95,
  "ask_price": 285000,
  "assigned_agent_id": "uuid (opzionale, default = caller)"
}
```

Risposta: `{ ok, data: { case_id, checklist_seeded, checklist_items } }`

### 4.2 `POST /civiko-one-cases/seed-checklist`

Re-seeda solo le voci mancanti per un case esistente.

```json
{ "agency_id": "uuid", "case_id": "uuid" }
```

### 4.3 `POST /civiko-one-dossier`

Genera dossier proprietario JSON strutturato, salvato versionato.

```json
{ "agency_id": "uuid", "case_id": "uuid" }
```

Risposta `data.content`:
```json
{
  "headline": "...",
  "executive_summary": "...",
  "punti_forza": ["..."],
  "punti_attenzione": ["..."],
  "posizionamento_prezzo": "...",
  "azioni_consigliate": ["..."],
  "note_finali": "..."
}
```

### 4.4 `POST /civiko-one-listing`

Genera testi annuncio per Casa.it, Immobiliare.it, Idealista, Subito.

```json
{
  "agency_id": "uuid",
  "case_id": "uuid",
  "portals": ["casa","immobiliare","idealista","subito"]
}
```

Risposta: `data.portals[portal] = { output_id, version, content: { titolo, descrizione, tag_principali } }`

### 4.5 `POST /civiko-one-promo`

Piano promo 7 o 14 giorni.

```json
{ "agency_id": "uuid", "case_id": "uuid", "days": 14 }
```

---

## 5. CRUD diretto via PostgREST

Le RLS già scritte permettono CRUD diretto dal client su:

- `civiko_one_property_cases` (UPDATE/SELECT/INSERT membri; DELETE admin)
- `civiko_one_property_photos` (gestione foto)
- `civiko_one_property_documents` (aggiornamento status, upload path)
- `civiko_one_generated_outputs` (solo SELECT lato client per leggere dossier/annunci/promo; INSERT lo fanno le edge functions)

Esempio:
```ts
await supabase
  .from('civiko_one_property_cases')
  .update({ ask_price: 295000, status: 'active' })
  .eq('id', caseId);
```

---

## 6. Inviti agente (V1 manuale)

Per V1 pilota: l'owner agenzia crea l'utente via email/password e poi l'admin inserisce una riga in `agency_memberships` (script lato Core). Sistema invite via email arriva in V1.1.

---

## 7. Design / UX

- Mobile-first, minimal, tono "premium immobiliare".
- Niente parole "AI", "GPT", "intelligenza artificiale" in UI. Usa: "Assistente", "Scanner", "Motore Civiko".
- shadcn + Tailwind tokens semantici (no hex hardcoded).
- Loading state visibile su generazione dossier/annunci (10-30s).

---

## 8. Anti-copia (riassunto)

Resta nel frontend: UI, form, upload, lista case, visualizzazione output.
Resta nel Core: prompt AI, regole portali, scoring, generazione PDF (V1.1).

---

## 9. Cosa NON fare nel nuovo progetto

- Non duplicare prompt o regole portale nel frontend.
- Non chiamare direttamente Lovable AI Gateway dal client (passa sempre dalle edge functions Core).
- Non usare il bucket `public` per foto/documenti.
- Non bypassare `agency_id` nella convenzione storage path.

---

## 10. Checklist primo deploy pilota

- [ ] Creare progetto Lovable `civiko-one-rebuild`.
- [ ] Sovrascrivere VITE_SUPABASE_URL/KEY → puntano al Core.
- [ ] Abilitare auth email/password lato Core (già attiva).
- [ ] Creare riga `agencies` per pilota + `agency_memberships` owner.
- [ ] Smoke test: signup → create case → upload foto → genera dossier → genera annuncio Casa.it → genera promo 14gg.
