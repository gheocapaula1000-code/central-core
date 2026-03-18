// ═══════════════════════════════════════════════════════════════
// Viral Core — Deterministic Policy Engine
// No external calls. Pure logic.
// ═══════════════════════════════════════════════════════════════

import type { Platform, PolicyResult, HistoryHints, RiskLevel, PublishMode } from "./types.ts";

// ── Similarity check (Jaccard on word sets) ──
function wordSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\sàèéìòù]/g, "").split(/\s+/).filter(w => w.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

// ── Extract hashtags ──
function extractHashtags(text: string): string[] {
  return (text.match(/#\w+/g) ?? []).map(h => h.toLowerCase());
}

// ── CTA patterns ──
const CTA_PATTERNS = [
  /scopri di più/i, /clicca qui/i, /link in bio/i, /compra ora/i,
  /iscriviti/i, /seguici/i, /contattaci/i, /prenota/i,
  /acquista/i, /visita/i, /approfitta/i, /offerta/i,
];

function countCTAs(text: string): number {
  return CTA_PATTERNS.filter(p => p.test(text)).length;
}

export function runPolicyCheck(
  contents: Partial<Record<Platform, string>>,
  historyHints?: HistoryHints,
  scheduleHints?: { sameDayCrossPost?: boolean },
): PolicyResult {
  const flags: string[] = [];
  const notes: string[] = [];
  const platforms = Object.keys(contents).filter(k => contents[k as Platform]) as Platform[];
  const texts = platforms.map(p => contents[p]!);

  // 1. Cross-platform similarity
  if (texts.length >= 2) {
    const wordSets = texts.map(wordSet);
    for (let i = 0; i < wordSets.length; i++) {
      for (let j = i + 1; j < wordSets.length; j++) {
        const sim = jaccard(wordSets[i], wordSets[j]);
        if (sim > 0.85) {
          flags.push("cross_platform_copy_too_similar");
          notes.push(`${platforms[i]}/${platforms[j]} similarity: ${(sim * 100).toFixed(0)}%`);
        }
      }
    }
  }

  // 2. Hashtag repetition
  const allHashtags = texts.flatMap(extractHashtags);
  const hashCounts = new Map<string, number>();
  for (const h of allHashtags) hashCounts.set(h, (hashCounts.get(h) ?? 0) + 1);
  const repeated = [...hashCounts.entries()].filter(([, c]) => c > 2);
  if (repeated.length > 0) {
    flags.push("hashtags_too_repetitive");
    notes.push(`Repeated hashtags: ${repeated.map(([h]) => h).join(", ")}`);
  }

  // 3. History hashtag overlap
  if (historyHints?.recentHashtags?.length) {
    const recent = new Set(historyHints.recentHashtags.map(h => h.toLowerCase()));
    const overlap = allHashtags.filter(h => recent.has(h));
    if (overlap.length >= 3) {
      flags.push("hashtags_stale_from_history");
      notes.push(`${overlap.length} hashtags overlap with recent history`);
    }
  }

  // 4. History topic fingerprint overlap
  if (historyHints?.recentFingerprints?.length) {
    const recentFP = historyHints.recentFingerprints.map(f => wordSet(f));
    for (const text of texts) {
      const ws = wordSet(text);
      for (const fp of recentFP) {
        if (jaccard(ws, fp) > 0.7) {
          flags.push("topic_too_similar_to_recent");
          notes.push("Content too similar to a recently published piece");
          break;
        }
      }
    }
  }

  // 5. CTA overuse
  const totalCTAs = texts.reduce((sum, t) => sum + countCTAs(t), 0);
  if (totalCTAs > platforms.length * 2) {
    flags.push("cta_overused");
    notes.push(`${totalCTAs} CTA patterns detected across ${platforms.length} platforms`);
  }

  // 6. Same-day cross-post warning
  if (scheduleHints?.sameDayCrossPost && platforms.length >= 3) {
    flags.push("same_day_cross_post_risk");
    notes.push("Posting identical content on 3+ platforms same day increases detection risk");
  }

  // ── Derive risk level ──
  const uniqueFlags = [...new Set(flags)];
  let riskLevel: RiskLevel = "low";
  if (uniqueFlags.length >= 3) riskLevel = "high";
  else if (uniqueFlags.length >= 1) riskLevel = "medium";

  // ── Derive publish recommendation ──
  let publishModeRecommendation: PublishMode = "eligible_manual_publish";
  if (riskLevel === "high") publishModeRecommendation = "draft_only";
  else if (riskLevel === "medium") publishModeRecommendation = "manual_review";

  return {
    riskLevel,
    publishModeRecommendation,
    riskFlags: uniqueFlags,
    notes: [...new Set(notes)],
  };
}

/** Generate normalized suggestions when risk is medium/high */
export function buildNormalizedSuggestions(
  contents: Partial<Record<Platform, string>>,
): Partial<Record<Platform, string>> {
  const result: Partial<Record<Platform, string>> = {};
  for (const [p, text] of Object.entries(contents)) {
    if (!text) continue;
    result[p as Platform] = `Rivedi il contenuto per ${p}: varia hashtag, differenzia il tono e personalizza la CTA per la piattaforma.`;
  }
  return result;
}
