// ── OMI Name & Code Normalizer ──
// Handles bilingual names (BZ/TN), apostrophe variants, ISTAT code formats.
// Used by loadLinkLookup to generate all resolvable key variants.

/**
 * Normalize a comune name for lookup matching.
 * Returns an array of canonical variants to try.
 * 
 * Examples:
 *   "ALDINO .ALDEIN."     → ["ALDINO .ALDEIN.", "ALDINO", "ALDEIN"]
 *   "SANT`ALESSANDRO"     → ["SANT`ALESSANDRO", "SANT'ALESSANDRO", "SANTALESSANDRO"]
 *   "PRE` SAINT DIDIER"   → ["PRE` SAINT DIDIER", "PRE' SAINT DIDIER", "PRE SAINT DIDIER"]
 *   "FIE` ALLO SCILIAR .VOLS AM SCHLERN" → ["FIE` ALLO SCILIAR .VOLS AM SCHLERN", "FIE' ALLO SCILIAR", "FIE ALLO SCILIAR", "VOLS AM SCHLERN"]
 */
export function comuneNameVariants(name: string): string[] {
  const upper = name.toUpperCase().trim();
  const variants = new Set<string>();
  variants.add(upper);

  // 1. Split bilingual names: "ITALIANO .TEDESCO." or "ITALIANO .TEDESCO LUNGO."
  //    The German name is in dots: .ALDEIN. or .EPPAN AN DER WEINST
  const bilingualMatch = upper.match(/^(.+?)\s+\.(.+?)\.?\s*$/);
  if (bilingualMatch) {
    const italian = bilingualMatch[1].trim();
    const german = bilingualMatch[2].trim();
    variants.add(italian);
    variants.add(german);
    // Also add apostrophe-normalized versions of both
    for (const part of [italian, german]) {
      if (part.includes("`")) {
        variants.add(part.replace(/`/g, "'"));
        variants.add(part.replace(/`/g, ""));
      }
    }
  }

  // 2. Apostrophe normalization: backtick ` → apostrophe ' and removed
  if (upper.includes("`")) {
    variants.add(upper.replace(/`/g, "'"));
    variants.add(upper.replace(/`/g, ""));
    // Also handle the Italian part only (before any dot section)
    const beforeDot = upper.split(/\s+\./)[0].trim();
    if (beforeDot !== upper) {
      variants.add(beforeDot.replace(/`/g, "'"));
      variants.add(beforeDot.replace(/`/g, ""));
    }
  }

  // 3. Handle apostrophe ' → backtick and removed (reverse direction for KML input)
  if (upper.includes("'")) {
    variants.add(upper.replace(/'/g, "`"));
    variants.add(upper.replace(/'/g, ""));
  }

  return [...variants];
}

/**
 * Generate ISTAT code variants for lookup matching.
 * 
 * OMI zone table uses formats like:
 *   "4021001" (7-digit: region + province + comune)
 *   "3016003" (7-digit)
 * 
 * KML/GeoJSON files may use:
 *   "021001" (6-digit: province + comune)
 *   "21001"  (5-digit: trimmed leading zeros)
 *   "016003" (6-digit)
 *
 * Returns all plausible format variants.
 */
export function istatCodeVariants(code: string): string[] {
  const trimmed = code.replace(/^0+/, "");
  const variants = new Set<string>();
  variants.add(code);
  variants.add(trimmed);

  // If 7-digit, also produce 6-digit (strip region prefix)
  if (code.length === 7) {
    const sixDigit = code.slice(1); // e.g., "4021001" → "021001"
    variants.add(sixDigit);
    variants.add(sixDigit.replace(/^0+/, "")); // "021001" → "21001"
  }

  // If 6-digit, also produce 5-digit (strip leading zero)
  if (code.length === 6 && code.startsWith("0")) {
    variants.add(code.slice(1));
  }

  // Pad to 6 digits (some KML files use zero-padded 6-digit)
  if (trimmed.length < 6) {
    variants.add(trimmed.padStart(6, "0"));
  }

  return [...variants];
}

/**
 * Normalize an incoming KML/GeoJSON comune name for matching against the lookup.
 * Applied to the `comuneFromName` extracted from KML `<name>` fields.
 * 
 * Returns multiple variants to try against the lookup map.
 */
export function normalizeIncomingName(name: string): string[] {
  const upper = name.toUpperCase().trim();
  const variants = new Set<string>();
  variants.add(upper);

  // Apostrophe variants
  if (upper.includes("'")) {
    variants.add(upper.replace(/'/g, "`"));
    variants.add(upper.replace(/'/g, ""));
  }
  if (upper.includes("`")) {
    variants.add(upper.replace(/`/g, "'"));
    variants.add(upper.replace(/`/g, ""));
  }

  // Remove diacritics approximation (common in KML exports)
  const noDiacritics = upper
    .replace(/[ÀÁÂÃÄÅàáâãäå]/g, "A")
    .replace(/[ÈÉÊËèéêë]/g, "E")
    .replace(/[ÌÍÎÏìíîï]/g, "I")
    .replace(/[ÒÓÔÕÖòóôõö]/g, "O")
    .replace(/[ÙÚÛÜùúûü]/g, "U");
  if (noDiacritics !== upper) variants.add(noDiacritics);

  return [...variants];
}
