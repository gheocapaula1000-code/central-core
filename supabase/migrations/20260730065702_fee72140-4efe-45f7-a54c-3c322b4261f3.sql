DO $qa$
DECLARE
  v_defa text;
  v_defr text;
  v_msg text;
BEGIN
  -- ── Assert statico: ordine lock ZONA prima di AGENZIA in entrambe le RPC ──
  SELECT pg_get_functiondef(p.oid) INTO v_defa FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='civiko_activate_paid_zone_atomic';
  SELECT pg_get_functiondef(p.oid) INTO v_defr FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='civiko_release_zone_on_cancel_atomic';
  IF position('civiko_zone:' in v_defa) = 0 OR position('civiko_agency:' in v_defa) = 0
     OR position('civiko_zone:' in v_defa) > position('civiko_agency:' in v_defa) THEN
    RAISE EXCEPTION 'QA FAILED: activate lock order';
  END IF;
  IF position('civiko_zone:' in v_defr) = 0 OR position('civiko_agency:' in v_defr) = 0
     OR position('civiko_zone:' in v_defr) > position('civiko_agency:' in v_defr) THEN
    RAISE EXCEPTION 'QA FAILED: release lock order';
  END IF;

  BEGIN
    DECLARE
      a1 uuid; a2 uuid;
      z_status text; z_agency uuid; z_since timestamptz; z_since2 timestamptz;
      r jsonb;
      n int;
    BEGIN
      INSERT INTO public.agencies(name) VALUES ('QA9E2 A1') RETURNING id INTO a1;
      INSERT INTO public.agencies(name) VALUES ('QA9E2 A2') RETURNING id INTO a2;

      -- reset zona pilot a disponibile per lo scenario
      UPDATE public.civiko_commercial_zones
         SET status='disponibile', occupied_agency_id=NULL, occupied_since=NULL,
             agency_id=NULL, trial_agency_id=NULL, trial_reserved_until=NULL
       WHERE slug='centro-storico';

      -- Scenario A: attivazione base
      r := public.civiko_activate_paid_zone_atomic(
             a1,'centro-storico','cus_qa9e2_1','sub_qa9e2_old','active',
             'price_qa','premium','monthly','qa@example.test', now()+interval '30 days', NULL, false,'civiko_one');
      IF (r->>'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'QA FAILED: activate base %', r; END IF;
      SELECT status, occupied_agency_id, occupied_since INTO z_status, z_agency, z_since
        FROM public.civiko_commercial_zones WHERE slug='centro-storico';
      IF z_status <> 'occupata' OR z_agency <> a1 THEN RAISE EXCEPTION 'QA FAILED: zone not occupied'; END IF;

      -- Scenario E: customer già di altra agenzia → zero scritture
      SELECT count(*) INTO n FROM public.billing_subscriptions;
      r := public.civiko_activate_paid_zone_atomic(
             a2,'centro-storico','cus_qa9e2_1','sub_qa9e2_other','active',
             'price_qa','premium','monthly',NULL,NULL,NULL,false,'civiko_one');
      IF r->>'code' <> 'CUSTOMER_OWNED_BY_OTHER_TENANT' THEN RAISE EXCEPTION 'QA FAILED: customer tenant guard %', r; END IF;
      IF (SELECT count(*) FROM public.billing_subscriptions) <> n THEN RAISE EXCEPTION 'QA FAILED: writes on customer guard'; END IF;

      -- Scenario F: subscription già di altra agenzia → zero scritture
      r := public.civiko_activate_paid_zone_atomic(
             a2,'centro-storico','cus_qa9e2_2','sub_qa9e2_old','active',
             'price_qa','premium','monthly',NULL,NULL,NULL,false,'civiko_one');
      IF r->>'code' <> 'SUBSCRIPTION_OWNED_BY_OTHER_TENANT' THEN RAISE EXCEPTION 'QA FAILED: subscription tenant guard %', r; END IF;
      IF (SELECT count(*) FROM public.billing_subscriptions) <> n THEN RAISE EXCEPTION 'QA FAILED: writes on subscription guard'; END IF;

      -- Scenario B: nuova subscription attiva della stessa agenzia, poi cancello la vecchia
      INSERT INTO public.billing_subscriptions(
        agency_id, app_id, stripe_customer_id, stripe_subscription_id, status,
        billing_interval, zona_status, zona_assegnata)
      VALUES (a1,'civiko_one','cus_qa9e2_1','sub_qa9e2_new','active','monthly','assegnata','centro-storico');

      r := public.civiko_release_zone_on_cancel_atomic('sub_qa9e2_old');
      IF (r->>'ok')::boolean IS NOT TRUE OR (r->>'released')::boolean IS NOT FALSE
         OR (r->>'superseded')::boolean IS NOT TRUE THEN
        RAISE EXCEPTION 'QA FAILED: superseded guard %', r;
      END IF;
      SELECT status, occupied_agency_id, occupied_since INTO z_status, z_agency, z_since2
        FROM public.civiko_commercial_zones WHERE slug='centro-storico';
      IF z_status <> 'occupata' OR z_agency <> a1 OR z_since2 IS DISTINCT FROM z_since THEN
        RAISE EXCEPTION 'QA FAILED: zone changed on superseded cancel';
      END IF;
      IF (SELECT status FROM public.billing_subscriptions WHERE stripe_subscription_id='sub_qa9e2_old') <> 'canceled' THEN
        RAISE EXCEPTION 'QA FAILED: old sub not canceled';
      END IF;

      -- Scenario C: cancellazione dell'unica subscription attiva → zona liberata
      r := public.civiko_release_zone_on_cancel_atomic('sub_qa9e2_new');
      IF (r->>'released')::boolean IS NOT TRUE OR (r->>'superseded')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'QA FAILED: release last sub %', r;
      END IF;
      SELECT status, occupied_agency_id INTO z_status, z_agency
        FROM public.civiko_commercial_zones WHERE slug='centro-storico';
      IF z_status <> 'disponibile' OR z_agency IS NOT NULL THEN RAISE EXCEPTION 'QA FAILED: zone not released'; END IF;

      -- Scenario D: retry cancellazione → idempotente
      r := public.civiko_release_zone_on_cancel_atomic('sub_qa9e2_new');
      IF (r->>'ok')::boolean IS NOT TRUE OR (r->>'released')::boolean IS NOT FALSE THEN
        RAISE EXCEPTION 'QA FAILED: cancel retry not idempotent %', r;
      END IF;
      r := public.civiko_release_zone_on_cancel_atomic('sub_qa9e2_unknown');
      IF r->>'code' <> 'SUBSCRIPTION_UNKNOWN' THEN RAISE EXCEPTION 'QA FAILED: unknown sub %', r; END IF;

      -- Scenario claim/registry: claim → non riclaimabile → processed una volta sola
      r := public.stripe_webhook_event_claim('evt_qa9e2','checkout.session.completed');
      IF (r->>'claimed')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'QA FAILED: first claim'; END IF;
      r := public.stripe_webhook_event_claim('evt_qa9e2','checkout.session.completed');
      IF (r->>'claimed')::boolean IS NOT FALSE THEN RAISE EXCEPTION 'QA FAILED: double claim'; END IF;
      IF public.stripe_webhook_event_mark_failed('evt_qa9e2','qa') IS NOT TRUE THEN RAISE EXCEPTION 'QA FAILED: mark_failed'; END IF;
      r := public.stripe_webhook_event_claim('evt_qa9e2','checkout.session.completed');
      IF (r->>'claimed')::boolean IS NOT TRUE OR (r->>'attempts')::int <> 2 THEN RAISE EXCEPTION 'QA FAILED: reclaim after failed %', r; END IF;
      IF public.stripe_webhook_event_mark_processed('evt_qa9e2') IS NOT TRUE THEN RAISE EXCEPTION 'QA FAILED: mark_processed true'; END IF;
      r := public.stripe_webhook_event_claim('evt_qa9e2','checkout.session.completed');
      IF (r->>'claimed')::boolean IS NOT FALSE OR r->>'status' <> 'processed' THEN RAISE EXCEPTION 'QA FAILED: claim after processed %', r; END IF;
      IF public.stripe_webhook_event_mark_processed('evt_qa9e2_missing') IS NOT FALSE THEN
        RAISE EXCEPTION 'QA FAILED: mark_processed must return false for unknown event';
      END IF;

      -- default stale = 5 minuti
      IF (SELECT pg_get_function_arg_default(p.oid, 3) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='stripe_webhook_event_claim') NOT LIKE '%00:05:00%' THEN
        RAISE EXCEPTION 'QA FAILED: stale_after not 5 minutes';
      END IF;

      RAISE EXCEPTION 'QA_ROLLBACK_OK';
    END;
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
    IF v_msg <> 'QA_ROLLBACK_OK' THEN
      RAISE EXCEPTION 'QA 9E2-FINAL FAILED -> %', v_msg;
    END IF;
    RAISE NOTICE 'QA 9E2-FINAL: tutti gli scenari superati, stato annullato (rollback)';
  END;
END
$qa$;