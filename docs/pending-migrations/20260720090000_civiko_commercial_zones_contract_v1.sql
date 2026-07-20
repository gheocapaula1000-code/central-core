-- Civiko: allineamento atomico al contratto ufficiale delle 8 zone commerciali
-- basate ESCLUSIVAMENTE sui quartieri (fonte: civikoCommercialZoneContract.ts
-- + civikoCommercialZoneByQuartiere.ts). Fail-closed, transazionale,
-- reversibile tramite schema di backup dedicato.
--
-- Migrazione PENDING: NON viene applicata automaticamente e NON deve essere
-- eseguita sul database remoto in questo intervento. Nessun endpoint,
-- core-proxy, cron o PWA viene modificato.

BEGIN;

-- 0) Lock esclusivo sull'intera transazione ---------------------------------
SELECT pg_advisory_xact_lock(hashtext('civiko_commercial_zones_contract_v1_20260720')::bigint);

-- 1) PRECONDIZIONI ----------------------------------------------------------
DO $mig$
DECLARE
  v_expected text[] := ARRAY[
    'centro-storico','arcella','portello-stazione-stanga','torre-ponte-brenta-camin',
    'sant-osvaldo-facciolati','sud-voltabarozzo-guizza','san-carlo-san-bellino',
    'ovest-sacra-famiglia-chiesanuova'
  ]::text[];
  v_actual text[];
  v_bad_row record;
BEGIN
  SELECT array_agg(slug ORDER BY slug) INTO v_actual FROM public.civiko_commercial_zones;
  IF v_actual IS NULL OR array_length(v_actual,1) <> 8 THEN
    RAISE EXCEPTION 'Precondizione fallita: civiko_commercial_zones non ha 8 righe (attuali=%).', v_actual;
  END IF;
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(v_expected) x) <> v_actual THEN
    RAISE EXCEPTION 'Precondizione fallita: slug legacy non coincidono. Attesi=% Trovati=%', v_expected, v_actual;
  END IF;

  FOR v_bad_row IN
    SELECT slug, status, agency_id, trial_agency_id, occupied_agency_id
    FROM public.civiko_commercial_zones
    WHERE slug <> 'centro-storico'
      AND (status <> 'disponibile'
           OR agency_id IS NOT NULL
           OR trial_agency_id IS NOT NULL
           OR occupied_agency_id IS NOT NULL)
  LOOP
    RAISE EXCEPTION 'Precondizione fallita: la zona % non e disponibile/libera (status=%, agency=%, trial=%, occupied=%).',
      v_bad_row.slug, v_bad_row.status, v_bad_row.agency_id, v_bad_row.trial_agency_id, v_bad_row.occupied_agency_id;
  END LOOP;
END
$mig$;

-- 2) BACKUP REVERSIBILE -----------------------------------------------------
CREATE SCHEMA IF NOT EXISTS civiko_zone_migration_20260720;
REVOKE ALL ON SCHEMA civiko_zone_migration_20260720 FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA civiko_zone_migration_20260720 TO service_role;

DROP TABLE IF EXISTS civiko_zone_migration_20260720.civiko_commercial_zones_bak;
CREATE TABLE civiko_zone_migration_20260720.civiko_commercial_zones_bak AS
  SELECT * FROM public.civiko_commercial_zones;

DROP TABLE IF EXISTS civiko_zone_migration_20260720.padova_listings_zoning_bak;
CREATE TABLE civiko_zone_migration_20260720.padova_listings_zoning_bak AS
  SELECT id, quartiere, commercial_zone_slug, zone_match_method,
         zone_match_confidence, zone_resolved_at
  FROM public.padova_listings;

DROP TABLE IF EXISTS civiko_zone_migration_20260720.quartiere_zona_map_bak;
CREATE TABLE civiko_zone_migration_20260720.quartiere_zona_map_bak AS
  SELECT * FROM public.quartiere_zona_map;

DROP TABLE IF EXISTS civiko_zone_migration_20260720.padova_listings_zone_v_defn;
CREATE TABLE civiko_zone_migration_20260720.padova_listings_zone_v_defn (
  captured_at timestamptz NOT NULL DEFAULT now(),
  definition  text        NOT NULL
);
INSERT INTO civiko_zone_migration_20260720.padova_listings_zone_v_defn(definition)
  VALUES (pg_get_viewdef('public.padova_listings_zone_v'::regclass, true));

