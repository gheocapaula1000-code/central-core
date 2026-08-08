-- ═══════════════════════════════════════════════════════════════
-- Civiko One — Territory Contract v2 (8 zone definitive)
-- centro-storico, sud-est-sant-osvaldo, est-brenta, sud-ovest-mandria,
-- sud-voltabarozzo-guizza, nord-arcella, ovest-chiesanuova-brentelle, nord-est
-- est-forcellini-camin = LEGACY, rimossa.
-- ═══════════════════════════════════════════════════════════════

-- 0) Backup fail-safe delle righe toccate
CREATE TABLE IF NOT EXISTS public._bkp_20260808_zone_contract_v2 (
  src_table text NOT NULL,
  row_id text NOT NULL,
  quartiere text,
  old_slug text,
  captured_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public._bkp_20260808_zone_contract_v2 TO service_role;

INSERT INTO public._bkp_20260808_zone_contract_v2 (src_table, row_id, quartiere, old_slug)
SELECT 'padova_listings', id::text, quartiere, commercial_zone_slug
  FROM public.padova_listings WHERE commercial_zone_slug = 'est-forcellini-camin';
INSERT INTO public._bkp_20260808_zone_contract_v2 (src_table, row_id, quartiere, old_slug)
SELECT 'padova_cambi_agenzia', id::text, quartiere, commercial_zone_slug
  FROM public.padova_cambi_agenzia WHERE commercial_zone_slug = 'est-forcellini-camin';
INSERT INTO public._bkp_20260808_zone_contract_v2 (src_table, row_id, quartiere, old_slug)
SELECT 'padova_multi_portale_quarantena', id::text, quartiere, commercial_zone_slug
  FROM public.padova_multi_portale_quarantena WHERE commercial_zone_slug = 'est-forcellini-camin';

-- 1) Allarga temporaneamente i CHECK (vecchio + nuovo) per poter migrare
ALTER TABLE public.civiko_commercial_zones DROP CONSTRAINT IF EXISTS civiko_commercial_zones_slug_contract_chk;
ALTER TABLE public.padova_listings DROP CONSTRAINT IF EXISTS padova_listings_commercial_zone_slug_contract_chk;
ALTER TABLE public.quartiere_zona_map DROP CONSTRAINT IF EXISTS quartiere_zona_map_zona_slug_contract_chk;
ALTER TABLE public.civiko_quartiere_commercial_zone_map DROP CONSTRAINT IF EXISTS civiko_quartiere_commercial_zone_map_slug_contract_chk;

-- 2) Nuova zona ufficiale nord-est (nessun prezzo Stripe, checkout non attivo)
INSERT INTO public.civiko_commercial_zones (slug, nome, descrizione, omi_codes, canone_mese_eur, tier, status, stripe_price_id, attiva)
VALUES (
  'nord-est',
  'Nord-Est',
  'Comune di Padova: Forcellini, Terranegra, San Gregorio. Esclusi Noventa Padovana e Saonara.',
  ARRAY['D8']::text[],
  1990,
  'standard',
  'disponibile',
  NULL,
  true
)
ON CONFLICT (slug) DO UPDATE
  SET nome = EXCLUDED.nome,
      descrizione = EXCLUDED.descrizione,
      omi_codes = EXCLUDED.omi_codes,
      canone_mese_eur = EXCLUDED.canone_mese_eur,
      tier = EXCLUDED.tier,
      stripe_price_id = NULL;

-- Est - Brenta: perimetro aggiornato (assorbe Camin / ZIP / Interporto / Granze)
UPDATE public.civiko_commercial_zones
   SET nome = 'Est - Brenta',
       descrizione = 'Mortise, Torre, Ponte di Brenta, San Lazzaro, Stanga, Camin, Fiera, Zona Industriale/ZIP, Interporto, Granze.',
       omi_codes = ARRAY['D4','D7','E1','E2','C2']::text[]
 WHERE slug = 'est-brenta';

-- Prezzi autoritativi: premium 2990 (centro-storico, sud-est-sant-osvaldo), standard 1990
UPDATE public.civiko_commercial_zones
   SET tier = 'premium', canone_mese_eur = 2990
 WHERE slug IN ('centro-storico','sud-est-sant-osvaldo');
UPDATE public.civiko_commercial_zones
   SET tier = 'standard', canone_mese_eur = 1990
 WHERE slug NOT IN ('centro-storico','sud-est-sant-osvaldo','est-forcellini-camin');
