
CREATE TABLE istat_comuni (
  id BIGSERIAL PRIMARY KEY,
  codice_istat TEXT NOT NULL UNIQUE,
  comune TEXT NOT NULL,
  popolazione INTEGER,
  eta_media NUMERIC,
  percentuale_under18 NUMERIC,
  percentuale_under35 NUMERIC,
  percentuale_over65 NUMERIC,
  maschi INTEGER,
  femmine INTEGER,
  anno INTEGER DEFAULT 2025
);
CREATE INDEX idx_istat_comune ON istat_comuni(comune);
ALTER TABLE istat_comuni ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read istat" ON istat_comuni FOR SELECT USING (true);

CREATE TABLE ispra_rischio (
  id BIGSERIAL PRIMARY KEY,
  codice_istat TEXT NOT NULL UNIQUE,
  comune TEXT NOT NULL,
  superficie_kmq NUMERIC,
  idro_p3_perc NUMERIC,
  idro_p2_perc NUMERIC,
  idro_p1_perc NUMERIC,
  pop_idro_p3 INTEGER,
  pop_idro_p2 INTEGER,
  pop_idro_p1 INTEGER,
  frana_p4_perc NUMERIC,
  frana_p3_perc NUMERIC,
  frana_p2_perc NUMERIC,
  frana_p1_perc NUMERIC,
  pop_frana_p3p4 INTEGER
);
CREATE INDEX idx_ispra_comune ON ispra_rischio(comune);
ALTER TABLE ispra_rischio ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public read ispra" ON ispra_rischio FOR SELECT USING (true);