REVOKE ALL ON ALL TABLES IN SCHEMA civiko_zone_migration_20260720 FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA civiko_zone_migration_20260720 TO service_role;

-- 3) ALLINEAMENTO DELLE 8 RIGHE COMMERCIALI ---------------------------------
-- La FK padova_listings.commercial_zone_slug -> civiko_commercial_zones(slug)
-- e' gia' ON UPDATE CASCADE. quartiere_zona_map.zona_slug NON ha FK: viene
-- riallineato al punto 8. Aggiorniamo slug/nome/descrizione/omi_codes
-- preservando UUID e tutti i campi commerciali.

UPDATE public.civiko_commercial_zones SET
    nome = 'Centro Storico',
    descrizione = 'Consulta 1',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'centro-storico';

UPDATE public.civiko_commercial_zones SET
    slug = 'nord-arcella',
    nome = 'Nord - Arcella',
    descrizione = 'Consulta 2',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'arcella';

UPDATE public.civiko_commercial_zones SET
    slug = 'est-brenta',
    nome = 'Est - Brenta',
    descrizione = 'Consulta 3A',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'portello-stazione-stanga';

UPDATE public.civiko_commercial_zones SET
    slug = 'est-forcellini-camin',
    nome = 'Est - Forcellini / Camin',
    descrizione = 'Consulta 3B',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'torre-ponte-brenta-camin';

UPDATE public.civiko_commercial_zones SET
    slug = 'sud-est-sant-osvaldo',
    nome = 'Sud-Est - Sant''Osvaldo',
    descrizione = 'Consulta 4A',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'sant-osvaldo-facciolati';

UPDATE public.civiko_commercial_zones SET
    nome = 'Sud - Voltabarozzo / Guizza',
    descrizione = 'Consulta 4B',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'sud-voltabarozzo-guizza';

UPDATE public.civiko_commercial_zones SET
    slug = 'sud-ovest-mandria',
    nome = 'Sud-Ovest - Mandria',
    descrizione = 'Consulta 5A',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'san-carlo-san-bellino';

UPDATE public.civiko_commercial_zones SET
    slug = 'ovest-chiesanuova-brentelle',
    nome = 'Ovest - Chiesanuova / Brentelle',
    descrizione = 'Consulte 5B, 6A, 6B',
    omi_codes = ARRAY[]::text[]
  WHERE slug = 'ovest-sacra-famiglia-chiesanuova';

-- 4) NUOVA MAPPA DEDICATA quartiere -> zona commerciale ---------------------
CREATE TABLE public.civiko_quartiere_commercial_zone_map (
  quartiere_key         text        PRIMARY KEY,
  commercial_zone_slug  text        NOT NULL
    REFERENCES public.civiko_commercial_zones(slug)
    ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT civiko_quartiere_commercial_zone_map_key_not_empty
    CHECK (length(btrim(quartiere_key)) > 0)
);

GRANT ALL ON public.civiko_quartiere_commercial_zone_map TO service_role;

ALTER TABLE public.civiko_quartiere_commercial_zone_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY civiko_quartiere_commercial_zone_map_service_all
  ON public.civiko_quartiere_commercial_zone_map
  TO service_role
  USING (true) WITH CHECK (true);

