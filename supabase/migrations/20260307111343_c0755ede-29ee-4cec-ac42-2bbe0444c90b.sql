
CREATE TABLE IF NOT EXISTS omi_zone (
  id BIGSERIAL PRIMARY KEY,
  area_territoriale TEXT,
  regione TEXT,
  provincia TEXT NOT NULL,
  comune_istat TEXT NOT NULL,
  comune_catastale TEXT,
  sezione TEXT,
  comune_amm TEXT,
  comune_descrizione TEXT NOT NULL,
  fascia TEXT,
  zona_descr TEXT,
  zona TEXT NOT NULL,
  link_zona TEXT NOT NULL UNIQUE,
  cod_tip_prev INTEGER,
  descr_tip_prev TEXT,
  stato_prev TEXT,
  microzona INTEGER,
  semestre TEXT DEFAULT '2025/1',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_omi_zone_provincia ON omi_zone(provincia);
CREATE INDEX idx_omi_zone_comune ON omi_zone(comune_descrizione);
CREATE INDEX idx_omi_zone_link ON omi_zone(link_zona);
CREATE INDEX idx_omi_zone_comune_istat ON omi_zone(comune_istat);

CREATE TABLE IF NOT EXISTS omi_valori (
  id BIGSERIAL PRIMARY KEY,
  area_territoriale TEXT,
  regione TEXT,
  provincia TEXT NOT NULL,
  comune_istat TEXT NOT NULL,
  comune_catastale TEXT,
  sezione TEXT,
  comune_amm TEXT,
  comune_descrizione TEXT NOT NULL,
  fascia TEXT,
  zona TEXT NOT NULL,
  link_zona TEXT NOT NULL,
  cod_tip INTEGER,
  descr_tipologia TEXT NOT NULL,
  stato TEXT,
  stato_prev TEXT,
  compr_min NUMERIC,
  compr_max NUMERIC,
  sup_nl_compr TEXT,
  loc_min NUMERIC,
  loc_max NUMERIC,
  sup_nl_loc TEXT,
  semestre TEXT DEFAULT '2025/1',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_omi_valori_link_zona ON omi_valori(link_zona);
CREATE INDEX idx_omi_valori_provincia ON omi_valori(provincia);
CREATE INDEX idx_omi_valori_comune ON omi_valori(comune_descrizione);
CREATE INDEX idx_omi_valori_tipologia ON omi_valori(cod_tip);
CREATE INDEX idx_omi_valori_comune_istat ON omi_valori(comune_istat);
