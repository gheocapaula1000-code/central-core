// Regressione statica — forward repair matcher v4 (migrazione 20260806190459).
// Verifica il contratto NUOVO e la definizione realmente installata in DB non
// e' oggetto di questo file: qui si prova il sorgente versionato.
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION =
  "supabase/migrations/20260806190459_1205eebf-0a30-40d6-83aa-8fe2dfab03e9.sql";

const sql = await Deno.readTextFile(MIGRATION);

Deno.test("prove foto: contratto esatto evidence_kind + match_version v4 + algo", () => {
  assert(/'v4-padova-photo-pair'/.test(sql), "match_version v4 esplicita assente");
  assert(/'phash-dct-8x8-v1'/.test(sql), "algo atteso assente");
  assert(
    /JOIN public\.civiko_photo_evidence_contract\(\) k[\s\S]{0,200}e\.match_version = k\.match_version[\s\S]{0,120}e\.algo = k\.algo/
      .test(sql),
    "photo_ev deve filtrare per versione e algoritmo esatti",
  );
  assert(!/v3-unit-certified/.test(sql), "nessuna prova v3 puo' certificare");
});

Deno.test("gate di gruppo: metadata SOLO nel ramo interamente strutturale", () => {
  const start = sql.indexOf("civiko_padova_img_group_gate_ok");
  assert(start > -1, "gate helper assente");
  const body = sql.slice(start, sql.indexOf("$function$", sql.indexOf("$function$", start) + 1));
  assert(/coalesce\(p_n_pairs_photo, 0\) > 0/.test(body), "ramo PHOTO deve bypassare i metadata");
  // I vincoli di metadata devono comparire dopo il ramo PHOTO, mai prima.
  const photoIdx = body.indexOf("coalesce(p_n_pairs_photo, 0) > 0");
  for (const meta of ["p_mq_min", "p_mq_max", "p_n_locali", "p_n_bagni", "p_n_piani", "p_n_tipologie"]) {
    assert(body.indexOf(meta) > photoIdx, `${meta} non puo' essere un veto globale`);
  }
  // Reject comuni sempre presenti.
  for (const req of [
    "p_n_zone = 1",
    "p_has_asta IS NOT TRUE",
    "p_has_mls IS NOT TRUE",
    "p_n_agenzie >= 2",
    "p_n_annunci_canonici >= 2",
    "p_n_pairs = p_n_pairs_attese",
    "p_prezzo_max <= p_prezzo_min * 1.15",
  ]) {
    assert(body.includes(req), `reject comune mancante: ${req}`);
  }
});

Deno.test("recompute: patch fail-closed sul gate live, nessun veto mq globale", () => {
  assert(/Patch fail-closed: gate _img_ok atteso non trovato/.test(sql), "patch non fail-closed");
  assert(
    /Verifica post-patch fallita/.test(sql),
    "manca la verifica post-patch della definizione installata",
  );
  assert(
    /coalesce\(mq_min, 0\) <= 0/.test(sql),
    "il vincolo mq deve vivere dentro il ramo strutturale della QA",
  );
});

Deno.test("fixture: PHOTO senza metadata passa, casi vietati falliscono", () => {
  for (const nome of [
    "PHOTO_mq_mancante",
    "PHOTO_metadata_divergenti",
    "STRUCT_mq_mancante",
    "STRUCT_mq_divergenti",
    "PHOTO_canonical_dup",
    "PHOTO_stessa_agenzia",
    "PHOTO_asta",
    "PHOTO_mls",
    "PHOTO_prezzo_oltre_15",
    "PHOTO_clique_incompleta",
  ]) {
    assert(sql.includes(nome), `fixture mancante: ${nome}`);
  }
  assert(
    /Fixture gate di gruppo: % casi non conformi al contratto/.test(sql),
    "la fixture deve essere fail-closed (RAISE)",
  );
});

Deno.test("regressione reale: negativi e positivo entrambi vincolanti", () => {
  assert(/\(2309, 60498\), \(3619, 60735\)/.test(sql), "negativi noti assenti");
  assert(/Regressione matcher: % coppie negative note riammesse/.test(sql));
  assert(
    /prova positiva 44787\/101390 presente[\s\S]{0,120}ma nessuna edge generata/.test(sql),
    "il positivo deve RAISE, non essere un semplice NOTICE",
  );
  assert(
    /IF v_listings = 2 AND v_ev > 0 AND v_pos = 0 THEN/.test(sql),
    "il positivo e' vincolante quando esistono listing e prova v4 esatta",
  );
});
