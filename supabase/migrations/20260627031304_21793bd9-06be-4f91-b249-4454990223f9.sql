CREATE INDEX IF NOT EXISTS idx_omi_valori_comune_lower
  ON public.omi_valori (lower(comune_descrizione));

CREATE INDEX IF NOT EXISTS idx_omi_valori_provincia_lower
  ON public.omi_valori (lower(provincia));