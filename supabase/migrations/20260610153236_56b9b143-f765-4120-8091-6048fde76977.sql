CREATE TABLE public.padova_listings (
  id bigserial PRIMARY KEY,
  fonte text NOT NULL,
  url text,
  agency text,
  tipo_lead text,
  telefono text,
  mq integer,
  locali integer,
  bagni integer,
  prezzo integer,
  lat double precision,
  lng double precision,
  indirizzo text,
  quartiere text,
  raw_json jsonb,
  imported_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.padova_listings TO authenticated;
GRANT ALL ON public.padova_listings TO service_role;

ALTER TABLE public.padova_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "padova_listings admin select"
  ON public.padova_listings FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX padova_listings_match_idx
  ON public.padova_listings (lower(indirizzo), mq, locali);
CREATE INDEX padova_listings_fonte_idx ON public.padova_listings (fonte);