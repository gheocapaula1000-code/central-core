// ═══════════════════════════════════════════════════════════════
// Property Detail — Opaque ID Registry
// Server-generated opaque tokens mapped to internal coordinates.
// The opaque token is NOT derivable from coordinates.
// ═══════════════════════════════════════════════════════════════

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import type { InternalCoordinates } from "./types.ts";

const COORDINATE_SCALE = 100000; // 5 decimals ≈ ~1m

// Crockford-base32 alphabet (no I, L, O, U) — opaque, URL-safe, case-insensitive.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function generateOpaqueToken(): string {
  // 80 bits of entropy → 16 chars in base32.
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let out = "";
  let bits = 0;
  let buffer = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out.slice(0, 16);
}

export const OPAQUE_TOKEN_PATTERN = /^[0-9a-z]{16}$/;

export interface PropertyIdRegistry {
  getOrCreateOpaqueId(coords: InternalCoordinates): Promise<string>;
  resolveOpaqueId(opaqueId: string): Promise<InternalCoordinates | null>;
}

let cachedClient: SupabaseClient | null = null;

function getServiceClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

export function createSupabasePropertyIdRegistry(
  client: SupabaseClient = getServiceClient(),
): PropertyIdRegistry {
  return {
    async getOrCreateOpaqueId(coords) {
      const latScaled = Math.round(coords.lat * COORDINATE_SCALE);
      const lngScaled = Math.round(coords.lng * COORDINATE_SCALE);
      const candidate = generateOpaqueToken();
      const { data, error } = await client.rpc("property_registry_upsert", {
        p_opaque_id: candidate,
        p_lat_scaled: latScaled,
        p_lng_scaled: lngScaled,
      });
      if (error) throw new Error(`property_registry_upsert failed: ${error.message}`);
      return (data as string) ?? candidate;
    },

    async resolveOpaqueId(opaqueId) {
      if (!OPAQUE_TOKEN_PATTERN.test(opaqueId)) return null;
      const { data, error } = await client.rpc("property_registry_lookup", {
        p_opaque_id: opaqueId,
      });
      if (error) throw new Error(`property_registry_lookup failed: ${error.message}`);
      const row = Array.isArray(data) ? data[0] : null;
      if (!row) return null;
      return {
        lat: (row.lat_scaled as number) / COORDINATE_SCALE,
        lng: (row.lng_scaled as number) / COORDINATE_SCALE,
      };
    },
  };
}

// In-memory registry for tests — same contract, no DB.
export function createInMemoryPropertyIdRegistry(): PropertyIdRegistry {
  const byCoords = new Map<string, string>();
  const byOpaque = new Map<string, InternalCoordinates>();
  return {
    async getOrCreateOpaqueId(coords) {
      const latScaled = Math.round(coords.lat * COORDINATE_SCALE);
      const lngScaled = Math.round(coords.lng * COORDINATE_SCALE);
      const key = `${latScaled}:${lngScaled}`;
      const existing = byCoords.get(key);
      if (existing) return existing;
      const token = generateOpaqueToken();
      byCoords.set(key, token);
      byOpaque.set(token, {
        lat: latScaled / COORDINATE_SCALE,
        lng: lngScaled / COORDINATE_SCALE,
      });
      return token;
    },
    async resolveOpaqueId(opaqueId) {
      if (!OPAQUE_TOKEN_PATTERN.test(opaqueId)) return null;
      return byOpaque.get(opaqueId) ?? null;
    },
  };
}
