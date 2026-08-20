// Copia pura di isOriginAllowed per test lato client
const LOVABLE_SUFFIXES = [".lovable.app", ".lovableproject.com", ".lovable.dev"];
const TRUSTED_APP_HOSTS = new Set(["keydraft.app", "www.keydraft.app", "wyloni.app", "www.wyloni.app", "wyloni.com", "www.wyloni.com", "sottra.app", "www.sottra.app", "civikoone.com", "www.civikoone.com", "ueradar.com", "www.ueradar.com"]);

export function isOriginAllowed(origin: string, allowedOrigins: string[] = []): boolean {
  if (!origin) return false;
  const o = origin.toLowerCase().trim();
  try {
    const u = new URL(o);
    if (u.hostname === "localhost" || u.hostname.startsWith("127.")) return true;
    if (TRUSTED_APP_HOSTS.has(u.hostname)) return true;
  } catch { /* URL non valida */ }
  if (LOVABLE_SUFFIXES.some((s) => o.endsWith(s))) return true;
  if (allowedOrigins.includes("*")) return true;
  return allowedOrigins.some((entry) => entry.toLowerCase().trim() === o);
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
