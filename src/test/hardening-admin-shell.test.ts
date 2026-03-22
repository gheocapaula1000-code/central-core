/**
 * Admin Shell Hardening Tests — Central Core V3
 *
 * Validates index.html security meta, noindex compliance,
 * deploy headers artifact, and admin route registration.
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
