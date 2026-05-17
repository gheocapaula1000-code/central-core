DELETE FROM public.normalized_opportunities
  WHERE source_name IN ('osm-overpass:padova-construction', 'osm-overpass:padova-territory');
DELETE FROM public.raw_sources_ingest
  WHERE source_name LIKE 'osm-overpass:padova-%';