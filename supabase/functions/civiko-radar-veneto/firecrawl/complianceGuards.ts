// ═══════════════════════════════════════════════════════════════
// Compliance guards — blocca dati personali, demo/mock/seed,
// pagine login/paywall/captcha, contenuti fuori scope.
// ═══════════════════════════════════════════════════════════════
const DEMO = ["seed_demo","seed-","demo","mock","fixture","sample","stub","fake","test_"];
const PERSONAL_HINTS = [
  /\b\d{3}[\s.-]?\d{6,8}\b/,                    // tel
  /\b[\w.-]+@[\w.-]+\.[a-z]{2,}\b/i,            // email
  /\b[A-Z]{6}\d{2}[A-EHLMPRT]\d{2}[A-Z]\d{3}[A-Z]\b/, // CF
];
const FORBIDDEN_PAGE_HINTS = [
  "login","accedi","sign in","captcha","abbonati","paywall","registrati per continuare",
];

export function isDemoText(...vals: unknown[]): boolean {
  return vals.some((v) => v != null && DEMO.some((m) => String(v).toLowerCase().includes(m)));
}

export function isForbiddenPage(markdown: string | null | undefined): boolean {
  if (!markdown) return false;
  const m = markdown.toLowerCase();
  return FORBIDDEN_PAGE_HINTS.some((h) => m.includes(h));
}

export function stripPersonalData(text: string | null | undefined): string {
  if (!text) return "";
  let out = text;
  for (const re of PERSONAL_HINTS) out = out.replace(re, "[redacted]");
  return out;
}

export function isVenetoProvince(prov: string | null | undefined): boolean {
  if (!prov) return false;
  return ["VE","VR","VI","PD","TV","BL","RO"].includes(String(prov).toUpperCase());
}
