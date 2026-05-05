// ═══════════════════════════════════════════════════════════════
// Open Data Veneto → Radar enrichment
// Reads territorial_signals (sourced from Open Data Veneto / CKAN) and:
//   1. Generates/updates radar_signals (1 per comune+topic)
//   2. Updates area_opportunity_scores.components with sub-scores
//      (urban_planning_score, planning_constraints_score,
//       public_services_score, mobility_score, territorial_signal_score,
//       source_count, data_confidence_score, explanation, positive_factors,
//       missing_factors)
// Hard rules: no demo/mock/seed, no invented data, regional (no comune)
// signals stay regional-only and don't get assigned to a comune.
// ═══════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

type Topic = "urbanistica" | "vincoli" | "servizi" | "mobilita" | "strade" | "ambiente" | "scuole" | "altro";

interface TSRow {
  id: number;
  signal_type: string | null;
  title: string | null;
  municipality: string | null;
  province: string | null;
  source_name: string | null;
  source_url: string | null;
  quality: string | null;
  confidence_score: number | null;
  payload: Record<string, unknown> | null;
}

interface TopicAgg {
  topic: Topic;
  signals: TSRow[];
  hasResource: boolean;
}

interface MuniAgg {
  province: string;
  municipality: string;
  byTopic: Map<Topic, TopicAgg>;
}

const TOPIC_FROM_SIGNAL: Record<string, Topic> = {
  urban_planning_dataset: "urbanistica",
  planning_constraints_dataset: "vincoli",
  public_services_dataset: "servizi",
  schools_dataset: "scuole",
  mobility_dataset: "mobilita",
  roads_dataset: "strade",
  environment_dataset: "ambiente",
};

const RADAR_SIGNAL_TYPE: Record<Topic, string> = {
  urbanistica: "urbanistica",
  vincoli: "vincoli",
  servizi: "servizi",
  scuole: "servizi",
  mobilita: "mobilita",
  strade: "accessibilita",
  ambiente: "territorio",
  altro: "open_data",
};

const TOPIC_ACTION: Record<Topic, { title: string; reason: string; action: string; script: string }> = {
  urbanistica: {
    title: "Piano interventi e trasformazioni urbanistiche",
    reason: "Sono pubblicate aree con previsioni urbanistiche o piani di intervento attivi: è una leva per anticipare i proprietari interessati.",
    action: "Prepara report proprietari su zone interessate da trasformazioni urbanistiche e cita il riferimento ufficiale del Comune.",
    script: "Buongiorno, ho letto il Piano degli Interventi del Comune e la sua zona è inclusa nelle previsioni urbanistiche: posso passare a illustrarle l'impatto sul valore?",
  },
  vincoli: {
    title: "Ambiti soggetti a regime di vincolo",
    reason: "Esistono ambiti vincolati (paesaggistici, idrogeologici o di tutela): da segnalare nelle due diligence e nelle valutazioni prudenti.",
    action: "Usa in due diligence e nella valutazione prudente del prezzo: indica al proprietario i limiti effettivi prima di fissare il prezzo.",
    script: "Buongiorno, la zona è interessata da un ambito di vincolo: prima di fissare il prezzo le mostro il quadro ufficiale per evitare sorprese in trattativa.",
  },
  servizi: {
    title: "Servizi pubblici e attrattività familiare",
    reason: "Dati ufficiali su luoghi di interesse pubblico/servizi: indicano accessibilità per famiglie e qualità della vita di zona.",
    action: "Usa nei report proprietari come fattore di attrattività per famiglie e per la promozione su portali.",
    script: "Buongiorno, la sua zona ha una buona dotazione di servizi pubblici certificata dal Comune: è un argomento forte da inserire nell'annuncio.",
  },
  scuole: {
    title: "Istituti scolastici nel comune",
    reason: "Elenco ufficiale degli istituti scolastici: leva diretta per famiglie con figli e per posizionamento del prezzo.",
    action: "Aggiungi mappa scuole vicine al report proprietario; usa come argomento commerciale per target famiglie.",
    script: "Buongiorno, ho la lista ufficiale delle scuole vicine al suo immobile: per una famiglia è un fattore decisivo, vale la pena valorizzarlo.",
  },
  mobilita: {
    title: "Misure mobilità e accessibilità",
    reason: "Dati su misure per la mobilità o accessi alla viabilità pubblica: utile per micro-zone con accesso diretto e collegamenti.",
    action: "Valuta micro-zone con accesso diretto alla viabilità pubblica e promuovi connettività nei materiali di vendita.",
    script: "Buongiorno, ho i dati ufficiali sulla mobilità della zona: posso mostrarle come valorizzare connettività e accessi nell'annuncio?",
  },
  strade: {
    title: "Viabilità e distribuzione popolazione per via",
    reason: "Dati sulla rete viaria comunale e distribuzione della popolazione per via: indicatore di accessibilità reale dell'immobile.",
    action: "Verifica la via dell'immobile rispetto alle direttrici principali e usalo nello script di contatto.",
    script: "Buongiorno, ho il quadro ufficiale della viabilità della sua via: posso passarle un confronto rapido per la valutazione.",
  },
  ambiente: {
    title: "Indicatori ambientali e qualità della zona",
    reason: "Dati ambientali pubblici (qualità aria, acque, verde): importanti per posizionamento prezzo e segmenti sensibili.",
    action: "Inserisci nel report proprietario come fattore di posizionamento; segnala criticità solo se documentate.",
    script: "Buongiorno, ho gli indicatori ambientali ufficiali della zona: sono un argomento che oggi pesa nelle valutazioni, glielo mostro?",
  },
  altro: {
    title: "Open data territoriale",
    reason: "Dataset territoriale ufficiale rilevante per la zona.",
    action: "Verifica applicabilità al singolo immobile prima di usarlo in trattativa.",
    script: "Buongiorno, ho un dato territoriale ufficiale sulla sua zona: vuole che le mostri come si applica al suo immobile?",
  },
};