UPDATE public.civiko_commercial_zones SET stripe_price_id = NULL WHERE stripe_price_id IS NOT NULL;

-- 3) Mapping quartiere → zona (chiavi già normalizzate)
--    Nord-Est: solo alias non ambigui interni al Comune di Padova
UPDATE public.civiko_quartiere_commercial_zone_map
   SET commercial_zone_slug = 'nord-est'
 WHERE quartiere_key IN (
   'forcellini','terranegra','isola di terranegra','san gregorio',
   'forcellini terranegra','s gregorio terranegra forcellini est'
 );

INSERT INTO public.civiko_quartiere_commercial_zone_map (quartiere_key, commercial_zone_slug)
VALUES ('nord est','nord-est')
ON CONFLICT (quartiere_key) DO UPDATE SET commercial_zone_slug = EXCLUDED.commercial_zone_slug;

--    Est-Brenta: Camin e comparto industriale est
UPDATE public.civiko_quartiere_commercial_zone_map
   SET commercial_zone_slug = 'est-brenta'
 WHERE quartiere_key IN (
   'camin','camin industriale','camin sud','camin san marco',
   'granze','interporto','zip','zona industriale','zona industriale zip'
 );

--    Composito che attraversa due zone → non assegnabile (fail-closed)
DELETE FROM public.civiko_quartiere_commercial_zone_map
 WHERE quartiere_key IN ('est forcellini camin');

-- quartiere_zona_map (legacy alias con punteggiatura)
UPDATE public.quartiere_zona_map SET zona_slug = 'nord-est'
 WHERE quartiere_key IN ('forcellini','terranegra','san gregorio');
UPDATE public.quartiere_zona_map SET zona_slug = 'est-brenta'
 WHERE quartiere_key IN ('camin / san marco','camin industriale','camin','camin sud');

-- 4) Riclassificazione record esistenti: SOLO via quartiere non ambiguo.
--    Nessuna invenzione: quartiere assente/ambiguo → NULL (quarantena logica).
UPDATE public.padova_listings l
   SET commercial_zone_slug = m.commercial_zone_slug
  FROM public.civiko_quartiere_commercial_zone_map m
 WHERE l.commercial_zone_slug = 'est-forcellini-camin'
   AND m.quartiere_key = public.civiko_normalize_quartiere(l.quartiere);

UPDATE public.padova_listings
   SET commercial_zone_slug = NULL
 WHERE commercial_zone_slug = 'est-forcellini-camin';

UPDATE public.padova_cambi_agenzia c
   SET commercial_zone_slug = m.commercial_zone_slug
  FROM public.civiko_quartiere_commercial_zone_map m
 WHERE c.commercial_zone_slug = 'est-forcellini-camin'
   AND m.quartiere_key = public.civiko_normalize_quartiere(c.quartiere);
UPDATE public.padova_cambi_agenzia
   SET commercial_zone_slug = NULL
 WHERE commercial_zone_slug = 'est-forcellini-camin';

UPDATE public.padova_multi_portale_quarantena q
   SET commercial_zone_slug = m.commercial_zone_slug
  FROM public.civiko_quartiere_commercial_zone_map m
 WHERE q.commercial_zone_slug = 'est-forcellini-camin'
   AND m.quartiere_key = public.civiko_normalize_quartiere(q.quartiere);
UPDATE public.padova_multi_portale_quarantena
   SET commercial_zone_slug = NULL
 WHERE commercial_zone_slug = 'est-forcellini-camin';

UPDATE public.padova_contendibili c
   SET commercial_zone_slug = m.commercial_zone_slug
  FROM public.civiko_quartiere_commercial_zone_map m
 WHERE c.commercial_zone_slug = 'est-forcellini-camin'
   AND m.quartiere_key = public.civiko_normalize_quartiere(c.quartiere);
UPDATE public.padova_contendibili
   SET commercial_zone_slug = NULL
 WHERE commercial_zone_slug = 'est-forcellini-camin';

UPDATE public.padova_multi_portale p
   SET commercial_zone_slug = m.commercial_zone_slug
  FROM public.civiko_quartiere_commercial_zone_map m
 WHERE p.commercial_zone_slug = 'est-forcellini-camin'
   AND m.quartiere_key = public.civiko_normalize_quartiere(p.quartiere);
UPDATE public.padova_multi_portale
   SET commercial_zone_slug = NULL
 WHERE commercial_zone_slug = 'est-forcellini-camin';

