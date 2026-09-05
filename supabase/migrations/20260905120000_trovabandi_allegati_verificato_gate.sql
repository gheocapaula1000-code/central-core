-- TrovaBandi — allegati strutturati fail-closed + gate VERIFICATO.
-- allegati = [{nome, url?, obbligatorio}] solo se la fonte ufficiale li noma.
-- Mai inventare nomi file. Non tocca Civiko / Padova.
-- Non applicare su central-core-prod (progetto org vuoto/in pausa).

ALTER TABLE public.trovabandi_opportunities
  ADD COLUMN IF NOT EXISTS allegati jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.trovabandi_opportunities
  DROP CONSTRAINT IF EXISTS trovabandi_opportunities_allegati_is_array;

ALTER TABLE public.trovabandi_opportunities
  ADD CONSTRAINT trovabandi_opportunities_allegati_is_array
  CHECK (jsonb_typeof(allegati) = 'array');

COMMENT ON COLUMN public.trovabandi_opportunities.allegati IS
  'Allegati ufficiali attestati [{nome, url?, obbligatorio}]. Vuoto se la fonte non li noma. Mai inventati.';
