
ALTER TABLE omi_zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE omi_valori ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read access on omi_zone" ON omi_zone FOR SELECT USING (true);
CREATE POLICY "Allow public read access on omi_valori" ON omi_valori FOR SELECT USING (true);
