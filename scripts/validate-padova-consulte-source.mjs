#!/usr/bin/env node
// Validator for the Padova Consulte GeoJSON snapshot.
// Fails hard (exit 1) if any structural, semantic, or geographic invariant is violated.
// Does not touch the network, database, or any runtime code.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const GEOJSON_PATH = join(ROOT, "supabase/data/padova-consulte-2026-07-20.geojson");
const MANIFEST_PATH = join(ROOT, "supabase/data/padova-consulte-2026-07-20.manifest.json");

const EXPECTED_CONSULTE = ["1 Centro", "2 Nord", "3A", "3B", "4A", "4B", "5A", "5B", "6A", "6B"];
const EXPECTED_ZONA = {
  "1 Centro": "CENTRO",
  "2 Nord": "ARCELLA - SAN BELLINO - SAN CARLO - PONTEVIGODARZERE",
  "3A": "STANGA - SAN LAZZARO - MORTISE - TORRE - PONTE DI BRENTA",
  "3B": "FORCELLINI - TERRANEGRA - CAMIN - GRANZE",
  "4A": "CITTA' GIARDINO - S. OSVALDO - S. RITA - MADONNA PELLEGRINA - SANTA CROCE - SAN PAOLO",
  "4B": "VOLTABAROZZO - CROCEFISSO - SALBORO - GUIZZA",
  "5A": "MANDRIA - ARMISTIZIO - VOLTABRUSEGANA",
  "5B": "SACRA FAMIGLIA - PALESTRO - PORTA TRENTO",
  "6A": "BRUSEGANA - CAVE - CHIESANUOVA",
  "6B": "SANT'IGNAZIO - MONTA' - SACRO CUORE - ALTICHIERO - PONTEROTTO",
};
const ALLOWED_PROPERTIES = new Set(["OBJECTID", "CONSULTE_2018", "ZONA"]);

// Normalizzazione richiesta:
// - "1 Centro" -> "1"
// - "2 Nord"   -> "2"
// - altri invariati
function normalizeConsulta(v) {
  if (v === "1 Centro") return "1";
  if (v === "2 Nord") return "2";
  return v;
}
const ACCEPTED_CODES = new Set(["1", "2", "3A", "3B", "4A", "4B", "5A", "5B", "6A", "6B"]);

// 8 slug ufficiali derivati dal contratto applicativo.
const CONSULTA_TO_ZONE = new Map([
  ["1", "centro-storico"],
  ["2", "nord-arcella"],
  ["3A", "est-brenta"],
  ["3B", "nord-est"],
  ["4A", "sud-est-sant-osvaldo"],
  ["4B", "sud-voltabarozzo-guizza"],
  ["5A", "sud-ovest-mandria"],
  ["5B", "ovest-chiesanuova-brentelle"],
  ["6A", "ovest-chiesanuova-brentelle"],
  ["6B", "ovest-chiesanuova-brentelle"],
]);
const EXPECTED_ZONE_SLUGS = new Set([
  "centro-storico",
  "nord-arcella",
  "est-brenta",
  "nord-est",
  "sud-est-sant-osvaldo",
  "sud-voltabarozzo-guizza",
  "sud-ovest-mandria",
  "ovest-chiesanuova-brentelle",
]);

const LAT_MIN = 45.30, LAT_MAX = 45.50;
const LON_MIN = 11.75, LON_MAX = 12.05;

const errors = [];
function fail(msg) { errors.push(msg); }

function normalizeZona(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

function validateRing(ring, ctx) {
  if (!Array.isArray(ring) || ring.length < 4) {
    fail(`${ctx}: anello con meno di 4 vertici`);
    return;
  }
  for (const pt of ring) {
    if (!Array.isArray(pt) || pt.length < 2) { fail(`${ctx}: vertice non valido`); return; }
    const [lon, lat] = pt;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) { fail(`${ctx}: coordinata non finita`); return; }
    if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX) {
      fail(`${ctx}: coordinata fuori bbox Padova [${lon}, ${lat}]`);
      return;
    }
  }
  const first = ring[0], last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    fail(`${ctx}: anello non chiuso`);
  }
}

function validateGeometry(geom, ctx) {
  if (!geom || typeof geom !== "object") { fail(`${ctx}: geometria mancante`); return; }
  if (geom.type === "Polygon") {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
      fail(`${ctx}: Polygon senza anelli`); return;
    }
    geom.coordinates.forEach((ring, i) => validateRing(ring, `${ctx}/polygon[${i}]`));
  } else if (geom.type === "MultiPolygon") {
    if (!Array.isArray(geom.coordinates) || geom.coordinates.length === 0) {
      fail(`${ctx}: MultiPolygon vuoto`); return;
    }
    geom.coordinates.forEach((poly, i) => {
      if (!Array.isArray(poly) || poly.length === 0) { fail(`${ctx}: sub-polygon vuoto`); return; }
      poly.forEach((ring, j) => validateRing(ring, `${ctx}/multi[${i}][${j}]`));
    });
  } else {
    fail(`${ctx}: geometria non Polygon/MultiPolygon (${geom && geom.type})`);
  }
}

