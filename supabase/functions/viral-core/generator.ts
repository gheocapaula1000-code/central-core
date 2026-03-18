// ═══════════════════════════════════════════════════════════════
// Viral Core — Content Generation & Media Brief
// Uses OpenAI via the same provider pattern already in the repo.
// Falls back gracefully if provider is unavailable.
// ═══════════════════════════════════════════════════════════════

import type { Platform, Formato, BrandProfile, HistoryHints } from "./types.ts";

// ── Platform adaptation rules ──
const PLATFORM_GUIDELINES: Record<Platform, string> = {
  tiktok:
    "Breve, catchy, linguaggio Gen-Z/Millennial. Hashtag trending. Hook nei primi 3 secondi. " +
    "Massimo 300 caratteri. Emoji ok. No link nel testo (usa bio). Tono informale e dinamico.",
  instagram:
    "Visuale-first. Caption descrittiva ma accattivante. Massimo 2200 caratteri ma ideale sotto 500. " +
    "Hashtag rilevanti (max 15). CTA morbida. Tono autentico e curato. Emoji moderate.",
  facebook:
    "Tono conversazionale e coinvolgente. Può essere più lungo. Domande aperte per engagement. " +
    "Hashtag minimali (0-3). Link consentiti. Emoji moderate. Adatto a 30-55 anni.",
  linkedin:
    "Professionale ma umano. Insight di valore. Storytelling business. No emoji eccessive. " +
    "Hashtag professionali (3-5). Tono autorevole. Formattazione con a capo e bullet points.",
};

const PLATFORM_MEDIA: Record<Platform, Record<Formato, string>> = {
  tiktok: {
    reel: "Video verticale 9:16, 15-60s. Transizioni rapide, testo sovrapposto grande, musica trending.",
    post: "Immagine o carousel con testo grande e leggibile. Colori vivaci e contrasto alto.",
  },
  instagram: {
    reel: "Video verticale 9:16, 15-90s. Cover accattivante, caption storytelling, audio originale o trending.",
    post: "Immagine quadrata o 4:5. Estetica curata, palette coerente col brand. Carousel per tutorial/listicle.",
  },
  facebook: {
    reel: "Video orizzontale o quadrato, 30-120s. Sottotitoli obbligatori. Thumbnail chiara.",
    post: "Immagine con testo minimo, alta risoluzione. Evita immagini stock generiche.",
  },
  linkedin: {
    reel: "Video professionale orizzontale 16:9, 30-120s. Sottotitoli professionali. Logo watermark.",
    post: "Infografica o documento PDF carousel. Design pulito, dati leggibili, palette corporate.",
  },
};

interface GenerateParams {
  platform: Platform;
  argomento: string;
  obiettivo?: string;
  tono?: string;
  formato: Formato;
  brandProfile?: BrandProfile;
  historyHints?: HistoryHints;
}

function buildPrompt(params: GenerateParams): string {
  const { platform, argomento, obiettivo, tono, formato, brandProfile, historyHints } = params;
  const guidelines = PLATFORM_GUIDELINES[platform];
  const mediaHint = PLATFORM_MEDIA[platform]?.[formato] ?? "";

  let prompt = `Sei un esperto di social media marketing italiano. Genera un contenuto per ${platform.toUpperCase()} in formato "${formato}".

ARGOMENTO: ${argomento}
${obiettivo ? `OBIETTIVO: ${obiettivo}` : ""}
${tono ? `TONO RICHIESTO: ${tono}` : "TONO: adatta al brand e alla piattaforma"}

LINEE GUIDA PIATTAFORMA:
${guidelines}

SUGGERIMENTO MEDIA:
${mediaHint}`;

  if (brandProfile) {
    prompt += `\n\nBRAND PROFILE:`;
    if (brandProfile.name) prompt += `\n- Nome: ${brandProfile.name}`;
    if (brandProfile.sector) prompt += `\n- Settore: ${brandProfile.sector}`;
    if (brandProfile.toneNotes) prompt += `\n- Note tono: ${brandProfile.toneNotes}`;
    if (brandProfile.cta) prompt += `\n- CTA preferita: ${brandProfile.cta}`;
  }

  if (historyHints) {
    if (historyHints.recentTopics?.length) {
      prompt += `\n\nTOPIC RECENTI (evita ripetizione): ${historyHints.recentTopics.join(", ")}`;
    }
    if (historyHints.recentHashtags?.length) {
      prompt += `\nHASHTAG RECENTI (varia): ${historyHints.recentHashtags.join(", ")}`;
    }
  }

  prompt += `\n\nRispondi SOLO con il contenuto testuale pronto per la pubblicazione. Includi hashtag appropriati per la piattaforma.`;

  return prompt;
}

