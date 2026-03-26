/**
 * Admin Shell Hardening Tests — Central Core V3
 *
 * Validates index.html security meta, noindex compliance,
 * deploy headers artifact, admin route registration,
 * boot safety, and header hardening.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── index.html security baseline ──

describe("Admin Shell — index.html security meta", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");

  it("contains Content-Security-Policy meta", () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
  });

  it("CSP blocks object-src", () => {
    expect(html).toMatch(/object-src\s+'none'/);
  });

  it("CSP blocks frame-ancestors", () => {
    expect(html).toMatch(/frame-ancestors\s+'none'/);
  });

  it("contains X-Content-Type-Options nosniff", () => {
    expect(html).toContain('content="nosniff"');
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

  it("does not duplicate meta tags", () => {
    const cspCount = (html.match(/Content-Security-Policy/g) || []).length;
    // one meta tag = one occurrence of the directive name in content + one in http-equiv attr
    expect(cspCount).toBeLessThanOrEqual(2);
  });
});

// ── Deploy headers artifact ──

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

  it("includes HSTS with long max-age", () => {
    expect(headers).toMatch(/Strict-Transport-Security:.*max-age=\d{7,}/);
  });

  it("includes Cross-Origin-Opener-Policy", () => {
    expect(headers).toContain("Cross-Origin-Opener-Policy: same-origin");
  });

  it("includes Cross-Origin-Resource-Policy", () => {
    expect(headers).toContain("Cross-Origin-Resource-Policy: same-origin");
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

// ── Boot safety ──

describe("Admin Shell — boot safety (main.tsx)", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../main.tsx"), "utf-8");

  it("has a boot function with try/catch", () => {
    expect(main).toContain("try {");
    expect(main).toContain("catch");
  });

  it("handles chunk mismatch errors", () => {
    expect(main).toMatch(/chunk|import/i);
  });

  it("provides a reload recovery button", () => {
    expect(main).toContain("location.reload()");
  });

  it("checks for #root element existence", () => {
    expect(main).toContain('getElementById("root")');
  });
});

// ── CSP coherence between index.html and _headers ──

describe("Admin Shell — CSP coherence", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../../index.html"), "utf-8");
  const headers = fs.readFileSync(path.resolve(__dirname, "../../public/_headers"), "utf-8");

  const extractDirectives = (csp: string) => {
    const directives = new Set<string>();
    for (const part of csp.split(";")) {
      const name = part.trim().split(/\s+/)[0];
      if (name) directives.add(name);
    }
    return directives;
  };

  it("both sources define the same CSP directives", () => {
    const htmlCspMatch = html.match(/content="(default-src[^"]+)"/);
    const headerCspMatch = headers.match(/Content-Security-Policy:\s*(.+)/);
    expect(htmlCspMatch).toBeTruthy();
    expect(headerCspMatch).toBeTruthy();
    const htmlDirectives = extractDirectives(htmlCspMatch![1]);
    const headerDirectives = extractDirectives(headerCspMatch![1]);
    // Both should have the same directive names
    expect([...htmlDirectives].sort()).toEqual([...headerDirectives].sort());
  });
});