const raw = readFileSync(GEOJSON_PATH);
const sha = createHash("sha256").update(raw).digest("hex");
const data = JSON.parse(raw.toString("utf8"));

if (data.type !== "FeatureCollection") fail("root.type != FeatureCollection");
if (!Array.isArray(data.features) || data.features.length !== 10) {
  fail(`features count != 10 (got ${data.features && data.features.length})`);
}

const seenConsulte = new Set();
const seenObjectIds = new Set();
for (const f of data.features || []) {
  const p = f.properties || {};
  const ctx = `feature CONSULTE_2018=${p.CONSULTE_2018}`;
  for (const k of Object.keys(p)) {
    if (!ALLOWED_PROPERTIES.has(k)) fail(`${ctx}: proprietà inattesa "${k}"`);
  }
  if (typeof p.OBJECTID !== "number") fail(`${ctx}: OBJECTID mancante o non numerico`);
  else if (seenObjectIds.has(p.OBJECTID)) fail(`${ctx}: OBJECTID duplicato ${p.OBJECTID}`);
  else seenObjectIds.add(p.OBJECTID);

  const c = p.CONSULTE_2018;
  if (typeof c !== "string" || !EXPECTED_CONSULTE.includes(c)) {
    fail(`${ctx}: CONSULTE_2018 non atteso`);
  } else if (seenConsulte.has(c)) {
    fail(`${ctx}: CONSULTE_2018 duplicato`);
  } else {
    seenConsulte.add(c);
  }

  if (typeof p.ZONA !== "string" || p.ZONA.trim().length === 0) {
    fail(`${ctx}: ZONA vuoto`);
  } else if (EXPECTED_ZONA[c] && normalizeZona(p.ZONA) !== EXPECTED_ZONA[c]) {
    fail(`${ctx}: ZONA non coerente (atteso "${EXPECTED_ZONA[c]}", trovato "${normalizeZona(p.ZONA)}")`);
  }

  validateGeometry(f.geometry, ctx);
}

for (const expected of EXPECTED_CONSULTE) {
  if (!seenConsulte.has(expected)) fail(`Consulta mancante: ${expected}`);
}

// Normalizzazione e mapping verso gli 8 slug ufficiali.
const normalizedCodes = [...seenConsulte].map(normalizeConsulta);
for (const code of normalizedCodes) {
  if (!ACCEPTED_CODES.has(code)) fail(`Codice normalizzato non accettato: ${code}`);
}
const producedSlugs = new Set(normalizedCodes.map((c) => CONSULTA_TO_ZONE.get(c)));
if (producedSlugs.size !== 8) fail(`Il raggruppamento produce ${producedSlugs.size} zone, atteso 8`);
for (const s of producedSlugs) {
  if (!EXPECTED_ZONE_SLUGS.has(s)) fail(`Slug prodotto non ufficiale: ${s}`);
}
for (const s of EXPECTED_ZONE_SLUGS) {
  if (!producedSlugs.has(s)) fail(`Slug ufficiale non coperto: ${s}`);
}

// Manifest cross-check.
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
if (manifest.sha256 !== sha) fail(`Manifest sha256 mismatch: manifest=${manifest.sha256} file=${sha}`);
if (manifest.file_bytes !== raw.length) fail(`Manifest file_bytes mismatch: manifest=${manifest.file_bytes} file=${raw.length}`);
if (manifest.feature_count !== 10) fail(`Manifest feature_count != 10`);
if (manifest.source_spatial_reference !== 4326) fail(`Manifest spatial reference != 4326`);

if (errors.length) {
  console.error(`[validate-padova-consulte-source] FAIL (${errors.length} errori):`);
  for (const e of errors) console.error(" -", e);
  process.exit(1);
}

console.log(`[validate-padova-consulte-source] OK`);
console.log(`  file:     ${GEOJSON_PATH}`);
console.log(`  bytes:    ${raw.length}`);
console.log(`  sha256:   ${sha}`);
console.log(`  features: ${data.features.length}`);
console.log(`  consulte: ${EXPECTED_CONSULTE.join(", ")}`);
console.log(`  zone(8):  ${[...producedSlugs].sort().join(", ")}`);