function buildMediaSuggestion(platform: Platform, formato: Formato, argomento: string, brandProfile?: BrandProfile): string {
  const base = PLATFORM_MEDIA[platform]?.[formato] ?? "Immagine di alta qualità coerente col contenuto.";
  const brand = brandProfile?.name ? ` Coerente con il brand ${brandProfile.name}.` : "";
  return `${base} Soggetto suggerito: visual legato a "${argomento}".${brand}`;
}

// ── OpenAI call (reuses existing OPENAI_API_KEY secret) ──
async function callOpenAI(prompt: string, maxTokens: number): Promise<{ text: string; ok: boolean; error?: string }> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) return { text: "", ok: false, error: "OPENAI_API_KEY not configured" };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[viral-core] OpenAI error status=${res.status}`);
      return { text: "", ok: false, error: `OpenAI ${res.status}` };
    }

    const json = await res.json();
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    return { text, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[viral-core] OpenAI call failed: ${msg}`);
    return { text: "", ok: false, error: msg };
  }
}

export async function generateSingleContent(
  params: GenerateParams,
): Promise<{ content: string; mediaSuggestion: string; warnings: string[] }> {
  const warnings: string[] = [];
  const prompt = buildPrompt(params);
  const result = await callOpenAI(prompt, 1500);

  let content: string;
  if (result.ok && result.text) {
    content = result.text;
  } else {
    warnings.push(`Content generation unavailable: ${result.error ?? "unknown"}`);
    content = `[Contenuto per ${params.platform} su "${params.argomento}" — generazione temporaneamente non disponibile]`;
  }

  const mediaSuggestion = buildMediaSuggestion(params.platform, params.formato, params.argomento, params.brandProfile);

  return { content, mediaSuggestion, warnings };
}

export async function generateBundle(
  argomento: string,
  obiettivo: string | undefined,
  tono: string | undefined,
  formato: Formato,
  brandProfile: BrandProfile | undefined,
  historyHints: HistoryHints | undefined,
): Promise<{ contents: Record<Platform, string>; mediaSuggestions: Record<Platform, string>; warnings: string[] }> {
  const platforms: Platform[] = ["tiktok", "instagram", "facebook", "linkedin"];
  const warnings: string[] = [];
  const contents: Record<string, string> = {};
  const mediaSuggestions: Record<string, string> = {};

  // Generate all 4 in parallel
  const results = await Promise.allSettled(
    platforms.map(p =>
      generateSingleContent({
        platform: p,
        argomento,
        obiettivo,
        tono,
        formato,
        brandProfile,
        historyHints,
      })
    )
  );

  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i];
    const r = results[i];
    if (r.status === "fulfilled") {
      contents[p] = r.value.content;
      mediaSuggestions[p] = r.value.mediaSuggestion;
      warnings.push(...r.value.warnings);
    } else {
      contents[p] = `[Contenuto per ${p} — generazione fallita]`;
      mediaSuggestions[p] = buildMediaSuggestion(p, formato, argomento, brandProfile);
      warnings.push(`${p}: generation failed`);
    }
  }

  return {
    contents: contents as Record<Platform, string>,
    mediaSuggestions: mediaSuggestions as Record<Platform, string>,
    warnings,
  };
}