INSERT INTO public.civiko_quartiere_commercial_zone_map (quartiere_key, commercial_zone_slug) VALUES
  ('centro', 'centro-storico'),
  ('centro storico', 'centro-storico'),
  ('piazze', 'centro-storico'),
  ('duomo', 'centro-storico'),
  ('santo', 'centro-storico'),
  ('santo portello', 'centro-storico'),
  ('portello', 'centro-storico'),
  ('prato della valle', 'centro-storico'),
  ('savonarola', 'centro-storico'),
  ('stazione', 'centro-storico'),
  ('stazione ferroviaria', 'centro-storico'),
  ('prato della valle universitario', 'centro-storico'),
  ('portello ognissanti', 'centro-storico'),
  ('piazze duomo', 'centro-storico'),
  ('savonarola ponte molino', 'centro-storico'),
  ('santa sofia altinate', 'centro-storico'),
  ('prato della valle pontecorvo', 'centro-storico'),
  ('portello ospedali', 'centro-storico'),
  ('riviere', 'centro-storico'),
  ('ferrovia', 'centro-storico'),
  ('specola', 'centro-storico'),
  ('specola corso milano', 'centro-storico'),
  ('piazza mazzini ospedale militare', 'centro-storico'),
  ('scrovegni', 'centro-storico'),
  ('zona entro riviere via xx settembre', 'centro-storico'),
  ('arcella', 'nord-arcella'),
  ('arcella nord', 'nord-arcella'),
  ('san bellino', 'nord-arcella'),
  ('san carlo', 'nord-arcella'),
  ('pontevigodarzere', 'nord-arcella'),
  ('nord arcella', 'nord-arcella'),
  ('pontevigodarzere ovest', 'nord-arcella'),
  ('san carlo san bellino', 'nord-arcella'),
  ('santissima trinita', 'nord-arcella'),
  ('san bellino san filippo neri', 'nord-arcella'),
  ('borgomagno prima arcella pescarotto', 'nord-arcella'),
  ('arcella sant antonino', 'nord-arcella'),
  ('fiera', 'est-brenta'),
  ('stanga', 'est-brenta'),
  ('san lazzaro', 'est-brenta'),
  ('mortise', 'est-brenta'),
  ('torre', 'est-brenta'),
  ('ponte di brenta', 'est-brenta'),
  ('est brenta', 'est-brenta'),
  ('stanga pio x', 'est-brenta'),
  ('ponte di brenta san lazzaro', 'est-brenta'),
  ('forcellini', 'est-forcellini-camin'),
  ('terranegra', 'est-forcellini-camin'),
  ('isola di terranegra', 'est-forcellini-camin'),
  ('san gregorio', 'est-forcellini-camin'),
  ('camin', 'est-forcellini-camin'),
  ('granze', 'est-forcellini-camin'),
  ('zona industriale', 'est-forcellini-camin'),
  ('zip', 'est-forcellini-camin'),
  ('interporto', 'est-forcellini-camin'),
  ('est forcellini camin', 'est-forcellini-camin'),
  ('camin san marco', 'est-forcellini-camin'),
  ('camin industriale', 'est-forcellini-camin'),
  ('forcellini terranegra', 'est-forcellini-camin'),
  ('camin sud', 'est-forcellini-camin'),
  ('s gregorio terranegra forcellini est', 'est-forcellini-camin'),
  ('citta giardino', 'sud-est-sant-osvaldo'),
  ('sant osvaldo', 'sud-est-sant-osvaldo'),
  ('s osvaldo', 'sud-est-sant-osvaldo'),
  ('santa rita', 'sud-est-sant-osvaldo'),
  ('s rita', 'sud-est-sant-osvaldo'),
  ('madonna pellegrina', 'sud-est-sant-osvaldo'),
  ('santa croce', 'sud-est-sant-osvaldo'),
  ('san paolo', 'sud-est-sant-osvaldo'),
  ('sud est sant osvaldo', 'sud-est-sant-osvaldo'),
  ('sant osvaldo facciolati', 'sud-est-sant-osvaldo'),
  ('citta giardino santa croce', 'sud-est-sant-osvaldo'),
  ('madonna pellegrina s rita nazareth sant osvaldo', 'sud-est-sant-osvaldo'),
  ('sant osvaldo san paolo', 'sud-est-sant-osvaldo'),
  ('san camillo nazareth', 'sud-est-sant-osvaldo'),
  ('voltabarozzo', 'sud-voltabarozzo-guizza'),
  ('crocefisso', 'sud-voltabarozzo-guizza'),
  ('crocifisso', 'sud-voltabarozzo-guizza'),
  ('ss crocefisso', 'sud-voltabarozzo-guizza'),
  ('salboro', 'sud-voltabarozzo-guizza'),
  ('guizza', 'sud-voltabarozzo-guizza'),
  ('bassanello', 'sud-voltabarozzo-guizza'),
  ('sud voltabarozzo guizza', 'sud-voltabarozzo-guizza'),
  ('voltabarozzo guizza', 'sud-voltabarozzo-guizza'),
  ('bassanello guizza voltabarozzo', 'sud-voltabarozzo-guizza'),
  ('sud guizza bassanello', 'sud-voltabarozzo-guizza'),
  ('crocifisso ponte quattro martiri', 'sud-voltabarozzo-guizza'),
  ('mandria', 'sud-ovest-mandria'),
  ('armistizio', 'sud-ovest-mandria'),
  ('voltabrusegana', 'sud-ovest-mandria'),
  ('paltana', 'sud-ovest-mandria'),
  ('sud ovest mandria', 'sud-ovest-mandria'),
  ('paltana mandria', 'sud-ovest-mandria'),
  ('paltana voltabrusegana mandria', 'sud-ovest-mandria'),
  ('sacra famiglia', 'ovest-chiesanuova-brentelle'),
  ('palestro', 'ovest-chiesanuova-brentelle'),
  ('san giuseppe', 'ovest-chiesanuova-brentelle'),
  ('porta trento', 'ovest-chiesanuova-brentelle'),
  ('brusegana', 'ovest-chiesanuova-brentelle'),
  ('cave', 'ovest-chiesanuova-brentelle'),
  ('chiesanuova', 'ovest-chiesanuova-brentelle'),
  ('brentelle', 'ovest-chiesanuova-brentelle'),
  ('sant ignazio', 'ovest-chiesanuova-brentelle'),
  ('monta', 'ovest-chiesanuova-brentelle'),
  ('sacro cuore', 'ovest-chiesanuova-brentelle'),
  ('altichiero', 'ovest-chiesanuova-brentelle'),
  ('ponterotto', 'ovest-chiesanuova-brentelle'),
  ('ovest chiesanuova brentelle', 'ovest-chiesanuova-brentelle'),
  ('chiesanuova brentelle', 'ovest-chiesanuova-brentelle'),
  ('ovest sacra famiglia chiesanuova brusegana altichiero', 'ovest-chiesanuova-brentelle'),
  ('brentelle chiesanuova cave', 'ovest-chiesanuova-brentelle'),
  ('san giuseppe san giovanni', 'ovest-chiesanuova-brentelle'),
  ('palestro sacra famiglia san giuseppe', 'ovest-chiesanuova-brentelle'),
  ('sacra famiglia basso isonzo', 'ovest-chiesanuova-brentelle'),
  ('chiesanuova brusegana', 'ovest-chiesanuova-brentelle'),
  ('brusegana aeroporto', 'ovest-chiesanuova-brentelle'),
  ('altichero', 'ovest-chiesanuova-brentelle'),
  ('monta sant ignazio', 'ovest-chiesanuova-brentelle'),
  ('s ignazio monta altichiero', 'ovest-chiesanuova-brentelle');

