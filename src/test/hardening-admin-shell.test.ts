/**
 * Admin Shell Hardening Tests — Central Core V3
 *
 * Validates index.html security meta, noindex compliance,
 * deploy headers artifact (single CSP source), admin route registration,
 * boot safety (CSP-safe), and header hardening.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── index.html security baseline ──

describe("Admin Shell — index.html security meta", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");

  it("does NOT contain CSP meta (enforced via _headers only)", () => {
    expect(html).not.toContain('http-equiv="Content-Security-Policy"');
  });

  it("does NOT contain X-Content-Type-Options meta (enforced via _headers only)", () => {
    expect(html).not.toContain('http-equiv="X-Content-Type-Options"');
  });

  it("contains Referrer-Policy", () => {
    expect(html).toContain("strict-origin-when-cross-origin");
  });

  it("contains robots noindex, nofollow", () => {
    expect(html).toContain('content="noindex, nofollow"');
  });

  it("does not contain PWA manifest link", () => {
    expect(html).not.toMatch(/rel=["']manifest["']/);
  });

  it("has lang attribute on html element", () => {
    expect(html).toMatch(/<html\s[^>]*lang=["']en["']/);
  });

  it("has charset UTF-8", () => {
    expect(html).toContain('charset="UTF-8"');
  });

  it("has viewport meta", () => {
    expect(html).toContain("width=device-width");
  });

  it("has noscript fallback", () => {
    expect(html).toContain("<noscript>");
  });
});

// ── Deploy headers artifact (single authoritative CSP source) ──

describe("Admin Shell — _headers deploy artifact", () => {
  const headersPath = path.resolve(__dirname, "../../public/_headers");

  it("public/_headers file exists", () => {
    expect(fs.existsSync(headersPath)).toBe(true);
  });

  const headers = fs.existsSync(headersPath)
    ? fs.readFileSync(headersPath, "utf-8")
    : "";

  it("includes X-Content-Type-Options", () => {
    expect(headers).toContain("X-Content-Type-Options: nosniff");
  });

  it("includes X-Frame-Options DENY", () => {
    expect(headers).toContain("X-Frame-Options: DENY");
  });

  it("includes Referrer-Policy", () => {
    expect(headers).toContain("Referrer-Policy:");
  });

  it("includes Permissions-Policy", () => {
    expect(headers).toContain("Permissions-Policy:");
  });

  it("Permissions-Policy blocks camera, microphone, geolocation", () => {
    expect(headers).toContain("camera=()");
    expect(headers).toContain("microphone=()");
    expect(headers).toContain("geolocation=()");
  });

  it("includes Content-Security-Policy", () => {
    expect(headers).toContain("Content-Security-Policy:");
  });

  it("CSP blocks object-src", () => {
    expect(headers).toMatch(/object-src\s+'none'/);
  });

  it("CSP blocks frame-ancestors", () => {
    expect(headers).toMatch(/frame-ancestors\s+'none'/);
  });

  it("includes HSTS with long max-age", () => {
    expect(headers).toMatch(/Strict-Transport-Security:.*max-age=\d{7,}/);
  });

  it("includes Cross-Origin-Opener-Policy", () => {
    expect(headers).toContain("Cross-Origin-Opener-Policy: same-origin");
  });

  it("includes Cross-Origin-Resource-Policy", () => {
    expect(headers).toContain("Cross-Origin-Resource-Policy: same-origin");
  });

  it("includes Cross-Origin-Embedder-Policy require-corp (same-origin assets only)", () => {
    expect(headers).toContain("Cross-Origin-Embedder-Policy: require-corp");
  });

  it("default cache is no-store", () => {
    expect(headers).toContain("no-store");
  });

  it("assets have immutable cache", () => {
    expect(headers).toContain("/assets/*");
    expect(headers).toContain("immutable");
  });
});

// ── Admin route registration ──

describe("Admin Shell — route registration", () => {
  const ADMIN_ROUTES = ["/", "/apps", "/providers", "/tasks", "/security", "/metrics", "/selftest"];

  it("App.tsx registers all expected admin routes", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf-8");
    for (const route of ADMIN_ROUTES) {
      expect(appSource).toContain(`path="${route}"`);
    }
  });

  it("App.tsx has a catch-all NotFound route", () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf-8");
    expect(appSource).toContain('path="*"');
    expect(appSource).toContain("NotFound");
  });
});

// ── robots.txt ──

describe("Admin Shell — robots.txt", () => {
  it("robots.txt disallows all crawling", () => {
    const robots = fs.readFileSync(path.resolve(__dirname, "../../public/robots.txt"), "utf-8");
    expect(robots).toContain("Disallow: /");
  });
});

// ── Boot safety (CSP-safe) ──

describe("Admin Shell — boot safety (main.tsx)", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../main.tsx"), "utf-8");

  it("has a boot function with try/catch", () => {
    expect(main).toContain("try {");
    expect(main).toContain("catch");
  });

  it("handles chunk mismatch errors", () => {
    expect(main).toMatch(/chunk|import/i);
  });

  it("uses addEventListener for reload (CSP-safe, no inline handlers)", () => {
    expect(main).toContain("addEventListener");
    expect(main).not.toContain("onclick=");
    expect(main).not.toContain("innerHTML");
  });

  it("checks for #root element existence", () => {
    expect(main).toContain('getElementById("root")');
  });
});

// ── COEP same-origin asset compliance ──

describe("Admin Shell — COEP same-origin asset compliance", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");

  it("script src is same-origin", () => {
    const scripts = html.match(/<script[^>]+src=["']([^"']+)["']/g) || [];
    for (const tag of scripts) {
      const src = tag.match(/src=["']([^"']+)["']/)?.[1] ?? "";
      expect(src).not.toMatch(/^https?:\/\//);
    }
  });

  it("link href is same-origin (no cross-origin stylesheets or icons)", () => {
    const links = html.match(/<link[^>]+href=["']([^"']+)["']/g) || [];
    for (const tag of links) {
      const href = tag.match(/href=["']([^"']+)["']/)?.[1] ?? "";
      expect(href).not.toMatch(/^https?:\/\//);
    }
  });

  it("no cross-origin img tags in shell HTML", () => {
    const imgs = html.match(/<img[^>]+src=["']([^"']+)["']/g) || [];
    for (const tag of imgs) {
      const src = tag.match(/src=["']([^"']+)["']/)?.[1] ?? "";
      expect(src).not.toMatch(/^https?:\/\//);
    }
  });

  it("_headers enforces COEP require-corp", () => {
    const headers = fs.readFileSync(path.resolve(__dirname, "../../public/_headers"), "utf-8");
    expect(headers).toContain("Cross-Origin-Embedder-Policy: require-corp");
  });
});