export async function generateVideoScript(argomento: string, tono?: string, brandProfile?: BrandProfile): Promise<{ script: string; warnings: string[] }> {
  const warnings: string[] = [];
  const prompt = `Scrivi uno script video di massimo 15 secondi per un reel/TikTok sull'argomento: "${argomento}".
${tono ? `Tono: ${tono}` : "Tono: dinamico e accattivante"}
${brandProfile?.name ? `Brand: ${brandProfile.name}` : ""}

Formato:
[0-3s] Hook iniziale
[3-10s] Contenuto principale
[10-15s] CTA finale

Rispondi SOLO con lo script, senza commenti.`;

  const result = await callOpenAI(prompt, 500);
  if (result.ok && result.text) {
    return { script: result.text, warnings };
  }
  warnings.push(`Video script unavailable: ${result.error ?? "unknown"}`);
  return { script: `[Script 15s su "${argomento}" — generazione temporaneamente non disponibile]`, warnings };
}

export async function generateGoogleAdsPack(argomento: string, obiettivo?: string, brandProfile?: BrandProfile): Promise<{ pack: Record<string, unknown>; warnings: string[] }> {
  const warnings: string[] = [];
  const prompt = `Genera un pacchetto Google Ads per il seguente argomento: "${argomento}"
${obiettivo ? `Obiettivo: ${obiettivo}` : ""}
${brandProfile?.name ? `Brand: ${brandProfile.name}` : ""}

Rispondi in JSON con questa struttura esatta:
{
  "headlines": ["headline1", "headline2", "headline3"],
  "descriptions": ["desc1", "desc2"],
  "keywords": ["kw1", "kw2", "kw3", "kw4", "kw5"],
  "callToAction": "testo CTA"
}

Solo JSON, senza commenti.`;

  const result = await callOpenAI(prompt, 800);
  if (result.ok && result.text) {
    try {
      const cleaned = result.text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(cleaned);
      return { pack: parsed, warnings };
    } catch {
      warnings.push("Google Ads pack: response was not valid JSON, returning raw text");
      return { pack: { raw: result.text }, warnings };
    }
  }
  warnings.push(`Google Ads pack unavailable: ${result.error ?? "unknown"}`);
  return { pack: { unavailable: true }, warnings };
}

export function buildMediaBrief(
  platform: Platform,
  content: string,
  mediaSuggestion: string | undefined,
  formato: Formato,
  brandProfile?: BrandProfile,
): Record<string, string> {
  const platformStyles: Record<Platform, string> = {
    tiktok: "Dinamico, colori vivaci, testo sovrapposto grande, transizioni rapide",
    instagram: "Estetica curata, palette coerente, layout pulito, tipografia elegante",
    facebook: "Chiaro e leggibile, immagini realistiche, design accessibile",
    linkedin: "Professionale, corporate, infografica, toni sobri e autorevoli",
  };

  const style = platformStyles[platform] ?? "Stile visivo coerente con la piattaforma";
  const mood = brandProfile?.toneNotes ?? "Positivo e coinvolgente";
  const subject = mediaSuggestion ?? `Visual per "${content.slice(0, 60)}..."`;

  return {
    visualConcept: `Immagine/video per ${platform} in formato ${formato}. ${subject}`,
    style,
    subject: content.slice(0, 120),
    colors: brandProfile?.sector === "tech" ? "Blu, bianco, accenti vivaci" : "Palette calda e invitante",
    mood,
    composition: formato === "reel" ? "Verticale 9:16, soggetto centrato, testo in area safe" : "Quadrato o 4:5, regola dei terzi",
    safeRenderPrompt: `A professional ${formato === "reel" ? "vertical video thumbnail" : "social media image"} for ${platform}, ${style.toLowerCase()}, mood: ${mood.toLowerCase()}, subject: ${subject.slice(0, 100)}`,
  };
}
