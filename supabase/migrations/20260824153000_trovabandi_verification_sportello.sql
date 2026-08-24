-- TrovaBandi — SPORTELLO: misura ufficiale a sportello senza data di chiusura.
-- verification_status = SPORTELLO, deadline_at resta NULL.
-- Non tocca Civiko / Padova.

ALTER TABLE public.trovabandi_opportunities
  DROP CONSTRAINT IF EXISTS trovabandi_opportunities_verification_status_check;

ALTER TABLE public.trovabandi_opportunities
  ADD CONSTRAINT trovabandi_opportunities_verification_status_check
  CHECK (verification_status IN (
    'VERIFICATO',
    'PARZIALE',
    'DA_VERIFICARE',
    'SCADUTO',
    'RITIRATO',
    'SPORTELLO'
  ));
