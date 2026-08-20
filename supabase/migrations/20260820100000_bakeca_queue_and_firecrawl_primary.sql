-- Live Core (jpunnzgixcghuydstdlt) only.
-- 1) Allow bakeca.it in process_padova_portal_collect_v2 (never ran; not in fonte).
-- 2) Document Firecrawl as the live Immobiliare/Idealista/Subito-soft path.
-- Does not target central-core-prod. Does not invent listings or permits.
-- Does not embed secrets.

DO $$
DECLARE
  def text;
  fn_oid oid;
BEGIN
  SELECT p.oid
    INTO fn_oid
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'process_padova_portal_collect_v2'
   ORDER BY p.pronargs DESC
   LIMIT 1;

  IF fn_oid IS NULL THEN
    RAISE NOTICE 'process_padova_portal_collect_v2 missing — skip bakeca allowlist';
    RETURN;
  END IF;

  def := pg_get_functiondef(fn_oid);
  IF def ILIKE '%bakeca.it%' THEN
    RAISE NOTICE 'bakeca.it already in process_padova_portal_collect_v2';
    RETURN;
  END IF;

  def := replace(
    def,
    '''immobiliare.it'',''idealista.it'',''casa.it'',''subito.it''',
    '''immobiliare.it'',''idealista.it'',''casa.it'',''subito.it'',''bakeca.it'''
  );
  def := replace(
    def,
    '''immobiliare.it'', ''idealista.it'', ''casa.it'', ''subito.it''',
    '''immobiliare.it'', ''idealista.it'', ''casa.it'', ''subito.it'', ''bakeca.it'''
  );

  IF def NOT ILIKE '%bakeca.it%' THEN
    RAISE EXCEPTION 'could not patch process_padova_portal_collect_v2 allowlist for bakeca.it';
  END IF;

  EXECUTE def;
END $$;