-- Verifica anti-collisione (la PK gia' impedisce duplicati, questa e' esplicita)
DO $mig$
DECLARE v_dup int;
BEGIN
  SELECT COUNT(*) INTO v_dup FROM (
    SELECT quartiere_key FROM public.civiko_quartiere_commercial_zone_map
     GROUP BY quartiere_key HAVING COUNT(DISTINCT commercial_zone_slug) > 1
  ) s;
  IF v_dup > 0 THEN
    RAISE EXCEPTION 'Collisione quartiere->slug rilevata (% chiavi).', v_dup;
  END IF;
END
$mig$;

-- 5) FUNZIONI SQL: normalizzazione + resolver fail-closed --------------------
-- Fallback ASCII per diacritici latini comuni (equivalente per gli alias
-- contrattuali a NFD+strip combining marks lato TS).
CREATE OR REPLACE FUNCTION public.civiko_ascii_fold(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT translate(
    coalesce(p_value,''),
    E'\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f2\u00f3\u00f4\u00f5\u00f6\u00f9\u00fa\u00fb\u00fc\u00e7\u00f1\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d2\u00d3\u00d4\u00d5\u00d6\u00d9\u00da\u00db\u00dc\u00c7\u00d1',
    'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN'
  )
$fn$;

CREATE OR REPLACE FUNCTION public.civiko_normalize_quartiere(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
  -- Comportamento equivalente a normalizePadovaQuartiere (TS):
  -- lowercase -> rimozione diacritici latini -> punteggiatura a spazio
  -- (superset compatibile: qualsiasi carattere non alfanumerico ASCII) ->
  -- collasso spazi -> trim. Fail-closed: nessuna inferenza testuale.
  SELECT btrim(regexp_replace(
    regexp_replace(
      lower(public.civiko_ascii_fold(p_value)),
      '[^a-z0-9]+', ' ', 'g'
    ),
    '[[:space:]]+', ' ', 'g'
  ))
$fn$;

CREATE OR REPLACE FUNCTION public.civiko_resolve_commercial_zone_slug(p_quartiere text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $fn$
  SELECT commercial_zone_slug
    FROM public.civiko_quartiere_commercial_zone_map
   WHERE quartiere_key = public.civiko_normalize_quartiere(p_quartiere)
   LIMIT 1
$fn$;

REVOKE ALL ON FUNCTION public.civiko_ascii_fold(text)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.civiko_normalize_quartiere(text)           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.civiko_resolve_commercial_zone_slug(text)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.civiko_ascii_fold(text)                   TO service_role;
GRANT EXECUTE ON FUNCTION public.civiko_normalize_quartiere(text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.civiko_resolve_commercial_zone_slug(text) TO service_role;

-- 6) TRIGGER SU padova_listings ---------------------------------------------
CREATE OR REPLACE FUNCTION public.civiko_padova_listings_zone_trg()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $trg$
DECLARE
  v_slug text;
BEGIN
  v_slug := public.civiko_resolve_commercial_zone_slug(NEW.quartiere);
  IF v_slug IS NULL THEN
    NEW.commercial_zone_slug  := NULL;
    NEW.zone_match_method     := NULL;
    NEW.zone_match_confidence := NULL;
    NEW.zone_resolved_at      := NULL;
  ELSE
    NEW.commercial_zone_slug  := v_slug;
    NEW.zone_match_method     := 'quartiere_contract_v1';
    NEW.zone_match_confidence := 1;
    NEW.zone_resolved_at      := now();
  END IF;
  RETURN NEW;
END
$trg$;

REVOKE ALL ON FUNCTION public.civiko_padova_listings_zone_trg() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS civiko_padova_listings_zone_trg ON public.padova_listings;
CREATE TRIGGER civiko_padova_listings_zone_trg
  BEFORE INSERT OR UPDATE OF quartiere, commercial_zone_slug
  ON public.padova_listings
  FOR EACH ROW EXECUTE FUNCTION public.civiko_padova_listings_zone_trg();

-- 7) BACKFILL ---------------------------------------------------------------
WITH resolved AS (
  SELECT id, public.civiko_resolve_commercial_zone_slug(quartiere) AS new_slug
    FROM public.padova_listings
)
UPDATE public.padova_listings pl
   SET commercial_zone_slug  = r.new_slug,
       zone_match_method     = CASE WHEN r.new_slug IS NULL THEN NULL ELSE 'quartiere_contract_v1' END,
       zone_match_confidence = CASE WHEN r.new_slug IS NULL THEN NULL ELSE 1 END,
       zone_resolved_at      = CASE WHEN r.new_slug IS NULL THEN NULL ELSE now() END
  FROM resolved r
 WHERE pl.id = r.id;

-- 8) LEGACY quartiere_zona_map ---------------------------------------------
-- Mantiene omi_zone_code sulle righe sicure; aggiorna zona_slug col nuovo
-- resolver; elimina le righe non risolvibili.
DELETE FROM public.quartiere_zona_map
 WHERE public.civiko_resolve_commercial_zone_slug(quartiere_key) IS NULL;

UPDATE public.quartiere_zona_map q
   SET zona_slug = public.civiko_resolve_commercial_zone_slug(q.quartiere_key)
 WHERE q.zona_slug IS DISTINCT FROM public.civiko_resolve_commercial_zone_slug(q.quartiere_key);

ALTER TABLE public.quartiere_zona_map
  ADD CONSTRAINT quartiere_zona_map_zona_slug_fkey
  FOREIGN KEY (zona_slug)
  REFERENCES public.civiko_commercial_zones(slug)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- 9) RICREA padova_listings_zone_v ------------------------------------------
