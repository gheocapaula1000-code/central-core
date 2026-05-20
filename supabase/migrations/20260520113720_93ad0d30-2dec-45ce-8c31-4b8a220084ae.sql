UPDATE public.legal_life_event_signals
SET confidence = 'alta', updated_at = now()
WHERE signal_type = 'AUCTION_CONFIRMATION'
  AND confidence <> 'alta'
  AND (source_name ILIKE '%astalegale%' OR source_name ILIKE '%asteimmobili%' OR source_name ILIKE '%pvp%' OR source_name ILIKE '%portale%vendite%');