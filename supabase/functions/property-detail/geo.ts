// ═══════════════════════════════════════════════════════════════
// Property Detail — Geospatial utilities
// Honest, dependency-free helpers for short-range area queries.
// All distances in meters. Coordinates in WGS84 (lat/lng degrees).
// ═══════════════════════════════════════════════════════════════

import type { SpatialScope, StandardRadius } from "./types.ts";
import { STANDARD_RADII } from "./types.ts";

const EARTH_RADIUS_M = 6371008.8;

/**
 * Great-circle distance in meters (Haversine).
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Smallest standard radius that fully contains the given distance.
 * Returns null if distance > max standard radius (out of micro-area scope).
 */
export function smallestContainingRadius(
  distanceMeters: number,
): StandardRadius | null {
  for (const r of STANDARD_RADII) {
    if (distanceMeters <= r) return r;
  }
  return null;
}

/**
 * Map a standard radius to its spatialScope label.
 */
export function radiusToSpatialScope(radius: StandardRadius): SpatialScope {
  switch (radius) {
    case 50: return "buffer_50m";
    case 100: return "buffer_100m";
    case 250: return "buffer_250m";
    case 500: return "buffer_500m";
  }
}

/**
 * Approximate degrees-per-meter at a given latitude — useful for cheap
 * bounding-box prefilters before computing exact Haversine distance.
 */
export function degreesPerMeter(lat: number): { dLat: number; dLng: number } {
  const dLat = 1 / 111_320;
  const dLng = 1 / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { dLat, dLng };
}

/**
 * Bounding box around a point for a given radius in meters.
 */
export function boundingBox(
  center: { lat: number; lng: number },
  radiusMeters: number,
): { latMin: number; latMax: number; lngMin: number; lngMax: number } {
  const { dLat, dLng } = degreesPerMeter(center.lat);
  return {
    latMin: center.lat - radiusMeters * dLat,
    latMax: center.lat + radiusMeters * dLat,
    lngMin: center.lng - radiusMeters * dLng,
    lngMax: center.lng + radiusMeters * dLng,
  };
}