UPDATE public.padova_contendibili_quarantena q
   SET commercial_zone_slug = m.commercial_zone_slug
  FROM public.civiko_quartiere_commercial_zone_map m
 WHERE q.commercial_zone_slug = 'est-forcellini-camin'
   AND m.quartiere_key = public.civiko_normalize_quartiere(q.quartiere);
UPDATE public.padova_contendibili_quarantena
   SET commercial_zone_slug = NULL
 WHERE commercial_zone_slug = 'est-forcellini-camin';

UPDATE public.civiko_contendibili_evidence_attempts
   SET commercial_zone_slug = NULL
 WHERE commercial_zone_slug = 'est-forcellini-camin';

-- 5) Rimozione definitiva della zona legacy dal contratto
DELETE FROM public.civiko_commercial_zones WHERE slug = 'est-forcellini-camin';

-- 6) CHECK definitivi sulle 8 zone finali
ALTER TABLE public.civiko_commercial_zones
  ADD CONSTRAINT civiko_commercial_zones_slug_contract_chk
  CHECK (slug = ANY (ARRAY['centro-storico','nord-arcella','est-brenta','nord-est',
    'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria','ovest-chiesanuova-brentelle']));

ALTER TABLE public.padova_listings
  ADD CONSTRAINT padova_listings_commercial_zone_slug_contract_chk
  CHECK (commercial_zone_slug IS NULL OR commercial_zone_slug = ANY (ARRAY['centro-storico','nord-arcella','est-brenta','nord-est',
    'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria','ovest-chiesanuova-brentelle']));

ALTER TABLE public.quartiere_zona_map
  ADD CONSTRAINT quartiere_zona_map_zona_slug_contract_chk
  CHECK (zona_slug = ANY (ARRAY['centro-storico','nord-arcella','est-brenta','nord-est',
    'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria','ovest-chiesanuova-brentelle']));

ALTER TABLE public.civiko_quartiere_commercial_zone_map
  ADD CONSTRAINT civiko_quartiere_commercial_zone_map_slug_contract_chk
  CHECK (commercial_zone_slug = ANY (ARRAY['centro-storico','nord-arcella','est-brenta','nord-est',
    'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria','ovest-chiesanuova-brentelle']));

-- PWA sync ack: nuovo contratto valido per le righe future (storico preservato)
ALTER TABLE public.civiko_pwa_sync_acks DROP CONSTRAINT IF EXISTS civiko_pwa_sync_acks_zone_slugs_ck;
ALTER TABLE public.civiko_pwa_sync_acks
  ADD CONSTRAINT civiko_pwa_sync_acks_zone_slugs_ck
  CHECK (
    array_length(commercial_zone_slugs, 1) = 8
    AND commercial_zone_slugs <@ ARRAY['centro-storico','nord-arcella','est-brenta','nord-est',
      'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria','ovest-chiesanuova-brentelle']
    AND ARRAY['centro-storico','nord-arcella','est-brenta','nord-est',
      'sud-est-sant-osvaldo','sud-voltabarozzo-guizza','sud-ovest-mandria','ovest-chiesanuova-brentelle'] <@ commercial_zone_slugs
  ) NOT VALID;

-- 7) Funzioni DB allineate al contratto v2
CREATE OR REPLACE FUNCTION public.civiko_is_official_zone_slug(p_slug text)
 RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $function$
  SELECT btrim(coalesce(p_slug, '')) IN (
    'centro-storico','nord-arcella','est-brenta','nord-est',
    'sud-est-sant-osvaldo','sud-voltabarozzo-guizza',
    'sud-ovest-mandria','ovest-chiesanuova-brentelle'
  )
$function$;

CREATE OR REPLACE FUNCTION public.civiko_cambi_zone_slug(_curl text, _quartiere text)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT s FROM (
    SELECT COALESCE(
      (SELECT p.commercial_zone_slug
         FROM public.padova_listings p
        WHERE _curl IS NOT NULL
          AND public.canon_url(p.url) = _curl
          AND p.commercial_zone_slug IS NOT NULL
        ORDER BY p.last_seen_at DESC NULLS LAST, p.id DESC
        LIMIT 1),
      public.civiko_resolve_commercial_zone_slug(_quartiere)
    ) AS s
  ) q
  WHERE public.civiko_is_official_zone_slug(s);
$function$;