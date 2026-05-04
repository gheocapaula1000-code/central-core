// ═══════════════════════════════════════════════════════════════
// dedupe — hash markdown + dedup URL set.
// ═══════════════════════════════════════════════════════════════
export async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2,"0")).join("");
}

export class UrlDedupe {
  private seen = new Set<string>();
  add(url: string): boolean {
    const u = normalize(url);
    if (this.seen.has(u)) return false;
    this.seen.add(u);
    return true;
  }
  size() { return this.seen.size; }
}

function normalize(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.toString().toLowerCase();
  } catch { return u.toLowerCase(); }
}