function topicOf(signalType: string | null, payload: Record<string, unknown> | null): Topic {
  const explicit = (payload?.topic as string | undefined)?.toLowerCase();
  if (explicit && (["urbanistica","vincoli","servizi","mobilita","strade","ambiente","scuole"] as Topic[]).includes(explicit as Topic)) {
    return explicit as Topic;
  }
  if (signalType && TOPIC_FROM_SIGNAL[signalType]) return TOPIC_FROM_SIGNAL[signalType];
  return "altro";
}

function fingerprintFor(province: string, municipality: string, topic: Topic): string {
  return `odv:${province}:${municipality.toLowerCase().trim()}:${topic}`;
}

export interface EnrichmentReport {
  ok: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  source_documents: { total: number; from_open_data_veneto: number; without_municipality: number };
  territorial_signals: { total: number; from_open_data_veneto: number; without_municipality: number; by_topic: Record<string, number>; by_province: Record<string, number> };
  radar_signals_upserted: number;
  area_opportunity_scores_upserted: number;
  topMunicipalities: Array<{ province: string; municipality: string; sub_scores: Record<string, number>; source_count: number; quality: string }>;
  topRadarSignals: Array<{ province: string; municipality: string; signal_type: string; title: string; confidence: string }>;
  warnings: string[];
}

