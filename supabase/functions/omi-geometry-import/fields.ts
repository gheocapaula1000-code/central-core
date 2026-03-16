// ── Field name aliases and normalization for OMI properties ──

export const ZONA_ALIASES = ["COD_ZON", "cod_zon", "zona", "ZONA", "codice_zona", "CODICE_ZONA", "zone_code", "CODZONA", "CodZona", "codzona"];
export const DESCR_ALIASES = ["DESCR_ZON", "descr_zon", "zona_descr", "ZONA_DESCR", "descrizione", "name"];
export const ISTAT_ALIASES = ["COM_ISTAT", "com_istat", "comune_istat", "COMUNE_ISTAT", "cod_com", "COD_COM", "ISTAT"];
export const COMUNE_ALIASES = ["COM_DESCR", "com_descr", "comune_descrizione", "COMUNE_DESCRIZIONE", "comune", "COMUNE"];
export const PROV_ALIASES = ["PROV", "prov", "provincia", "PROVINCIA", "sigla_prov"];
export const LINK_ALIASES = ["LINK_ZONA", "link_zona", "linkzona", "LINKZONA"];
export const CATASTALE_ALIASES = ["COM_CAT", "com_cat", "comune_catastale", "COMUNE_CATASTALE", "cod_catastale", "COD_CATASTALE", "CODCOM", "CodCom", "codcom"];

export function findField(props: Record<string, unknown>, aliases: string[]): string | null {
  for (const alias of aliases) {
    if (props[alias] != null && String(props[alias]).trim() !== "") {
      return String(props[alias]).trim();
    }
  }
  return null;
}

export interface ParsedFeature {
  link_zona: string;
  zona: string;
  zona_descr: string | null;
  comune_istat: string;
  comune_descrizione: string;
  provincia: string;
  geojson: string;
}