-- Stesso nome, stesse colonne, stessi tipi, stessa logica per microzone/omi;
-- zone_slugs deriva esclusivamente da padova_listings.commercial_zone_slug
-- (zero o un solo slug).
CREATE OR REPLACE VIEW public.padova_listings_zone_v AS
WITH tokens AS (
  SELECT l.id,
         l.quartiere AS quartiere_raw,
         canon_quartiere(btrim(t.tok)) AS chiave
    FROM padova_listings l
    LEFT JOIN LATERAL regexp_split_to_table(COALESCE(l.quartiere, ''::text), '[,/]'::text) t(tok) ON true
   WHERE l.quartiere IS NULL OR btrim(t.tok) <> ''::text
), matched AS (
  SELECT tk.id,
         tk.quartiere_raw,
         cm.microzona,
         zm.omi_zone_code
    FROM tokens tk
    LEFT JOIN quartiere_canon_map cm ON cm.chiave = tk.chiave
    LEFT JOIN quartiere_zona_map  zm ON zm.quartiere_key = tk.chiave
)
SELECT m.id,
       max(m.quartiere_raw) AS quartiere_raw,
       COALESCE(array_agg(DISTINCT m.microzona)     FILTER (WHERE m.microzona     IS NOT NULL), '{}'::text[]) AS microzone,
       COALESCE(array_agg(DISTINCT m.omi_zone_code) FILTER (WHERE m.omi_zone_code IS NOT NULL), '{}'::text[]) AS omi_codes,
       CASE WHEN pl.commercial_zone_slug IS NULL THEN '{}'::text[]
            ELSE ARRAY[pl.commercial_zone_slug]::text[] END AS zone_slugs
  FROM matched m
  JOIN public.padova_listings pl ON pl.id = m.id
 GROUP BY m.id, pl.commercial_zone_slug;