function svc(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function enrichRadarFromOpenDataVeneto(): Promise<EnrichmentReport> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const warnings: string[] = [];
  const supa = svc();
  if (!supa) {
    return {
      ok: false, startedAt, completedAt: startedAt, durationMs: 0,
      source_documents: { total: 0, from_open_data_veneto: 0, without_municipality: 0 },
      territorial_signals: { total: 0, from_open_data_veneto: 0, without_municipality: 0, by_topic: {}, by_province: {} },
      radar_signals_upserted: 0,
      area_opportunity_scores_upserted: 0,
      topMunicipalities: [], topRadarSignals: [],
      warnings: ["SUPABASE_SERVICE_ROLE_KEY mancante"],
    };
  }

  // Audit counters
  const tsAudit = { total: 0, from_open_data_veneto: 0, without_municipality: 0, by_topic: {} as Record<string, number>, by_province: {} as Record<string, number> };
  const sdAudit = { total: 0, from_open_data_veneto: 0, without_municipality: 0 };

  try {
    const { count: c1 } = await supa.from("source_documents").select("*", { count: "exact", head: true });
    sdAudit.total = c1 ?? 0;
    const { count: c2 } = await supa.from("source_documents").select("*", { count: "exact", head: true }).ilike("source_name", "%open data veneto%");
    sdAudit.from_open_data_veneto = c2 ?? 0;
    const { count: c3 } = await supa.from("source_documents").select("*", { count: "exact", head: true }).is("comune", null);
    sdAudit.without_municipality = c3 ?? 0;
  } catch (e) { warnings.push(`source_documents audit: ${(e as Error).message}`); }

  try {
    const { count: c1 } = await supa.from("territorial_signals").select("*", { count: "exact", head: true });
    tsAudit.total = c1 ?? 0;
    const { count: c3 } = await supa.from("territorial_signals").select("*", { count: "exact", head: true }).is("municipality", null);
    tsAudit.without_municipality = c3 ?? 0;
  } catch (e) { warnings.push(`territorial_signals audit: ${(e as Error).message}`); }

  // Pull all Open Data Veneto territorial_signals
  const { data: tsRowsRaw, error: tsErr } = await supa
    .from("territorial_signals")
    .select("id,signal_type,title,municipality,province,source_name,source_url,quality,confidence_score,payload")
    .ilike("source_name", "%open data veneto%")
    .range(0, 4999);
  if (tsErr) warnings.push(`territorial_signals fetch: ${tsErr.message}`);
  const tsRows: TSRow[] = (tsRowsRaw ?? []) as TSRow[];
  tsAudit.from_open_data_veneto = tsRows.length;

  // Aggregate by municipality+topic
  const muniMap = new Map<string, MuniAgg>();
  let regionalCount = 0;
  for (const r of tsRows) {
    const topic = topicOf(r.signal_type, r.payload);
    tsAudit.by_topic[topic] = (tsAudit.by_topic[topic] ?? 0) + 1;
    if (r.province) tsAudit.by_province[r.province] = (tsAudit.by_province[r.province] ?? 0) + 1;
    if (!r.municipality || !r.province) { regionalCount++; continue; }
    const k = `${r.province}:${r.municipality.toLowerCase().trim()}`;
    let m = muniMap.get(k);
    if (!m) { m = { province: r.province, municipality: r.municipality, byTopic: new Map() }; muniMap.set(k, m); }
    let t = m.byTopic.get(topic);
    if (!t) { t = { topic, signals: [], hasResource: false }; m.byTopic.set(topic, t); }
    t.signals.push(r);
    const resUrl = r.payload?.resource_url as string | undefined;
    if (resUrl) t.hasResource = true;
  }

  // ─── Upsert radar_signals (one per muni+topic) ───
  let radarUpserted = 0;
  const topRadarSignals: EnrichmentReport["topRadarSignals"] = [];
  for (const m of muniMap.values()) {
    for (const t of m.byTopic.values()) {
      const fp = fingerprintFor(m.province, m.municipality, t.topic);
      const sample = t.signals[0];
      const meta = TOPIC_ACTION[t.topic];
      const radarType = RADAR_SIGNAL_TYPE[t.topic];
      const evidenceUrl = (sample.payload?.resource_url as string | undefined)
        ?? (sample.payload?.dataset_url as string | undefined)
        ?? sample.source_url ?? null;
      const score = Math.min(100,
        40 + Math.min(20, t.signals.length * 5) + (t.hasResource ? 15 : 0)
      );
      const confidence: "high" | "medium" | "low" = t.hasResource ? "high" : "medium";
      const quality = t.hasResource ? "reale" : "parziale";
      const temperature: "fredda"|"tiepida"|"calda"|"molto_calda" =
        score >= 75 ? "molto_calda" : score >= 55 ? "calda" : score >= 30 ? "tiepida" : "fredda";

      const row = {
        fingerprint: fp,
        signal_type: radarType,
        title: `${meta.title} — ${m.municipality}`,
        description: meta.reason,
        municipality: m.municipality,
        province: m.province,
        evidence_url: evidenceUrl,
        source: "Open Data Veneto",
        confidence,
        urgency: "media",
        is_active: true,
        detected_at: new Date().toISOString(),
        payload: {
          source_name: "Open Data Veneto",
          data_basis: "open_data_veneto,ckan_api",
          quality,
          confidence_score: t.hasResource ? 0.8 : 0.6,
          score,
          temperature,
          topic: t.topic,
          dataset_count: t.signals.length,
          has_downloadable_resource: t.hasResource,
          agentAction: meta.action,
          script: meta.script,
          source_urls: t.signals.map(s => (s.payload?.resource_url as string | undefined) ?? s.source_url).filter(Boolean).slice(0, 5),
          source_titles: Array.from(new Set(t.signals.map(s => s.title).filter(Boolean))).slice(0, 5),
        },
      };

      // Manual upsert: unique key is (agency_id, fingerprint) and agency_id IS NULL → NULLs don't conflict in PG
      const { data: existing } = await supa.from("radar_signals")
        .select("id").eq("fingerprint", fp).is("agency_id", null).maybeSingle();
      if (existing?.id) {
        const { error } = await supa.from("radar_signals").update(row).eq("id", existing.id);
        if (error) { warnings.push(`radar_signals update ${fp}: ${error.message}`); continue; }
      } else {
        const { error } = await supa.from("radar_signals").insert(row);
        if (error) { warnings.push(`radar_signals insert ${fp}: ${error.message}`); continue; }
      }
      radarUpserted++;
      if (topRadarSignals.length < 10) {
        topRadarSignals.push({ province: m.province, municipality: m.municipality, signal_type: radarType, title: row.title, confidence });
      }
    }
  }

  // ─── Update area_opportunity_scores per municipality ───
  let aosUpserted = 0;
  const topMuni: EnrichmentReport["topMunicipalities"] = [];
  for (const m of muniMap.values()) {
    const subs = {
      urban_planning_score: 0,
      planning_constraints_score: 0,
      public_services_score: 0,
      mobility_score: 0,
      territorial_signal_score: 0,
    };
    let sourceCount = 0;
    let confidenceSum = 0;
    let confidenceN = 0;
    const positive: string[] = [];
    const missing: string[] = [];
    const topicsFound: Topic[] = [];

    for (const t of m.byTopic.values()) {
      topicsFound.push(t.topic);
      const base = t.hasResource ? 18 : 10;
      const bonus = Math.min(10, t.signals.length * 3);
      const v = Math.min(30, base + bonus);
      if (t.topic === "urbanistica") subs.urban_planning_score = Math.max(subs.urban_planning_score, v);
      else if (t.topic === "vincoli") subs.planning_constraints_score = Math.max(subs.planning_constraints_score, v);
      else if (t.topic === "servizi" || t.topic === "scuole") subs.public_services_score = Math.max(subs.public_services_score, v);
      else if (t.topic === "mobilita" || t.topic === "strade") subs.mobility_score = Math.max(subs.mobility_score, v);
      sourceCount += t.signals.length;
      for (const s of t.signals) {
        if (typeof s.confidence_score === "number") { confidenceSum += s.confidence_score; confidenceN++; }
      }
      const meta = TOPIC_ACTION[t.topic];
      positive.push(`${t.topic}: ${t.signals.length} dataset${t.hasResource ? " con risorse scaricabili" : ""} — ${meta.title.toLowerCase()}`);
    }
    subs.territorial_signal_score = Math.min(40,
      subs.urban_planning_score * 0.4 +
      subs.planning_constraints_score * 0.3 +
      subs.public_services_score * 0.3 +
      subs.mobility_score * 0.3
    );
    if (subs.urban_planning_score === 0) missing.push("urbanistica: nessun dataset di pianificazione disponibile");
    if (subs.public_services_score === 0) missing.push("servizi: nessun dataset di servizi pubblici disponibile");
    if (subs.mobility_score === 0) missing.push("mobilita: nessun dataset di mobilita/viabilita disponibile");

    const dataConfidence = confidenceN ? confidenceSum / confidenceN : 0.6;
    const explanation = `Open Data Veneto: ${sourceCount} segnali su ${topicsFound.length} topic (${topicsFound.join(", ")}). Punteggio territoriale ${subs.territorial_signal_score.toFixed(1)}/40.`;

    // Read existing row to merge components without losing existing OMI/listing/derived data
    const { data: existing, error: readErr } = await supa
      .from("area_opportunity_scores")
      .select("score,components,quality,data_basis")
      .eq("province", m.province).eq("municipality", m.municipality).is("microzone", null)
      .maybeSingle();
    if (readErr && readErr.code !== "PGRST116") warnings.push(`aos read ${m.province}/${m.municipality}: ${readErr.message}`);

    const prevComponents = (existing?.components ?? {}) as Record<string, unknown>;
    const prevScore = Number(existing?.score ?? 0);
    const prevQuality = String(existing?.quality ?? "parziale");
    const prevBasis = String(existing?.data_basis ?? "");
    const newScore = Math.round(Math.min(100, prevScore + subs.territorial_signal_score));
    const components = {
      ...prevComponents,
      urban_planning_score: subs.urban_planning_score,
      planning_constraints_score: subs.planning_constraints_score,
      public_services_score: subs.public_services_score,
      mobility_score: subs.mobility_score,
      territorial_signal_score: Number(subs.territorial_signal_score.toFixed(1)),
      source_count: sourceCount,
      data_confidence_score: Number(dataConfidence.toFixed(2)),
      explanation,
      positive_factors: positive,
      missing_factors: missing,
      open_data_topics: topicsFound,
    };
    const dataBasis = Array.from(new Set([...(prevBasis ? prevBasis.split("+") : []), "open_data_veneto"])).join("+");
    const quality: string = prevQuality === "reale" ? "reale" : "parziale";
    const temperature: string = newScore >= 75 ? "molto_calda" : newScore >= 55 ? "calda" : newScore >= 30 ? "tiepida" : "fredda";

    const { error: upErr } = await supa.from("area_opportunity_scores").upsert({
      region: "veneto",
      province: m.province,
      municipality: m.municipality,
      microzone: null,
      score: newScore,
      temperature,
      components,
      data_basis: dataBasis,
      quality,
      computed_at: new Date().toISOString(),
    }, { onConflict: "province,municipality,microzone" });
    if (upErr) { warnings.push(`aos upsert ${m.province}/${m.municipality}: ${upErr.message}`); continue; }
    aosUpserted++;
    topMuni.push({
      province: m.province, municipality: m.municipality,
      sub_scores: { ...subs, territorial_signal_score: Number(subs.territorial_signal_score.toFixed(1)) },
      source_count: sourceCount, quality,
    });
  }
  topMuni.sort((a, b) => b.sub_scores.territorial_signal_score - a.sub_scores.territorial_signal_score);

  // Touch data_sources
  try {
    await supa.from("data_sources").update({ last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("source_name", "open_data_veneto");
  } catch (_e) { /* silent */ }

  // Log run
  try {
    await supa.from("ingestion_runs").insert({
      job_name: "enrich-radar-from-open-data-veneto",
      source_name: "open_data_veneto",
      status: "completed",
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      rows_in: tsRows.length,
      rows_out: radarUpserted + aosUpserted,
      warnings: warnings,
      report: { tsAudit, sdAudit, regionalCount, radarUpserted, aosUpserted },
    });
  } catch (_e) { /* silent */ }

  if (regionalCount > 0) warnings.push(`${regionalCount} segnali regionali (senza comune) lasciati come fonti regionali, non assegnati a comuni.`);

  return {
    ok: true,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    source_documents: sdAudit,
    territorial_signals: tsAudit,
    radar_signals_upserted: radarUpserted,
    area_opportunity_scores_upserted: aosUpserted,
    topMunicipalities: topMuni.slice(0, 10),
    topRadarSignals,
    warnings,
  };
}
