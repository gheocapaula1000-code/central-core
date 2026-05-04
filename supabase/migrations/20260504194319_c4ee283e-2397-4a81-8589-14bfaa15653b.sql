
ALTER TABLE public.market_anomalies DROP CONSTRAINT IF EXISTS market_anomalies_anomaly_type_check;
ALTER TABLE public.market_anomalies ADD CONSTRAINT market_anomalies_anomaly_type_check
  CHECK (anomaly_type = ANY (ARRAY[
    'cross_portal_reappear','agency_swap','price_jump_after_disappear','duplicate_listing',
    'ribasso','omi_gap_alto','omi_gap_basso','giacenza_lunga','cluster_ribassi','stock_anomalo'
  ]));