-- 10) VINCOLI DI CONTRATTO SUI 8 SLUG ---------------------------------------
DO $mig$
DECLARE v_slugs text := $slugs$'centro-storico','nord-arcella','est-brenta','est-forcellini-camin','sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria','ovest-chiesanuova-brentelle'$slugs$;
BEGIN
  EXECUTE format(
    'ALTER TABLE public.civiko_commercial_zones
       ADD CONSTRAINT civiko_commercial_zones_slug_contract_chk
       CHECK (slug IN (%s))', v_slugs);
  EXECUTE format(
    'ALTER TABLE public.padova_listings
       ADD CONSTRAINT padova_listings_commercial_zone_slug_contract_chk
       CHECK (commercial_zone_slug IS NULL OR commercial_zone_slug IN (%s))', v_slugs);
  EXECUTE format(
    'ALTER TABLE public.quartiere_zona_map
       ADD CONSTRAINT quartiere_zona_map_zona_slug_contract_chk
       CHECK (zona_slug IN (%s))', v_slugs);
  EXECUTE format(
    'ALTER TABLE public.civiko_quartiere_commercial_zone_map
       ADD CONSTRAINT civiko_quartiere_commercial_zone_map_slug_contract_chk
       CHECK (commercial_zone_slug IN (%s))', v_slugs);
END
$mig$;

-- 11) CONTENDIBILI_COUNT ----------------------------------------------------
WITH counts AS (
  SELECT public.civiko_resolve_commercial_zone_slug(quartiere) AS slug, COUNT(*) AS n
    FROM public.padova_contendibili
   WHERE public.civiko_resolve_commercial_zone_slug(quartiere) IS NOT NULL
   GROUP BY 1
)
UPDATE public.civiko_commercial_zones z
   SET contendibili_count = COALESCE(c.n, 0)
  FROM public.civiko_commercial_zones z2
  LEFT JOIN counts c ON c.slug = z2.slug
 WHERE z.slug = z2.slug;

-- 12) VALIDAZIONI FINALI BLOCCANTI ------------------------------------------
DO $mig$
DECLARE
  v_expected text[] := ARRAY[
    'centro-storico','nord-arcella','est-brenta','est-forcellini-camin',
    'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria',
    'ovest-chiesanuova-brentelle'
  ]::text[];
  v_actual        text[];
  v_bad           int;
  v_total_before  int;
  v_total_after   int;
  v_bak_row       record;
  v_now_row       record;
BEGIN
  SELECT array_agg(slug ORDER BY slug) INTO v_actual FROM public.civiko_commercial_zones;
  IF (SELECT array_agg(x ORDER BY x) FROM unnest(v_expected) x) <> v_actual THEN
    RAISE EXCEPTION 'Post-check: slug finali non coincidono col contratto. Trovati=%', v_actual;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM public.padova_listings pl
   WHERE pl.commercial_zone_slug IS DISTINCT FROM public.civiko_resolve_commercial_zone_slug(pl.quartiere);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Post-check: % listing con slug incoerente col resolver.', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM public.quartiere_zona_map q
   WHERE q.zona_slug IS DISTINCT FROM public.civiko_resolve_commercial_zone_slug(q.quartiere_key);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Post-check: % righe di quartiere_zona_map incoerenti col resolver.', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad
    FROM public.civiko_quartiere_commercial_zone_map
   WHERE commercial_zone_slug <> ALL(v_expected);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Post-check: % righe della nuova mappa con slug non ufficiale.', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_total_before FROM civiko_zone_migration_20260720.padova_listings_zoning_bak;
  SELECT COUNT(*) INTO v_total_after  FROM public.padova_listings;
  IF v_total_before <> v_total_after THEN
    RAISE EXCEPTION 'Post-check: numero listing cambiato (before=%, after=%).', v_total_before, v_total_after;
  END IF;

  FOR v_bak_row IN
    SELECT id, status, agency_id, trial_agency_id, trial_reserved_until,
           occupied_agency_id, occupied_since, tier, canone_mese_eur,
           stripe_price_id, created_at
      FROM civiko_zone_migration_20260720.civiko_commercial_zones_bak
  LOOP
    SELECT status, agency_id, trial_agency_id, trial_reserved_until,
           occupied_agency_id, occupied_since, tier, canone_mese_eur,
           stripe_price_id, created_at
      INTO v_now_row
      FROM public.civiko_commercial_zones
     WHERE id = v_bak_row.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Post-check: riga commerciale scomparsa (id=%).', v_bak_row.id;
    END IF;
    IF v_now_row.status               IS DISTINCT FROM v_bak_row.status
       OR v_now_row.agency_id            IS DISTINCT FROM v_bak_row.agency_id
       OR v_now_row.trial_agency_id      IS DISTINCT FROM v_bak_row.trial_agency_id
       OR v_now_row.trial_reserved_until IS DISTINCT FROM v_bak_row.trial_reserved_until
       OR v_now_row.occupied_agency_id   IS DISTINCT FROM v_bak_row.occupied_agency_id
       OR v_now_row.occupied_since       IS DISTINCT FROM v_bak_row.occupied_since
       OR v_now_row.tier                 IS DISTINCT FROM v_bak_row.tier
       OR v_now_row.canone_mese_eur      IS DISTINCT FROM v_bak_row.canone_mese_eur
       OR v_now_row.stripe_price_id      IS DISTINCT FROM v_bak_row.stripe_price_id
       OR v_now_row.created_at           IS DISTINCT FROM v_bak_row.created_at
    THEN
      RAISE EXCEPTION 'Post-check: campi commerciali modificati per id=%.', v_bak_row.id;
    END IF;
  END LOOP;
  -- centro-storico: l'eventuale trial/occupazione e' preservata dallo stesso check qui sopra.

  SELECT COUNT(*) INTO v_bad
    FROM public.padova_listings_zone_v
   WHERE COALESCE(array_length(zone_slugs,1),0) > 1;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Post-check: % righe della view con piu di uno zone_slug.', v_bad;
  END IF;
END
$mig$;

-- 13) OUTPUT ----------------------------------------------------------------
WITH per_zone AS (
  SELECT z.slug,
         z.nome,
         z.status,
         z.trial_agency_id,
         z.occupied_agency_id,
         (SELECT COUNT(*) FROM public.padova_listings pl
           WHERE pl.commercial_zone_slug = z.slug) AS listings_classificati,
         z.contendibili_count AS contendibili
    FROM public.civiko_commercial_zones z
), unresolved AS (
  SELECT '__UNRESOLVED__'::text AS slug,
         NULL::text  AS nome,
         NULL::text  AS status,
         NULL::uuid  AS trial_agency_id,
         NULL::uuid  AS occupied_agency_id,
         (SELECT COUNT(*) FROM public.padova_listings WHERE commercial_zone_slug IS NULL) AS listings_classificati,
         (SELECT COUNT(*) FROM public.padova_contendibili
           WHERE public.civiko_resolve_commercial_zone_slug(quartiere) IS NULL) AS contendibili
)
SELECT result.*
FROM (
  SELECT * FROM per_zone
  UNION ALL
  SELECT * FROM unresolved
) AS result
ORDER BY
  CASE WHEN result.slug = '__UNRESOLVED__' THEN 1 ELSE 0 END,
  result.slug;

COMMIT;
