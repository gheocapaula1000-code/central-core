-- Tabella microzona_dossier: snapshot versionati dello stato di una microzona
CREATE TABLE public.microzona_dossier (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  microzona_id TEXT NOT NULL,
  versione TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  stato TEXT NOT NULL CHECK (stato IN ('approvata_interna', 'pubblicabile', 'pubblicata')),
  servizi_prossimita JSONB NOT NULL DEFAULT '[]'::jsonb,
  segnali_territoriali JSONB NOT NULL DEFAULT '[]'::jsonb,
  opportunita_candidate JSONB NOT NULL DEFAULT '[]'::jsonb,
  asset_osservati JSONB NOT NULL DEFAULT '[]'::jsonb,
  note_interne TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID
);

-- Indice per interrogare la storia delle versioni di una microzona
CREATE INDEX idx_microzona_dossier_microzona_versione
  ON public.microzona_dossier (microzona_id, versione DESC);

-- Trigger per popolare created_by dall'utente autenticato se non fornito
CREATE OR REPLACE FUNCTION public.set_microzona_dossier_created_by()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER tr_microzona_dossier_created_by
BEFORE INSERT ON public.microzona_dossier
FOR EACH ROW
EXECUTE FUNCTION public.set_microzona_dossier_created_by();

-- Commenti minimali
COMMENT ON TABLE public.microzona_dossier IS 'Snapshot versionati dello stato di una microzona. Append-only per design.';
COMMENT ON COLUMN public.microzona_dossier.microzona_id IS 'Identificativo microzona, es. "arcella"';
COMMENT ON COLUMN public.microzona_dossier.versione IS 'Timestamp dello snapshot, parte della chiave logica di versione';
COMMENT ON COLUMN public.microzona_dossier.stato IS 'Stato del dossier: approvata_interna, pubblicabile, pubblicata';
COMMENT ON COLUMN public.microzona_dossier.servizi_prossimita IS 'Dati normalizzati dei servizi di prossimità';
COMMENT ON COLUMN public.microzona_dossier.segnali_territoriali IS 'Dati normalizzati dei segnali territoriali';
COMMENT ON COLUMN public.microzona_dossier.opportunita_candidate IS 'Dati normalizzati delle opportunità candidate';
COMMENT ON COLUMN public.microzona_dossier.asset_osservati IS 'Dati normalizzati degli asset osservati';
COMMENT ON COLUMN public.microzona_dossier.note_interne IS 'Note interne, max ~350 caratteri logici';
COMMENT ON COLUMN public.microzona_dossier.created_by IS 'Utente Core che ha creato lo snapshot, per audit e future policy RLS';